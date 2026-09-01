"""SAP file-upload endpoints for running the TDS rule engine.

The API deliberately does not persist an uploaded file or its results.  It
analyses the file supplied by the authenticated user and returns a UI-shaped
result for the current browser session.
"""

from __future__ import annotations

from datetime import date
import math
from io import BytesIO
from pathlib import Path
from typing import Any
from uuid import uuid4

import pandas as pd
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from pydantic import ValidationError
from sqlalchemy.orm import Session

from core.dependencies import get_current_user, get_user_company_codes
from db.database import get_db
from db.models import LDCCertificateMaster, User, VendorMaster
from ingestion.sap_translator import (
    COLUMN_ALIASES,
    build_transactions_from_sap_export,
    build_transactions_from_sap_rows,
    get_tds_section_raw,
    looks_like_descriptive_tds_section,
)
from rules.tds_rule_engine import (
    SECTION_194J_VALID_RATES,
    SECTIONS,
    TDSIssue,
    _get_applicable_rate,
    run_all_checks,
    check_threshold_breach,
    check_missing_deduction,
    check_advance_payment_lifecycle,
)
from services.tds_case_builder import build_tds_cases, classify_event


router = APIRouter(prefix="/issues", tags=["Issues"])

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
SUPPORTED_EXTENSIONS = {".csv", ".xlsx", ".xls", ".xlsm"}
NEW_ACT_EFFECTIVE_DATE = date(2026, 4, 1)

# Matches the identifiers used by the frontend's issue-type filters.
ISSUE_TYPE_BY_CATEGORY = {
    "TDS Not Applicable — Violation": "GL_EXCLUSION_VIOLATION",
    "TDS Not Applicable": "GL_EXCLUSION_CLEAN",
    "PAN Missing/Invalid — TDS Not Deducted": "PAN_MISSING_NOT_DEDUCTED",
    "PAN Missing/Invalid — Short TDS Deducted": "PAN_MISSING_SHORT",
    "PAN Missing/Invalid — Correctly Handled": "PAN_CORRECT",
    "Wrong TDS Rate": "WRONG_TDS_RATE",
    "Short TDS Deducted": "SHORT_TDS",
    "Excess TDS Deducted": "EXCESS_TDS",
    "Wrong Section Applied": "WRONG_SECTION_HSN",
    "Wrong Section Applied — Non-Resident": "WRONG_SECTION_NON_RESIDENT",
    "Wrong Section Applied — Resident": "WRONG_SECTION_RESIDENT",
    "LDC Not Yet Valid": "LDC_NOT_YET_VALID",
    "LDC Expired": "LDC_EXPIRED",
    "TDS Deducted as per LDC — Mismatch": "LDC_MISMATCH",
    "TDS Deducted as per LDC": "LDC_CORRECT",
    "LDC Limit 80% Utilized — Warning": "LDC_LIMIT_80_WARNING",
    "LDC Limit 90% Utilized — High Warning": "LDC_LIMIT_90_WARNING",
    "LDC Limit Exhausted": "LDC_LIMIT_EXHAUSTED",
    "LDC Over-utilized": "LDC_OVER_UTILIZED",
    "TDS Not Deducted — Advance Payment": "MISSED_ADVANCE",
    "Short TDS Deducted — Advance Adjusted Invoice": "ADVANCE_SHORT_TDS",
    "Excess TDS Deducted — Advance Adjusted Invoice": "ADVANCE_EXCESS_TDS",
    "TDS Not Deducted — Provision Entry": "MISSED_PROVISION",
    "Short TDS Deducted — Non-Filer (206AB)": "NON_FILER_206AB",
    "TDS Not Applicable — Violation (Form 15G/15H)": "FORM_15G_VIOLATION",
    "TDS Not Applicable — Violation (Transporter Exemption)": "TRANSPORTER_VIOLATION",
    "TDS Not Deducted — Threshold Crossed": "THRESHOLD_CROSSED",
    "Possible Missed TDS Deduction": "MISSING_DEDUCTION"
}

PAYMENT_TYPE_TO_SECTION = {
    str(section_config.get("payment_type", "")).strip().lower(): section_code
    for section_code, section_config in SECTIONS.items()
    if section_config.get("payment_type")
}


def _normalise_payment_type(value: str | None) -> str | None:
    if not value:
        return None
    return value.strip().lower().replace(" ", "_").replace("-", "_") or None


def _get_rate_for_section(section: str | None, txn) -> float | None:
    if not section:
        return None

    section_config = SECTIONS.get(section.strip().upper())
    if not section_config:
        return None

    rate_config = section_config.get("rate", {})
    if "default" in rate_config:
        return rate_config["default"]

    if "individual_huf" in rate_config and "others" in rate_config:
        return rate_config["individual_huf"] if txn.vendor_category in {"Individual", "HUF"} else rate_config["others"]

    return None


def _get_tds_base_amount(txn) -> float | None:
    if txn.basic_amount is not None:
        return txn.basic_amount

    has_tds_classification = bool(txn.tds_deducted_section and txn.tds_deducted_rate is not None)
    if has_tds_classification and txn.bill_amount and txn.bill_amount > 0:
        return txn.bill_amount

    return None


def _normalise_section(value: str | None) -> str | None:
    if not value:
        return None
    return value.strip().upper().split("/")[0].strip() or None


