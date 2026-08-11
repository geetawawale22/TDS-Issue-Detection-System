"""SAP file-upload endpoints for running the TDS rule engine.

The API deliberately does not persist an uploaded file or its results.  It
analyses the file supplied by the authenticated user and returns a UI-shaped
result for the current browser session.
"""

from __future__ import annotations

from datetime import date
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
from db.models import User
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
    _get_applicable_rate,
    run_all_checks,
    check_threshold_breach,
    check_missing_deduction,
)


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
    "TDS Not Deducted — Advance Payment": "MISSED_ADVANCE",
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


def _is_blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip()) or pd.isna(value)


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
        vendor_id = txn.vendor_code or txn.vendor_name or "—"
        key = f"{vendor_id}||{section}"
        base_amount = _get_tds_base_amount(txn)
        if base_amount is None:
            base_amount = txn.basic_amount if txn.basic_amount is not None else txn.bill_amount

        if key not in grouped:
            grouped[key] = {
                "id": key,
                "companyCode": txn.company_code or None,
                "name": txn.vendor_name or txn.vendor_code or "Unknown vendor",
                "vendorId": vendor_id,
                "pan": txn.vendor_pan or "—",
                "section": section,
                "currentAmount": 0.0,
                "rowCount": 0,
            }

        grouped[key]["currentAmount"] += float(base_amount or 0)
        grouped[key]["rowCount"] += 1

    return sorted(
        grouped.values(),
        key=lambda row: (row["name"], row["section"]),
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
        "companyCode": txn.company_code or None,
        "vendor": txn.vendor_name or txn.vendor_code or "Unknown vendor",
        "vendorId": txn.vendor_code or "—",
        "vendorPan": txn.vendor_pan or "—",
        "section": _threshold_section_for_transaction(txn),
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

    vendors = sorted({issue["vendor"] for issue in issues if issue["vendor"]})
    sections = sorted({issue["section"] for issue in issues if issue["section"] and issue["section"] != "—"})
    threshold_vendors = _threshold_vendor_summaries(transactions)
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
        "validationRows": validation_rows,
        "unrecognizedColumns": [],
        "errors": [],
    }


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