def _apply_ldc_master_to_transactions(transactions, db: Session) -> None:
    """
    Enrich in-memory SAP transactions with the uploaded LDC master before the
    rule engine runs. Matching is PAN-first, then company, section, date.
    """
    if not transactions:
        return

    vendor_codes = {txn.vendor_code.strip() for txn in transactions if txn.vendor_code}
    vendor_pan_by_code = {
        row.vendor_code: row.vendor_pan
        for row in db.query(VendorMaster).filter(
            VendorMaster.vendor_code.in_(vendor_codes),
            VendorMaster.is_active == True,
        ).all()
    }

    for txn in transactions:
        if (not txn.vendor_pan or not txn.vendor_pan.strip()) and txn.vendor_code in vendor_pan_by_code:
            txn.vendor_pan = vendor_pan_by_code[txn.vendor_code]

    pans = {txn.vendor_pan.strip().upper() for txn in transactions if txn.vendor_pan}
    if not pans:
        return

    certificates = db.query(LDCCertificateMaster).filter(
        LDCCertificateMaster.vendor_pan.in_(pans),
        LDCCertificateMaster.status == "ACTIVE",
        LDCCertificateMaster.is_verified == True,
    ).all()
    if not certificates:
        return

    for txn in transactions:
        pan = (txn.vendor_pan or "").strip().upper()
        company_code = (txn.company_code or "").strip()
        expected_section = PAYMENT_TYPE_TO_SECTION.get(_normalise_payment_type(txn.transaction_kind))
        txn_sections = {
            _normalise_section(expected_section),
            _normalise_section(txn.tds_applicable_section),
            _normalise_section(txn.tds_deducted_section),
            _normalise_section(txn.tds_legacy_section),
            _normalise_section(txn.tds_raw_section),
        }
        txn_sections.discard(None)

        scoped_matches = [
            cert for cert in certificates
            if cert.vendor_pan == pan
            and (not cert.company_code or cert.company_code == company_code)
        ]
        matches = [
            cert for cert in scoped_matches
            if _normalise_section(cert.applicable_tds_section) in txn_sections
            and cert.valid_from <= txn.posting_date <= cert.valid_to
        ]
        if not matches:
            continue

        cert = sorted(
            matches,
            key=lambda item: (
                0 if item.company_code else 1,
                item.valid_from,
                item.certificate_number,
            ),
        )[0]
        txn.ldc_exemption_number = cert.certificate_number
        txn.ldc_exempt_from = cert.valid_from
        txn.ldc_exempt_to = cert.valid_to
        txn.ldc_approved_rate = float(cert.approved_tds_rate)
        txn.ldc_exemption_reason = f"{cert.certificate_type} certificate from LDC master"


def _ldc_limit_status(utilization_percent: float) -> tuple[str, str]:
    if utilization_percent > 100:
        return "over_utilized", "LDC Over-utilized"
    if utilization_percent >= 100:
        return "exhausted", "LDC Limit Exhausted"
    if utilization_percent >= 90:
        return "high_warning", "LDC Limit 90% Utilized — High Warning"
    if utilization_percent >= 80:
        return "warning", "LDC Limit 80% Utilized — Warning"
    return "safe", "Within LDC Limit"


def _build_ldc_utilization(transactions) -> list[dict[str, Any]]:
    by_certificate: dict[str, dict[str, Any]] = {}

    for txn in transactions:
        if not txn.ldc_exemption_number:
            continue
        if txn.basic_amount is None:
            continue

        key = txn.ldc_exemption_number
        row = by_certificate.setdefault(key, {
            "certificateNumber": txn.ldc_exemption_number,
            "vendor": txn.vendor_name or txn.vendor_code or "Unknown vendor",
            "vendorId": txn.vendor_code or "—",
            "pan": txn.vendor_pan or "—",
            "companyCode": txn.company_code or None,
            "section": txn.tds_deducted_section or txn.tds_legacy_section or txn.tds_applicable_section or "—",
            "approvedRate": txn.ldc_approved_rate,
            "validFrom": txn.ldc_exempt_from.isoformat() if txn.ldc_exempt_from else None,
            "validTo": txn.ldc_exempt_to.isoformat() if txn.ldc_exempt_to else None,
            "limit": None,
            "used": 0.0,
            "transactions": 0,
        })
        row["used"] += float(txn.basic_amount)
        row["transactions"] += 1

    return list(by_certificate.values())


def _attach_ldc_limits(ldc_utilization: list[dict[str, Any]], db: Session) -> None:
    if not ldc_utilization:
        return

    certificate_numbers = [row["certificateNumber"] for row in ldc_utilization]
    certificates = {
        row.certificate_number: row
        for row in db.query(LDCCertificateMaster).filter(
            LDCCertificateMaster.certificate_number.in_(certificate_numbers),
        ).all()
    }

    for row in ldc_utilization:
        cert = certificates.get(row["certificateNumber"])
        limit = float(cert.approved_amount_limit) if cert and cert.approved_amount_limit is not None else None
        row["limit"] = limit
        row["available"] = None if limit is None else limit - row["used"]
        row["utilization"] = None if not limit else round((row["used"] / limit) * 100, 2)
        row["status"], row["statusLabel"] = _ldc_limit_status(row["utilization"] or 0)


def _check_ldc_limit_breach(transactions, ldc_utilization: list[dict[str, Any]]) -> list[tuple[Any, TDSIssue]]:
    status_by_certificate = {
        row["certificateNumber"]: row
        for row in ldc_utilization
        if row.get("status") in {"warning", "high_warning", "exhausted", "over_utilized"}
    }
    first_txn_by_certificate = {}
    for txn in transactions:
        if txn.ldc_exemption_number and txn.ldc_exemption_number not in first_txn_by_certificate:
            first_txn_by_certificate[txn.ldc_exemption_number] = txn

    results = []
    for certificate_number, row in status_by_certificate.items():
        txn = first_txn_by_certificate.get(certificate_number)
        if txn is None:
            continue
        category = row["statusLabel"]
        severity = "high" if row["status"] in {"exhausted", "over_utilized", "high_warning"} else "medium"
        results.append((
            txn,
            TDSIssue(
                category=category,
                message=(
                    f"LDC certificate {certificate_number} has used "
                    f"₹{row['used']:,.2f} against a limit of ₹{row['limit']:,.2f} "
                    f"({row['utilization']:.2f}% utilized)."
                ),
                severity=severity,
                expected_rate=txn.ldc_approved_rate,
            ),
        ))
    return results




def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if isinstance(value, tuple):
        return [_json_safe(item) for item in value]
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if pd.isna(value) if not isinstance(value, (dict, list, tuple, str, bytes)) else False:
        return None
    return value

def _is_blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip()) or pd.isna(value)


def _raw_value(row: dict[str, Any], key: str) -> Any:
    value = row.get(key)
    if _is_blank(value):
        return None
    return value


def _join_key(row: dict[str, Any]) -> tuple[str, str, str, str]:
    return (
        str(_raw_value(row, "Company_Code") or "").strip(),
        str(_raw_value(row, "Fiscal_Year") or "").strip(),
        str(_raw_value(row, "Document_No") or "").strip(),
        str(_raw_value(row, "Line_Item") or "").strip(),
    )


def _to_float(value: Any) -> float | None:
    if _is_blank(value):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _build_joined_case_transactions(vendor_rows: list[dict[str, Any]], tds_rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    tds_by_key = {_join_key(row): row for row in tds_rows}
    joined_rows: list[dict[str, Any]] = []
    transaction_rows: list[dict[str, Any]] = []

    for vendor_row in vendor_rows:
        tds_row = tds_by_key.get(_join_key(vendor_row))
        amount = _to_float(vendor_row.get("Amount")) or 0.0
        tds_base = _to_float(tds_row.get("TDS_Base_Amount")) if tds_row else None
        tds_amount = _to_float(tds_row.get("TDS_Amount")) if tds_row else None
        tds_rate = _to_float(tds_row.get("TDS_Rate")) if tds_row else None
        tds_section = str(tds_row.get("TDS_Section") or "").strip() if tds_row else ""

        transaction_rows.append({
            "Company_Code": vendor_row.get("Company_Code"),
            "Vendor_Code": vendor_row.get("Vendor_Code"),
            "Vendor_Name": vendor_row.get("Vendor_Name"),
            "PAN": vendor_row.get("PAN"),
            "Posting_Date": vendor_row.get("Posting_Date"),
            "Bill_Date": vendor_row.get("Document_Date"),
            "Document_Type": vendor_row.get("Document_Type"),
            "Document_No": vendor_row.get("Document_No"),
            "Basic_Amount": tds_base if tds_base is not None else abs(amount),
            "Bill_Amount": abs(amount),
            "PO_Number": vendor_row.get("PO_Number"),
            "GL": vendor_row.get("GL"),
            "GL_Description": vendor_row.get("GL_Description"),
            "TDS_Section": tds_section,
            "TDS_Rate": tds_rate,
            "TDS_Amount": tds_amount,
            "deb_cred": vendor_row.get("Debit_Credit"),
            "LDC_Exemption_Number": tds_row.get("Certificate_Number") if tds_row else None,
        })
        joined_rows.append({
            "companyCode": vendor_row.get("Company_Code"),
            "financialYear": vendor_row.get("Fiscal_Year"),
            "docNo": vendor_row.get("Document_No"),
            "lineItem": vendor_row.get("Line_Item"),
            "vendor": vendor_row.get("Vendor_Name"),
            "vendorId": vendor_row.get("Vendor_Code"),
            "pan": vendor_row.get("PAN"),
            "docType": vendor_row.get("Document_Type"),
            "amount": amount,
            "tdsFound": tds_row is not None,
            "tdsSection": tds_section or "—",
            "tdsBase": tds_base,
            "tdsAmount": tds_amount,
            "certificateNumber": tds_row.get("Certificate_Number") if tds_row else None,
            "clearingDocument": vendor_row.get("Clearing_Document"),
            "clearingFiscalYear": vendor_row.get("Clearing_Fiscal_Year"),
            "clearingDate": vendor_row.get("Clearing_Date"),
            "invoiceReferenceDocument": vendor_row.get("Invoice_Reference_Document"),
            "invoiceReferenceFiscalYear": vendor_row.get("Invoice_Reference_Fiscal_Year"),
            "invoiceReferenceLineItem": vendor_row.get("Invoice_Reference_Line_Item"),
            "reversalDocument": vendor_row.get("Reversal_Document"),
            "isReversed": str(vendor_row.get("Is_Reversed") or "").strip().lower() == "true",
        })

    return transaction_rows, joined_rows


def _event_type_from_joined_row(row: dict[str, Any]) -> str:
    doc_type = str(row.get("docType") or "").strip().upper()
    amount = float(row.get("amount") or 0)
    if row.get("isReversed") or row.get("reversalDocument") or amount < 0:
        return "REVERSAL"
    if doc_type in {"KG", "AB"}:
        return "CREDIT_MEMO"
    if doc_type in {"RE", "KR"}:
        return "INVOICE"
    if doc_type == "KA":
        return "ADVANCE_PAYMENT"
    if doc_type == "KZ":
        return "PAYMENT"
    return "UNKNOWN"


def _case_anchor(row: dict[str, Any]) -> str:
    reference_doc = row.get("invoiceReferenceDocument")
    if not _is_blank(reference_doc):
        return str(reference_doc).strip()
    return str(row.get("docNo") or "").strip()


def _build_case_ledger(joined_rows: list[dict[str, Any]], issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    issues_by_doc: dict[str, list[dict[str, Any]]] = {}
    for issue in issues:
        issues_by_doc.setdefault(str(issue.get("docNo") or "").strip(), []).append(issue)

    ledgers: dict[tuple[str, str, str], dict[str, Any]] = {}
    for row in joined_rows:
        event_type = _event_type_from_joined_row(row)
        anchor_doc = _case_anchor(row)
        key = (str(row.get("companyCode") or "").strip(), str(row.get("financialYear") or "").strip(), anchor_doc)
        ledger = ledgers.setdefault(key, {
            "caseId": f"CASE-{key[0] or 'NA'}-{key[1] or 'FY'}-{anchor_doc or 'UNLINKED'}",
            "anchorDocNo": anchor_doc or "—",
            "companyCode": row.get("companyCode"),
            "financialYear": row.get("financialYear"),
            "vendor": row.get("vendor") or "Unknown vendor",
            "vendorId": row.get("vendorId") or "—",
            "pan": row.get("pan") or "—",
            "section": row.get("tdsSection") or "—",
            "invoiceAmount": 0.0,
            "advanceAmount": 0.0,
            "paymentAmount": 0.0,
            "creditAmount": 0.0,
            "reversalAmount": 0.0,
            "tdsAmount": 0.0,
            "eventCount": 0,
            "issueCount": 0,
            "events": [],
        })
        amount = abs(float(row.get("amount") or 0))
        tds_amount = float(row.get("tdsAmount") or 0)
        if event_type == "INVOICE":
            ledger["invoiceAmount"] += amount
        elif event_type == "ADVANCE_PAYMENT":
            ledger["advanceAmount"] += amount
        elif event_type == "PAYMENT":
            ledger["paymentAmount"] += amount
        elif event_type == "CREDIT_MEMO":
            ledger["creditAmount"] += amount
        elif event_type == "REVERSAL":
            ledger["reversalAmount"] += amount
        ledger["tdsAmount"] += tds_amount
        ledger["eventCount"] += 1
        doc_issues = issues_by_doc.get(str(row.get("docNo") or "").strip(), [])
        ledger["issueCount"] += len(doc_issues)
        ledger["events"].append({
            "docNo": row.get("docNo"),
            "docType": row.get("docType"),
            "eventType": event_type,
            "amount": row.get("amount"),
            "tdsAmount": row.get("tdsAmount"),
            "issues": [issue.get("category") for issue in doc_issues],
        })

    case_ledgers = []
    for ledger in ledgers.values():
        gross_base = ledger["invoiceAmount"] + ledger["advanceAmount"]
        adjustments = ledger["paymentAmount"] + ledger["creditAmount"] + ledger["reversalAmount"]
        ledger["openAmount"] = max(0.0, gross_base - adjustments)
        ledger["status"] = "ISSUE" if ledger["issueCount"] else "CLOSED" if ledger["openAmount"] == 0 and gross_base > 0 else "OPEN"
        case_ledgers.append(ledger)

    return sorted(case_ledgers, key=lambda item: (item.get("status") != "ISSUE", item.get("anchorDocNo") or ""))



def _build_case_ledger_from_transactions(transactions, issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    issues_by_doc: dict[str, list[dict[str, Any]]] = {}
    for issue in issues:
        issues_by_doc.setdefault(str(issue.get("docNo") or "").strip(), []).append(issue)

    ledgers: dict[tuple[str, str, str], dict[str, Any]] = {}
    for row_number, txn in enumerate(transactions, start=1):
        company_code = (txn.company_code or "").strip()
        fiscal_year = (txn.clearing_fiscal_year or txn.fiscal_year or "").strip()
        clearing_doc = (txn.clearing_document or "").strip()
        reference_doc = (txn.invoice_reference_document or txn.advance_document_reference or "").strip()
        assignment_number = (txn.assignment_number or "").strip()
        doc_no = (txn.doc_number or "").strip()

        group_type = "CLEARING" if clearing_doc else "REFERENCE" if reference_doc else "ASSIGNMENT" if assignment_number else "DOCUMENT"
        anchor_doc = clearing_doc or reference_doc or assignment_number or doc_no or f"ROW-{row_number}"
        key = (company_code, fiscal_year, anchor_doc)
        ledger = ledgers.setdefault(key, {
            "caseId": f"LEDGER-{key[0] or 'NA'}-{key[1] or 'FY'}-{key[2]}",
            "groupType": group_type,
            "anchorDocNo": anchor_doc or "—",
            "clearingDocument": clearing_doc or "—",
            "assignmentNumber": assignment_number or "—",
            "companyCode": company_code or None,
            "financialYear": fiscal_year or None,
            "vendor": txn.vendor_name or txn.vendor_code or "Unknown vendor",
            "vendorId": txn.vendor_code or "—",
            "pan": txn.vendor_pan or "—",
            "section": txn.tds_new_section or txn.tds_legacy_section or txn.tds_deducted_section or "—",
            "invoiceAmount": 0.0,
            "advanceAmount": 0.0,
            "paymentAmount": 0.0,
            "adjustmentAmount": 0.0,
            "debitAmount": 0.0,
            "creditAmount": 0.0,
            "netAmount": 0.0,
            "tdsAmount": 0.0,
            "eventCount": 0,
            "issueCount": 0,
            "events": [],
        })

        event_type = classify_event(txn)
        signed_amount = float(txn.bill_amount or 0.0)
        amount = abs(signed_amount)
        if signed_amount >= 0:
            ledger["debitAmount"] += amount
        else:
            ledger["creditAmount"] += amount
        ledger["netAmount"] += signed_amount

        if event_type == "INVOICE":
            ledger["invoiceAmount"] += amount
        elif event_type == "ADVANCE_PAYMENT":
            ledger["advanceAmount"] += amount
        elif event_type == "PAYMENT":
            ledger["paymentAmount"] += amount
        else:
            ledger["adjustmentAmount"] += amount

        doc_issues = issues_by_doc.get(doc_no, [])
        tds_amount = abs(float(txn.tds_deducted_amount or 0.0))
        ledger["tdsAmount"] += tds_amount
        ledger["eventCount"] += 1
        ledger["issueCount"] += len(doc_issues)
        ledger["events"].append({
            "docNo": doc_no or "—",
            "lineItem": txn.line_item_number or "—",
            "docType": txn.doc_type or "—",
            "assignmentNumber": txn.assignment_number or "—",
            "eventType": event_type,
            "postingDate": txn.posting_date.isoformat() if txn.posting_date else "—",
            "glAccount": txn.gl_account or "—",
            "debitCredit": txn.debit_credit or "—",
            "amount": signed_amount,
            "baseAmount": txn.basic_amount,
            "tdsSection": txn.tds_new_section or txn.tds_legacy_section or txn.tds_deducted_section or "—",
            "tdsAmount": tds_amount,
            "referenceDoc": txn.invoice_reference_document or txn.advance_document_reference or "—",
            "issues": [issue.get("category") for issue in doc_issues],
        })

    case_ledgers = []
    for ledger in ledgers.values():
        ledger["openAmount"] = round(ledger["invoiceAmount"] + ledger["advanceAmount"] - ledger["paymentAmount"] - ledger["adjustmentAmount"], 2)
        ledger["netAmount"] = round(ledger["netAmount"], 2)
        ledger["status"] = "ISSUE" if ledger["issueCount"] else "BALANCED" if abs(ledger["netAmount"]) <= 1 else "OPEN"
        case_ledgers.append(ledger)

    return sorted(case_ledgers, key=lambda item: (item.get("status") != "ISSUE", item.get("anchorDocNo") or ""))

def _read_upload(filename: str, content: bytes) -> pd.DataFrame:
    suffix = Path(filename).suffix.lower()
    if suffix == ".csv":
        try:
            return pd.read_csv(BytesIO(content))
        except UnicodeDecodeError:
            return pd.read_csv(BytesIO(content), encoding="latin-1")

    try:
        # openpyxl supports both .xlsx and macro-enabled .xlsm workbooks.
        # Legacy .xls requires xlrd, which is intentionally not a dependency.
        if suffix == ".xls":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Legacy .xls files are not supported yet. Save the file as .xlsx and upload it again.",
            )
        return pd.read_excel(BytesIO(content), engine="openpyxl")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Could not read the spreadsheet. Ensure the first worksheet has a header row and is not password protected.",
        ) from exc


def _present_aliases(columns: list[str], internal_name: str) -> set[str]:
    return set(COLUMN_ALIASES[internal_name]).intersection(columns)


def _validate_headers(columns: list[str]) -> None:
    # These are the minimum values needed to identify a transaction and run
    # a TDS rule. Other fields are optional and enable more specific checks.
    missing = []
    if not _present_aliases(columns, "posting_date"):
        missing.append("Posting_Date")
    if not _present_aliases(columns, "tds_section"):
        missing.append("TDS_Section")
    if not _present_aliases(columns, "tds_rate"):
        missing.append("TDS_Rate")
    if not (_present_aliases(columns, "basic_amount") or _present_aliases(columns, "bill_amount")):
        missing.append("Basic_Amount or Bill_Amount")

    if missing:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Missing required column(s): {', '.join(missing)}. Download the template for the expected format.",
        )


def _normalise_records(frame: pd.DataFrame) -> list[dict[str, Any]]:
    frame = frame.dropna(axis=0, how="all")
    frame.columns = [str(column).strip() for column in frame.columns]
    _validate_headers(list(frame.columns))
    return frame.where(pd.notna(frame), None).to_dict(orient="records")


def _transaction_issue(issue_id: int, txn, rule_issue) -> dict[str, Any]:
    # Rule-specific overrides (PAN/206AA, inferred missing-deduction rates,
    # LDC, etc.) must win over the base statutory section rate.
    expected_rate = rule_issue.expected_rate
    if expected_rate is None:
        expected_rate = (
            _get_rate_for_section(rule_issue.expected_section, txn)
            if rule_issue.expected_section
            else _get_applicable_rate(txn)
        )
    applied_rate = txn.tds_deducted_rate
    # Bill amount is retained for display when SAP did not provide a taxable
    # base. It is never used to calculate tax impact or rule outcomes.
    base_amount = _get_tds_base_amount(txn)
    if base_amount is None:
        base_amount = txn.basic_amount if txn.basic_amount is not None else txn.bill_amount
    tax_impact = 0.0
    tax_base_amount = _get_tds_base_amount(txn)
    if tax_base_amount is not None and expected_rate is not None:
        # No rate recorded on the transaction means nothing was deducted —
        # treat that as 0% for the purpose of measuring the shortfall.
        reference_rate = applied_rate if applied_rate is not None else 0.0
        tax_impact = abs(tax_base_amount * (expected_rate - reference_rate) / 100)
        
    category = rule_issue.category
    effective_section = (
        txn.tds_new_section
        if txn.posting_date >= NEW_ACT_EFFECTIVE_DATE and txn.tds_new_section
        else txn.tds_legacy_section
        or txn.tds_deducted_section
        or txn.tds_new_section
        or rule_issue.expected_section
        or "—"
    )
    return {
        "id": f"UPL-{issue_id:06d}",
        "docNo": txn.doc_number or "—",
        "companyCode": txn.company_code or None,
        "vendor": txn.vendor_name or txn.vendor_code or "Unknown vendor",
        "vendorId": txn.vendor_code or "—",
        "vendorPan": txn.vendor_pan or "—",
        # Keep the new-law source reference and legacy compatibility key side
        # by side. `section` is date-effective and is the table/filter label.
        "section": effective_section,
        "newSection": txn.tds_new_section,
        "legacySection": txn.tds_legacy_section or txn.tds_deducted_section,
        "ruleSection": txn.tds_deducted_section,
        "source": "GL" if txn.gl_account else "SAP",
        "transactionAmount": base_amount,
        "baseAmount": base_amount,
        "baseAmountAvailable": _get_tds_base_amount(txn) is not None,
        "tdsAmount": txn.tds_deducted_amount or 0.0,
        "expectedRate": expected_rate,
        "appliedRate": applied_rate,
        "taxImpact": round(tax_impact, 2),
        "issueType": ISSUE_TYPE_BY_CATEGORY.get(category, "OTHER"),
        "issueTypeLabel": category,
        "category": category,
        "isViolation": rule_issue.severity != "low",
        "severity": rule_issue.severity,
        "status": "open",
        "date": txn.posting_date.isoformat(),
        "description": rule_issue.message,
        "plainEnglish": rule_issue.message,
        "issueDetail": rule_issue.message,
        "recommendedAction": "Review the transaction and correct the TDS entry where required.",
        "suggestedCorrection": "Review the transaction and correct the TDS entry where required.",
    }


def _threshold_section_for_transaction(txn) -> str:
    payment_section = PAYMENT_TYPE_TO_SECTION.get(_normalise_payment_type(txn.transaction_kind))
    return (
        txn.tds_legacy_section
        or txn.tds_deducted_section
        or payment_section
        or txn.tds_new_section
        or "—"
    )


def _threshold_vendor_summaries(transactions) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}

    for txn in transactions:
        section = _threshold_section_for_transaction(txn)
        pan = txn.vendor_pan or "—"
        key = f"{pan}||{section}"
        base_amount = _get_tds_base_amount(txn)
        if base_amount is None:
            base_amount = txn.basic_amount if txn.basic_amount is not None else txn.bill_amount

        if key not in grouped:
            grouped[key] = {
                "id": key,
                "companyCode": txn.company_code or None,
                "name": txn.vendor_name or txn.vendor_code or "Unknown vendor",
                "vendorId": pan,
                "vendorCodes": [],
                "vendorNames": [],
                "pan": pan,
                "section": section,
                "currentAmount": 0.0,
                "rowCount": 0,
            }

        vendor_code = txn.vendor_code or "—"
        vendor_name = txn.vendor_name or txn.vendor_code or "Unknown vendor"
        if vendor_code not in grouped[key]["vendorCodes"]:
            grouped[key]["vendorCodes"].append(vendor_code)
        if vendor_name not in grouped[key]["vendorNames"]:
            grouped[key]["vendorNames"].append(vendor_name)
        grouped[key]["currentAmount"] += float(base_amount or 0)
        grouped[key]["rowCount"] += 1

    for row in grouped.values():
        if row["vendorNames"]:
            row["name"] = " / ".join(row["vendorNames"][:2])
            if len(row["vendorNames"]) > 2:
                row["name"] += f" +{len(row['vendorNames']) - 2}"

    return sorted(
        grouped.values(),
        key=lambda row: (row["pan"], row["section"]),
    )


def _transaction_validation_row(txn, status: str, reason: str, row_index: int) -> dict[str, Any]:
    base_amount = _get_tds_base_amount(txn)
    if base_amount is None:
        base_amount = txn.basic_amount if txn.basic_amount is not None else txn.bill_amount
    expected_rate = _get_applicable_rate(txn)
    section = (txn.tds_deducted_section or txn.tds_legacy_section or "").strip().upper()
    if section == "194J" and txn.tds_deducted_rate in SECTION_194J_VALID_RATES:
        expected_rate = txn.tds_deducted_rate

    return {
        "id": f"{status}:{row_index}:{txn.doc_number}:{txn.vendor_code}:{_threshold_section_for_transaction(txn)}",
        "status": status,
        "reason": reason,
        "docNo": txn.doc_number or "—",
        "poNo": txn.po_no or "—",
        "docType": txn.doc_type or "—",
        "companyCode": txn.company_code or None,
        "vendor": txn.vendor_name or txn.vendor_code or "Unknown vendor",
        "vendorId": txn.vendor_code or "—",
        "vendorPan": txn.vendor_pan or "—",
        "section": _threshold_section_for_transaction(txn),
        "billAmount": txn.bill_amount,
        "baseAmount": base_amount,
        "tdsAmount": txn.tds_deducted_amount or 0.0,
        "appliedRate": txn.tds_deducted_rate,
        "expectedRate": expected_rate,
        "date": txn.posting_date.isoformat(),
    }


def _has_validation_signal(txn) -> bool:
    return any((
        txn.tds_deducted_section,
        txn.tds_legacy_section,
        txn.tds_new_section,
        txn.tds_deducted_rate is not None,
        txn.tds_applicable_section,
        txn.tds_applicable_rate is not None,
        txn.transaction_kind,
    ))


def _has_zero_base_amount(txn) -> bool:
    base_amount = _get_tds_base_amount(txn)
    return base_amount is not None and float(base_amount) == 0.0


@router.post("/upload")
async def upload_sap_file(
    file: UploadFile = File(...),
    company_code: str = Form(""),
    include_informational: bool = Form(False),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Analyse one SAP CSV/XLSX extract and return issues for the frontend."""
    filename = file.filename or "upload"
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Upload a CSV, XLSX, XLSM, or XLS file.")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=422, detail="The uploaded file is empty.")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="The uploaded file exceeds the 25 MB limit.")

    frame = _read_upload(filename, content)
    if frame.empty:
        raise HTTPException(status_code=422, detail="The uploaded file has no transaction rows.")

    records = _normalise_records(frame)
    allowed_codes = set(get_user_company_codes(current_user, db))
    requested_code = company_code.strip()
    if requested_code and requested_code not in allowed_codes:
        raise HTTPException(status_code=403, detail=f"You do not have access to company code {requested_code}.")

    if requested_code:
        for row in records:
            if _is_blank(row.get("Company_Code")):
                row["Company_Code"] = requested_code

    # Restrict accountants to their company codes even when they select "all".
    if current_user.role != "admin":
        records = [row for row in records if str(row.get("Company_Code") or "").strip() in allowed_codes]
        if not records:
            raise HTTPException(status_code=403, detail="No rows belong to company codes assigned to your account.")
    elif requested_code:
        records = [row for row in records if str(row.get("Company_Code") or "").strip() == requested_code]

    # Exports containing compound descriptive section text (either the old
    # numbering, e.g. "194C - Ind/HUF - 1%", or the new one, e.g.
    # "...-393(1)6(i)") need the decoder + signed-amount normalization;
    # ordinary SAP exports with bare section codes use the alias-based translator.
    uses_descriptive_section = any(
        looks_like_descriptive_tds_section(get_tds_section_raw(row)) for row in records
    )

    try:
        transactions = (
            build_transactions_from_sap_export(records)
            if uses_descriptive_section
            else build_transactions_from_sap_rows(records)
        )
    except (ValidationError, ValueError, TypeError) as exc:
        raise HTTPException(
            status_code=422,
            detail="One or more rows contain invalid dates or amounts. Correct the values and upload the file again.",
        ) from exc

    if not transactions:
        raise HTTPException(
            status_code=422,
            detail="No TDS-relevant transactions were found. Ensure TDS_Section and TDS_Rate are populated.",
        )

    _apply_ldc_master_to_transactions(transactions, db)
    tds_cases, case_stats = build_tds_cases(transactions)
    ldc_utilization = _build_ldc_utilization(transactions)
    _attach_ldc_limits(ldc_utilization, db)

    issues: list[dict[str, Any]] = []
    issue_reasons_by_transaction_id: dict[int, str] = {}
    issue_transaction_ids: set[int] = set()
    issue_eligible_transactions = [
        txn for txn in transactions if not _has_zero_base_amount(txn)
    ]
    for txn in issue_eligible_transactions:
        for rule_issue in run_all_checks(txn):
            if include_informational or rule_issue.severity != "low":
                issues.append(_transaction_issue(len(issues) + 1, txn, rule_issue))
                issue_transaction_ids.add(id(txn))
                issue_reasons_by_transaction_id.setdefault(id(txn), rule_issue.category)

    # Threshold checks operate across transactions, so each result carries a
    # representative transaction from its own vendor/section/FY group.
    for txn, rule_issue in check_threshold_breach(issue_eligible_transactions):
        if include_informational or rule_issue.severity != "low":
            issues.append(_transaction_issue(len(issues) + 1, txn, rule_issue))
            issue_transaction_ids.add(id(txn))
            issue_reasons_by_transaction_id.setdefault(id(txn), rule_issue.category)


    for txn, rule_issue in check_missing_deduction(issue_eligible_transactions):
        if include_informational or rule_issue.severity != "low":
            issues.append(_transaction_issue(len(issues) + 1, txn, rule_issue))
            issue_transaction_ids.add(id(txn))
            issue_reasons_by_transaction_id.setdefault(id(txn), rule_issue.category)

    for txn, rule_issue in check_advance_payment_lifecycle(issue_eligible_transactions):
        if include_informational or rule_issue.severity != "low":
            issues.append(_transaction_issue(len(issues) + 1, txn, rule_issue))
            issue_transaction_ids.add(id(txn))
            issue_reasons_by_transaction_id.setdefault(id(txn), rule_issue.category)

    for txn, rule_issue in _check_ldc_limit_breach(issue_eligible_transactions, ldc_utilization):
        issues.append(_transaction_issue(len(issues) + 1, txn, rule_issue))
        issue_transaction_ids.add(id(txn))
        issue_reasons_by_transaction_id.setdefault(id(txn), rule_issue.category)

    vendors = sorted({issue["vendor"] for issue in issues if issue["vendor"]})
    sections = sorted({issue["section"] for issue in issues if issue["section"] and issue["section"] != "—"})
    threshold_vendors = _threshold_vendor_summaries(transactions)
    case_ledger = _build_case_ledger_from_transactions(transactions, issues)
    insufficient_data_rows = sum(
        id(txn) not in issue_transaction_ids and (_has_zero_base_amount(txn) or not _has_validation_signal(txn))
        for txn in transactions
    )
    issue_rows = len(issue_transaction_ids)
    passed_rows = max(0, len(transactions) - issue_rows - insufficient_data_rows)
    validation_rows = []
    for row_index, txn in enumerate(transactions, start=1):
        txn_id = id(txn)
        if txn_id in issue_transaction_ids:
            validation_rows.append(_transaction_validation_row(
                txn,
                "issue",
                issue_reasons_by_transaction_id.get(txn_id, "Issue found"),
                row_index,
            ))
        elif _has_zero_base_amount(txn):
            validation_rows.append(_transaction_validation_row(
                txn,
                "insufficient",
                "Base amount is zero, so TDS cannot be validated for this row.",
                row_index,
            ))
        elif not _has_validation_signal(txn):
            validation_rows.append(_transaction_validation_row(
                txn,
                "insufficient",
                "Missing section/rate/applicable section/payment type, so rules cannot validate this row.",
                row_index,
            ))
        else:
            validation_rows.append(_transaction_validation_row(
                txn,
                "passed",
                "Validated with no issue found.",
                row_index,
            ))

    stats = {
        "rowsRead": len(records),
        "transactionsBuilt": len(transactions),
        "rowsSkipped": len(records) - len(transactions),
        "passedRows": passed_rows,
        "issueRows": issue_rows,
        "insufficientDataRows": insufficient_data_rows,
        "validatedRows": passed_rows + issue_rows,
        "issuesFound": len(issues),
        "ledgerCases": len(case_ledger),
        "openLedgerCases": sum(case["status"] == "OPEN" for case in case_ledger),
        "issueLedgerCases": sum(case["status"] == "ISSUE" for case in case_ledger),
        "balancedLedgerCases": sum(case["status"] == "BALANCED" for case in case_ledger),
        "high": sum(issue["severity"] == "high" for issue in issues),
        "medium": sum(issue["severity"] == "medium" for issue in issues),
        "low": sum(issue["severity"] == "low" for issue in issues),
    }

    return {
        "uploadId": str(uuid4()),
        "fileName": filename,
        "companyCode": requested_code or None,
        "issues": issues,
        "stats": stats,
        "vendors": vendors,
        "sections": sections,
        "thresholdVendors": threshold_vendors,
        "ldcUtilization": ldc_utilization,
        "tdsCases": tds_cases,
        "caseStats": case_stats,
        "caseLedger": case_ledger,
        "validationRows": validation_rows,
        "unrecognizedColumns": [],
        "errors": [],
    }


@router.post("/upload-case-sources")
async def upload_case_source_files(
    vendor_events_file: UploadFile = File(...),
    tds_events_file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Temporary two-file case builder: vendor events LEFT JOIN WITH_ITEM/TDS events."""
    del current_user
    vendor_content = await vendor_events_file.read()
    tds_content = await tds_events_file.read()
    if not vendor_content or not tds_content:
        raise HTTPException(status_code=422, detail="Both vendor events and TDS events files are required.")
    if len(vendor_content) > MAX_UPLOAD_BYTES or len(tds_content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="One of the uploaded files exceeds the 25 MB limit.")

    vendor_frame = _read_upload(vendor_events_file.filename or "vendor_events.csv", vendor_content)
    tds_frame = _read_upload(tds_events_file.filename or "tds_events.csv", tds_content)
    vendor_frame.columns = [str(column).strip() for column in vendor_frame.columns]
    tds_frame.columns = [str(column).strip() for column in tds_frame.columns]

    vendor_rows = vendor_frame.where(pd.notna(vendor_frame), None).to_dict(orient="records")
    tds_rows = tds_frame.where(pd.notna(tds_frame), None).to_dict(orient="records")
    transaction_rows, joined_rows = _build_joined_case_transactions(vendor_rows, tds_rows)

    transactions = build_transactions_from_sap_rows(transaction_rows)
    _apply_ldc_master_to_transactions(transactions, db)
    tds_cases, case_stats = build_tds_cases(transactions)
    ldc_utilization = _build_ldc_utilization(transactions)
    _attach_ldc_limits(ldc_utilization, db)

    issues: list[dict[str, Any]] = []
    issue_transaction_ids: set[int] = set()
    issue_eligible_transactions = [
        txn for txn in transactions if not _has_zero_base_amount(txn)
    ]

    for txn in issue_eligible_transactions:
        for rule_issue in run_all_checks(txn):
            if rule_issue.severity != "low":
                issues.append(_transaction_issue(len(issues) + 1, txn, rule_issue))
                issue_transaction_ids.add(id(txn))

    for txn, rule_issue in check_threshold_breach(issue_eligible_transactions):
        if rule_issue.severity != "low":
            issues.append(_transaction_issue(len(issues) + 1, txn, rule_issue))
            issue_transaction_ids.add(id(txn))

    for txn, rule_issue in check_missing_deduction(issue_eligible_transactions):
        if rule_issue.severity != "low":
            issues.append(_transaction_issue(len(issues) + 1, txn, rule_issue))
            issue_transaction_ids.add(id(txn))

    for txn, rule_issue in check_advance_payment_lifecycle(issue_eligible_transactions):
        if rule_issue.severity != "low":
            issues.append(_transaction_issue(len(issues) + 1, txn, rule_issue))
            issue_transaction_ids.add(id(txn))

    for txn, rule_issue in _check_ldc_limit_breach(issue_eligible_transactions, ldc_utilization):
        issues.append(_transaction_issue(len(issues) + 1, txn, rule_issue))
        issue_transaction_ids.add(id(txn))

    missing_tds_candidates = [
        row for row in joined_rows
        if not row["tdsFound"] and str(row.get("docType") or "").upper() in {"RE", "KR", "KA"}
    ]
    threshold_vendors = _threshold_vendor_summaries(transactions)
    case_ledger = _build_case_ledger(joined_rows, issues)
    insufficient_data_rows = sum(
        id(txn) not in issue_transaction_ids and (_has_zero_base_amount(txn) or not _has_validation_signal(txn))
        for txn in transactions
    )
    issue_rows = len(issue_transaction_ids)
    passed_rows = max(0, len(transactions) - issue_rows - insufficient_data_rows)

    response = {
        "uploadId": str(uuid4()),
        "vendorEventsFileName": vendor_events_file.filename,
        "tdsEventsFileName": tds_events_file.filename,
        "stats": {
            "vendorEvents": len(vendor_rows),
            "tdsEvents": len(tds_rows),
            "joinedEvents": len(joined_rows),
            "missingTdsCandidates": len(missing_tds_candidates),
            **case_stats,
            "transactionsBuilt": len(transactions),
            "passedRows": passed_rows,
            "issueRows": issue_rows,
            "insufficientDataRows": insufficient_data_rows,
            "issuesFound": len(issues),
            "ledgerCases": len(case_ledger),
            "openLedgerCases": sum(case["status"] == "OPEN" for case in case_ledger),
            "issueLedgerCases": sum(case["status"] == "ISSUE" for case in case_ledger),
            "high": sum(issue["severity"] == "high" for issue in issues),
            "medium": sum(issue["severity"] == "medium" for issue in issues),
            "low": sum(issue["severity"] == "low" for issue in issues),
        },
        "joinedRows": joined_rows,
        "tdsCases": tds_cases,
        "caseLedger": case_ledger,
        "issues": issues,
        "thresholdVendors": threshold_vendors,
        "ldcUtilization": ldc_utilization,
        "missingTdsCandidates": missing_tds_candidates,
    }
    return _json_safe(response)


@router.get("/template")
def download_upload_template(current_user: User = Depends(get_current_user)):
    """Return a minimal CSV template matching the accepted SAP aliases."""
    del current_user  # Authentication is required; no user-specific content.
    columns = [
        "Company_Code", "Vendor_Code", "Vendor_Name", "PAN", "Posting_Date",
        "Document_Type", "Document_No", "Bill_Amount", "Basic_Amount", "GL",
        "GL_Description", "TDS_Section", "TDS_Rate", "TDS_Amount",
    ]
    example = [
        "1001", "V0001", "Example Vendor", "ABCDE1234F", "2026-04-01",
        "KR", "1900000001", "100000", "100000", "500100",
        "Professional fees", "194J", "10", "10000",
    ]
    csv = ",".join(columns) + "\n" + ",".join(example) + "\n"
    return StreamingResponse(
        iter([csv]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=tds_sap_upload_template.csv"},
    )
