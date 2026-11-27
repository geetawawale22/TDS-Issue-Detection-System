"""SAP file-upload endpoints for running the TDS rule engine.

The uploaded file itself is not stored. Its full result is returned to the
browser; only the issues are saved (services/issue_tracker.py) so later runs
can tell which earlier issues were reversed or corrected.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from dataclasses import dataclass
import json
import logging
import math
from io import BytesIO
from pathlib import Path
from typing import Any
from uuid import uuid4

import pandas as pd
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.encoders import jsonable_encoder
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import ValidationError
from sqlalchemy import or_, tuple_
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.orm import Session

from core.dependencies import get_current_user, get_user_company_codes
from db.database import get_db
from db.models import LDCCertificateMaster, PanVerification, TrackedIssue, User, VendorMaster
from ingestion.sap_translator import (
    COLUMN_ALIASES,
    build_transactions_from_sap_export,
    build_transactions_from_sap_rows,
    drop_unused_withholding_rows,
    get_tds_section_raw,
    looks_like_descriptive_tds_section,
)
from rules.tds_rule_engine import (
    SECTION_194I_VALID_RATES,
    SECTION_194J_VALID_RATES,
    SECTIONS,
    TDSIssue,
    _expected_section,
    _get_applicable_rate,
    _is_advance_clearing_adjustment,
    run_all_checks,
    ldc_decides_transaction,
    link_advances_to_invoices,
    check_ldc_advance_chain,
    check_threshold_breach,
    check_missing_deduction,
    check_advance_payment_lifecycle,
    statutory_rate_for_section,
    threshold_period,
)
from services.tds_case_builder import build_tds_cases, classify_event
from rules.doc_types import doc_type_event
from services.issue_tracker import build_issue_key, fiscal_year_for, references_other_document, track_rule_run
from services.ledger_store import save_run_lines
from services.report_category import apply_resolutions, build_advance_roles, issue_report_category, report_fields


router = APIRouter(prefix="/issues", tags=["Issues"])
logger = logging.getLogger(__name__)

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
SUPPORTED_EXTENSIONS = {".csv", ".xlsx", ".xls", ".xlsm"}
NEW_ACT_EFFECTIVE_DATE = date(2026, 4, 1)


def _format_display_date(value: date | None) -> str:
    return value.strftime("%d/%m/%Y") if value else "—"


ALWAYS_VALIDATE_DOC_TYPES = {"RE", "KZ", "KR", "KG", "LQ"}
NON_TDS_DEDUCTION_DOC_TYPES = {
    # Supporting/accounting document types may be skipped only when no TDS section
    # and no TDS amount are present. Invoice/payment-like types stay validated.
    "AB": "Clearing Document",
    "BD": "Accounting/adjustment document",
    "JR": "Provisional J.Vs",
    "JV": "Journal Entry",
    "KW": "Supporting accounting document",
    "SK": "Supporting accounting document",
    "KA": "Vendor advance document",
    "TP": "Transfer Postings",
    "BT": "TDS Payments",
    "SA": "G/L account document",
    "ST": "IUT - Stock Transfer",
    "BR": "Bank Recon. Doc.",
    "ML": "Material Ledger",
    "PR": "Price Change",
    "QR": "Accrual auto posting",
    "QS": "Cost Settlement",
    "UG": "IUTN/IDTN - GL",
    "ZY": "IFRS - GL Reclassify",
    "ZZ": "Sales Inv-SD RevRec",
    "WA": "Goods Issue",
    "WE": "Goods Receipt",
    "WI": "Inventory Document",
    "WL": "Goods Issue/Delivery",
    "WN": "Net Goods Receipt",
    "W2": "GR/IR Stock posting",
    "W3": "Goods Receipt statement",
}

# Matches the identifiers used by the frontend's issue-type filters.
ISSUE_TYPE_BY_CATEGORY = {
    "TDS Not Applicable — Violation": "GL_EXCLUSION_VIOLATION",
    "TDS Not Applicable": "GL_EXCLUSION_CLEAN",
    "PAN Missing/Invalid — TDS Not Deducted": "PAN_MISSING_NOT_DEDUCTED",
    "PAN Missing/Invalid — Short TDS Deducted": "PAN_MISSING_SHORT",
    "PAN Missing/Invalid — Correctly Handled": "PAN_CORRECT",
    "Wrong TDS Rate": "WRONG_TDS_RATE",
    "TDS Section Missing": "MISSING_SECTION",
    "Short TDS Deducted": "SHORT_TDS",
    "Excess TDS Deducted": "EXCESS_TDS",
    "Wrong Section Applied": "WRONG_SECTION_HSN",
    "Wrong Section Applied — Non-Resident": "WRONG_SECTION_NON_RESIDENT",
    "Wrong Section Applied — Resident": "WRONG_SECTION_RESIDENT",
    "LDC Not Yet Valid": "LDC_NOT_YET_VALID",
    "LDC Expired": "LDC_EXPIRED",
    "TDS Not Deducted as per LDC": "LDC_MISMATCH",
    "TDS Deducted as per LDC — Mismatch": "LDC_MISMATCH",  # name before 2026-11-23
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
    return statutory_rate_for_section(section, txn)


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


def _withholding_key(wtax_type: str | None, wtax_code: str | None) -> str | None:
    tax_type = (wtax_type or "").strip().upper()
    tax_code = (wtax_code or "").strip().upper()
    if tax_type and tax_code:
        return f"{tax_type}/{tax_code}"
    return tax_code or tax_type or None


def _certificate_section_matches(
    cert_section: str | None,
    txn_withholding_key: str | None,
    txn_sections: set[str],
    cert_wtax_key: str | None = None,
) -> bool:
    cert_key = (cert_section or "").strip().upper()
    raw_cert_key = (cert_wtax_key or "").strip().upper()
    if not cert_key and not raw_cert_key:
        return False

    if txn_withholding_key:
        txn_key = txn_withholding_key.strip().upper()
        txn_type, _, txn_code = txn_key.partition("/")
        allowed_keys = {txn_key}
        if txn_code:
            allowed_keys.add(txn_code)
        if txn_type:
            allowed_keys.add(txn_type)
        return raw_cert_key in allowed_keys or cert_key in allowed_keys or _normalise_section(cert_key) in txn_sections

    return cert_key in txn_sections or _normalise_section(cert_key) in txn_sections


def _looks_like_pan(value: str | None) -> bool:
    text = (value or "").strip().upper()
    return len(text) == 10 and text[:5].isalpha() and text[5:9].isdigit() and text[9].isalpha()


def _attach_ldc_certificate(txn, cert: LDCCertificateMaster) -> None:
    txn.ldc_exemption_number = cert.certificate_number
    txn.ldc_exempt_from = cert.valid_from
    txn.ldc_exempt_to = cert.valid_to
    txn.ldc_exemption_percent = float(cert.approved_tds_rate)
    txn.ldc_exemption_reason = f"{cert.certificate_type} certificate from LDC master"


def _sample_values(values: list[str]) -> str:
    unique_values = sorted({value for value in values if value})
    if not unique_values:
        return "—"
    if len(unique_values) <= 3:
        return ", ".join(unique_values)
    return f"{', '.join(unique_values[:3])} +{len(unique_values) - 3} more"


def _set_ldc_no_match_reason(
    txn,
    certificates: list[LDCCertificateMaster],
    reason: str,
    scope_cache: dict[tuple[int, ...], str] | None = None,
) -> None:
    if not certificates or txn.ldc_exemption_number:
        return

    # The scope text depends only on the certificates; a vendor's lines share
    # them, so it is worked out once per certificate set (scope_cache).
    cache_key = tuple(id(cert) for cert in certificates)
    scope = scope_cache.get(cache_key) if scope_cache is not None else None
    if scope is None:
        company_codes = _sample_values([cert.company_code or "Any company" for cert in certificates])
        sections = _sample_values([cert.applicable_tds_section or "" for cert in certificates])
        wtax_keys = _sample_values([
            _withholding_key(cert.wtax_type, cert.wtx_code) or ""
            for cert in certificates
        ])
        validities = _sample_values([
            f"{_format_display_date(cert.valid_from)} to {_format_display_date(cert.valid_to)}"
            for cert in certificates
            if cert.valid_from and cert.valid_to
        ])
        scope = (
            f"Available LDC scope for this PAN/vendor is company {company_codes}, "
            f"section {sections}, WTax {wtax_keys}, validity {validities}."
        )
        if scope_cache is not None:
            scope_cache[cache_key] = scope
    txn.ldc_exemption_reason = f"No applicable LDC certificate found: {reason}. {scope}"


def _apply_pan_verification_to_transactions(transactions, db: Session) -> None:
    """
    Copy saved Government PAN check results onto the transactions so the
    rule engine treats INVALID / INOPERATIVE PANs like a missing PAN (206AA).
    Runs after the LDC step, which may fill in PANs from the vendor master.
    """
    pans = {
        txn.vendor_pan.strip().upper()
        for txn in transactions
        if txn.vendor_pan and _looks_like_pan(txn.vendor_pan)
    }
    if not pans:
        return
    try:
        status_by_pan = {
            row.pan: row.status
            for row in db.query(PanVerification.pan, PanVerification.status)
            .filter(PanVerification.pan.in_(pans))
            .all()
        }
    except ProgrammingError:
        # pan_verifications table not migrated yet — analyse without it.
        db.rollback()
        return
    for txn in transactions:
        pan = (txn.vendor_pan or "").strip().upper()
        txn.vendor_pan_status = status_by_pan.get(pan)


def _apply_ldc_master_to_transactions(transactions, db: Session) -> None:
    """
    Enrich in-memory SAP transactions with the uploaded LDC master before the
    rule engine runs. Matching is PAN-first, then company, section, date.
    """
    if not transactions:
        return

    vendor_codes = {txn.vendor_code.strip() for txn in transactions if txn.vendor_code}
    vendor_codes.update(
        txn.vendor_pan.strip()
        for txn in transactions
        if txn.vendor_pan and not _looks_like_pan(txn.vendor_pan)
    )
    vendor_pan_by_code = {
        row.vendor_code: row.vendor_pan
        for row in db.query(VendorMaster).filter(
            VendorMaster.vendor_code.in_(vendor_codes),
            VendorMaster.is_active == True,
        ).all()
    }

    for txn in transactions:
        vendor_pan = (txn.vendor_pan or "").strip()
        if txn.vendor_code in vendor_pan_by_code and (not vendor_pan or not _looks_like_pan(vendor_pan)):
            txn.vendor_pan = vendor_pan_by_code[txn.vendor_code]
        elif vendor_pan in vendor_pan_by_code and not _looks_like_pan(vendor_pan):
            txn.vendor_pan = vendor_pan_by_code[vendor_pan]

    pans = {txn.vendor_pan.strip().upper() for txn in transactions if txn.vendor_pan and _looks_like_pan(txn.vendor_pan)}
    vendor_codes = {txn.vendor_code.strip() for txn in transactions if txn.vendor_code}
    if not pans and not vendor_codes:
        return

    certificate_filters = []
    if pans:
        certificate_filters.append(LDCCertificateMaster.vendor_pan.in_(pans))
    if vendor_codes:
        certificate_filters.append(LDCCertificateMaster.vendor_code.in_(vendor_codes))

    certificates = db.query(LDCCertificateMaster).filter(
        or_(*certificate_filters),
        LDCCertificateMaster.status == "ACTIVE",
        LDCCertificateMaster.is_verified == True,
    ).all()
    if not certificates:
        return

    # Certificates by PAN and by vendor code, in query order, so each
    # transaction looks up its own instead of scanning every certificate
    # (75k lines x thousands of certificates took minutes). Same matches as
    # comparing each certificate's stripped PAN / vendor code.
    certificates_by_pan: dict[str, list[LDCCertificateMaster]] = defaultdict(list)
    certificates_by_vendor: dict[str, list[LDCCertificateMaster]] = defaultdict(list)
    # Each certificate's section and WTax keys, cleaned once:
    # (section key, WTax key, section key without its "/..." suffix).
    certificate_keys: dict[int, tuple[str, str, str | None]] = {}
    scope_cache: dict[tuple[int, ...], str] = {}
    for cert in certificates:
        certificates_by_pan[(cert.vendor_pan or "").strip().upper()].append(cert)
        certificates_by_vendor[(cert.vendor_code or "").strip()].append(cert)
        section_key = (cert.applicable_tds_section or "").strip().upper()
        wtax_key = (_withholding_key(cert.wtax_type, cert.wtx_code) or "").strip().upper()
        certificate_keys[id(cert)] = (section_key, wtax_key, _normalise_section(section_key))

    for txn in transactions:
        pan = (txn.vendor_pan or "").strip().upper()
        company_code = (txn.company_code or "").strip()
        has_valid_pan = _looks_like_pan(pan)
        expected_section = PAYMENT_TYPE_TO_SECTION.get(_normalise_payment_type(txn.transaction_kind))
        txn_withholding_key = _withholding_key(txn.withholding_tax_type, txn.withholding_tax_code)
        txn_sections = {
            _normalise_section(expected_section),
            _normalise_section(txn.expected_tds_section),
            _normalise_section(txn.tds_applicable_section),
            _normalise_section(txn.tds_deducted_section),
            _normalise_section(txn.tds_legacy_section),
            _normalise_section(txn.tds_raw_section),
            txn_withholding_key,
        }
        txn_sections.discard(None)

        pan_or_vendor_matches = list(
            certificates_by_pan.get(pan, ())
            if has_valid_pan
            else certificates_by_vendor.get((txn.vendor_code or "").strip(), ())
        )
        scoped_matches = [
            cert for cert in pan_or_vendor_matches
            if not cert.company_code or cert.company_code == company_code
        ]
        if txn.vendor_code and not has_valid_pan:
            code_matches = [cert for cert in scoped_matches if cert.vendor_code == txn.vendor_code]
            if code_matches:
                scoped_matches = code_matches
        if pan_or_vendor_matches and not scoped_matches:
            _set_ldc_no_match_reason(
                txn,
                pan_or_vendor_matches,
                f"transaction company {company_code or '—'} does not match the LDC company",
                scope_cache,
            )
            continue
        # Same test as _certificate_section_matches, on the keys cleaned above.
        allowed_keys: set[str] | None = None
        if txn_withholding_key:
            txn_key = txn_withholding_key.strip().upper()
            txn_type, _, txn_code = txn_key.partition("/")
            allowed_keys = {txn_key}
            if txn_code:
                allowed_keys.add(txn_code)
            if txn_type:
                allowed_keys.add(txn_type)

        def certificate_matches_section(cert: LDCCertificateMaster) -> bool:
            section_key, wtax_key, normalised_section = certificate_keys[id(cert)]
            if not section_key and not wtax_key:
                return False
            if allowed_keys is not None:
                return wtax_key in allowed_keys or section_key in allowed_keys or normalised_section in txn_sections
            return section_key in txn_sections or normalised_section in txn_sections

        # The statutory rate depends on the transaction only: look it up once.
        statutory_rate_cache: list[float | None] = []

        def certificate_expected_gap(cert: LDCCertificateMaster) -> float:
            if txn.basic_amount is None or txn.tds_deducted_amount is None:
                return math.inf
            if not statutory_rate_cache:
                statutory_rate_cache.append(
                    _get_rate_for_section(txn.tds_deducted_section, txn)
                    or _get_rate_for_section(txn.tds_legacy_section, txn)
                    or _get_rate_for_section(expected_section, txn)
                )
            statutory_rate = statutory_rate_cache[0]
            if statutory_rate is None or cert.approved_tds_rate is None:
                return math.inf
            expected_rate = statutory_rate * (1 - float(cert.approved_tds_rate) / 100)
            expected_amount = abs(float(txn.basic_amount) * expected_rate / 100)
            return abs(expected_amount - abs(float(txn.tds_deducted_amount)))

        def certificate_priority(cert: LDCCertificateMaster) -> tuple[Any, ...]:
            cert_section_key, cert_wtax_key, _ = certificate_keys[id(cert)]
            exact_key_match = bool(
                txn_withholding_key
                and (
                    cert_section_key == txn_withholding_key
                    or cert_wtax_key == txn_withholding_key
                )
            )
            return (
                0 if exact_key_match else 1,
                0 if certificate_matches_section(cert) else 1,
                0 if cert.company_code else 1,
                certificate_expected_gap(cert),
                cert.valid_from,
                cert.certificate_number,
            )

        section_matches = [cert for cert in scoped_matches if certificate_matches_section(cert)]
        if scoped_matches and not section_matches:
            _set_ldc_no_match_reason(
                txn,
                scoped_matches,
                (
                    f"transaction section/WTax "
                    f"{txn.tds_deducted_section or txn.tds_legacy_section or '—'}"
                    f"/{txn_withholding_key or '—'} does not match the LDC section/WTax"
                ),
                scope_cache,
            )
        matches = [
            cert for cert in section_matches
            if cert.valid_from <= txn.posting_date <= cert.valid_to
        ]

        if not matches:
            matches = [
                cert for cert in scoped_matches
                if cert.valid_from <= txn.posting_date <= cert.valid_to
            ]
        if not matches and section_matches:
            outside_period_matches = [
                cert for cert in section_matches
                if txn.posting_date < cert.valid_from or txn.posting_date > cert.valid_to
            ]
            if outside_period_matches:
                cert = sorted(
                    outside_period_matches,
                    key=lambda item: (
                        min(
                            abs((txn.posting_date - item.valid_from).days),
                            abs((txn.posting_date - item.valid_to).days),
                        ),
                        item.valid_from,
                        item.certificate_number,
                    ),
                )[0]
                _attach_ldc_certificate(txn, cert)
                continue
        if not matches:
            continue

        cert = sorted(
            matches,
            key=certificate_priority,
        )[0]
        _attach_ldc_certificate(txn, cert)


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


# Rows that settle or move an amount already counted on its invoice.
_LDC_NON_CONSUMING_EVENTS = {"PAYMENT", "CLEARING", "TRANSFER_POSTING", "TDS_PAYMENT"}


def _ldc_consumption(txn) -> float | None:
    """
    How much of the certificate limit this row uses. SAP signs amounts by
    debit/credit (an invoice's base is negative on the credit side), so the
    amount's own sign says nothing about direction. Use the size of the base
    and the debit/credit flag instead: credit-side rows (invoices) use the
    limit, debit-side rows (credit memos, invoice reversals) give it back.
    Advances are debit-side but still use the limit. Payments and clearings
    are skipped (None) because their invoice already counted the amount.
    """
    event_type = classify_event(txn)
    if event_type in _LDC_NON_CONSUMING_EVENTS:
        return None
    amount = abs(float(txn.basic_amount))
    if event_type == "ADVANCE_PAYMENT":
        return amount
    side = (txn.debit_credit or "").strip().upper()
    if side == "S":
        return -amount
    if side == "H":
        return amount
    return -amount if event_type == "CREDIT_MEMO" else amount


def _build_ldc_utilization(transactions) -> list[dict[str, Any]]:
    by_certificate: dict[str, dict[str, Any]] = {}
    counted_lines: set[tuple[Any, ...]] = set()

    for txn in transactions:
        if not txn.ldc_exemption_number:
            continue
        if txn.basic_amount is None:
            continue
        # Rows posted outside the validity period carry the nearest
        # certificate only so the expired / not-yet-valid issue can name it;
        # the certificate did not apply to them, so they use none of its limit.
        if txn.ldc_exempt_from and txn.posting_date < txn.ldc_exempt_from:
            continue
        if txn.ldc_exempt_to and txn.posting_date > txn.ldc_exempt_to:
            continue
        # The extract can repeat the same SAP line (same document, line item,
        # withholding type and amounts); count it against the limit once.
        line_key = (
            txn.company_code, txn.fiscal_year, txn.doc_number, txn.line_item_number,
            txn.withholding_tax_type, txn.withholding_tax_code, txn.basic_amount, txn.tds_deducted_amount,
        )
        if txn.line_item_number and line_key in counted_lines:
            continue
        counted_lines.add(line_key)

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
            "_monthlyUsage": {},
            "_vendors": {},
        })
        amount = _ldc_consumption(txn)
        if amount is None:
            continue
        row["used"] += amount
        row["transactions"] += 1
        # One certificate covers every vendor code on the PAN; keep each
        # vendor's share so the UI can show them under the certificate.
        vendor_row = row["_vendors"].setdefault(txn.vendor_code or "—", {
            "vendorId": txn.vendor_code or "—",
            "vendor": txn.vendor_name or txn.vendor_code or "Unknown vendor",
            "used": 0.0,
            "transactions": 0,
        })
        vendor_row["used"] += amount
        vendor_row["transactions"] += 1
        if txn.posting_date:
            month_key = txn.posting_date.strftime("%Y-%m")
            month_label = txn.posting_date.strftime("%b %y")
            month_row = row["_monthlyUsage"].setdefault(month_key, {
                "monthKey": month_key,
                "month": month_label,
                "used": 0.0,
                "transactions": 0,
            })
            month_row["used"] += amount
            month_row["transactions"] += 1

    rows = []
    for row in by_certificate.values():
        monthly_usage = row.pop("_monthlyUsage", {})
        row["vendors"] = sorted(row.pop("_vendors", {}).values(), key=lambda vendor: -vendor["used"])
        row["monthlyUsage"] = [
            monthly_usage[key]
            for key in sorted(monthly_usage)
        ]
        rows.append(row)

    return rows


def _attach_ldc_limits(ldc_utilization: list[dict[str, Any]], db: Session) -> None:
    if not ldc_utilization:
        return

    certificate_numbers = [row["certificateNumber"] for row in ldc_utilization]
    # A certificate has one master row per vendor code, and some of those
    # rows leave the limit blank; keep a row that carries the limit.
    certificates: dict[str, LDCCertificateMaster] = {}
    for cert in db.query(LDCCertificateMaster).filter(
        LDCCertificateMaster.certificate_number.in_(certificate_numbers),
    ).all():
        current = certificates.get(cert.certificate_number)
        if current is None or (current.approved_amount_limit is None and cert.approved_amount_limit is not None):
            certificates[cert.certificate_number] = cert

    for row in ldc_utilization:
        cert = certificates.get(row["certificateNumber"])
        limit = float(cert.approved_amount_limit) if cert and cert.approved_amount_limit is not None else None
        if cert:
            row["validFrom"] = row.get("validFrom") or (cert.valid_from.isoformat() if cert.valid_from else None)
            row["validTo"] = row.get("validTo") or (cert.valid_to.isoformat() if cert.valid_to else None)
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
    if row.get("isReversed") or row.get("reversalDocument"):
        return "REVERSAL"
    event = doc_type_event(doc_type)
    if event:
        return event
    if amount < 0:
        return "REVERSAL"
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
        clearing_doc = str(row.get("clearingDocument") or "").strip()
        open_item = not bool(clearing_doc)
        key = (str(row.get("companyCode") or "").strip(), str(row.get("financialYear") or "").strip(), anchor_doc)
        ledger = ledgers.setdefault(key, {
            "caseId": f"CASE-{key[0] or 'NA'}-{key[1] or 'FY'}-{anchor_doc or 'UNLINKED'}",
            "groupType": "CLEARING" if clearing_doc else "OPEN_DOCUMENT",
            "openItem": open_item,
            "anchorDocNo": anchor_doc or "—",
            "clearingDocument": clearing_doc or "—",
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
            "adjustmentAmount": 0.0,
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
        else:
            ledger["adjustmentAmount"] += amount
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
        adjustments = (
            ledger["paymentAmount"]
            + ledger["creditAmount"]
            + ledger["reversalAmount"]
            + ledger["adjustmentAmount"]
        )
        ledger["openAmount"] = max(0.0, gross_base - adjustments)
        ledger["status"] = "ISSUE" if ledger["issueCount"] else "OPEN" if ledger.get("openItem") else "CLOSED" if ledger["openAmount"] == 0 and gross_base > 0 else "OPEN"
        case_ledgers.append(ledger)

    return sorted(case_ledgers, key=lambda item: (item.get("status") != "ISSUE", item.get("anchorDocNo") or ""))



def ledger_event(txn, event_type: str, tds_note: str | None) -> dict[str, Any]:
    """One transaction line as shown in the Document / GL Ledger (issues added by the caller)."""
    tds_base_amount = txn.basic_amount
    applied_rate = _effective_applied_rate(tds_base_amount, txn.tds_deducted_amount)
    if applied_rate is None:
        applied_rate = txn.tds_deducted_rate
    ldc_exemption_rate = _ldc_exemption_for_posting(txn)
    return {
        "docNo": (txn.doc_number or "").strip() or "—",
        "lineItem": txn.line_item_number or "—",
        "docType": txn.doc_type or "—",
        "assignmentNumber": txn.assignment_number or "—",
        "eventType": event_type,
        "postingDate": txn.posting_date.isoformat() if txn.posting_date else "—",
        "glAccount": txn.gl_account or "—",
        "profitCenter": txn.profit_center or "—",
        "debitCredit": txn.debit_credit or "—",
        "amount": float(txn.bill_amount or 0.0),
        "baseAmount": tds_base_amount,
        "tdsSection": txn.tds_new_section or txn.tds_legacy_section or txn.tds_deducted_section or "—",
        "legacySection": txn.tds_legacy_section or txn.tds_deducted_section,
        "newSection": txn.tds_new_section,
        "tdsRate": applied_rate,
        # Rate exactly as SAP reported it (rate column / TDS description), never derived.
        "sapRate": txn.tds_deducted_rate,
        # LDC exemption % from the certificate (None outside its validity).
        "ldcRate": ldc_exemption_rate,
        # Rate the rules expect once that exemption is applied (statutory
        # rate × (100 − exemption)/100, or an explicit approved rate).
        "ldcExpectedRate": _get_applicable_rate(txn) if ldc_exemption_rate is not None else None,
        "ldcCertificate": txn.ldc_exemption_number,
        "tdsAmount": abs(float(txn.tds_deducted_amount or 0.0)),
        "tdsNote": tds_note,
        # No TDS is due on this line itself, so the UI skips its rate check:
        # an advance adjustment (TDS was taken when the advance was paid), a
        # clearing entry (AB) or a transfer posting (TP/TM).
        "rateCheckNotApplicable": bool(
            _is_advance_clearing_adjustment(txn)
            or (txn.doc_type or "").strip().upper() in {"AB", "TP", "TM"}
        ),
        "referenceDoc": txn.invoice_reference_document or txn.advance_document_reference or "—",
    }


def _build_case_ledger_from_transactions(transactions, issues: list[dict[str, Any]], tds_notes: dict[int, str] | None = None) -> list[dict[str, Any]]:
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

        open_item = not bool(clearing_doc)
        fallback_group_type = "REFERENCE" if reference_doc else "ASSIGNMENT" if assignment_number else "DOCUMENT"
        group_type = "CLEARING" if clearing_doc else f"OPEN_{fallback_group_type}"
        anchor_doc = clearing_doc or reference_doc or assignment_number or doc_no or f"ROW-{row_number}"
        is_self_clearing_row = bool(clearing_doc and doc_no and clearing_doc == doc_no)
        key = (company_code, fiscal_year, anchor_doc)
        ledger = ledgers.setdefault(key, {
            "caseId": f"LEDGER-{key[0] or 'NA'}-{key[1] or 'FY'}-{key[2]}",
            "groupType": group_type,
            "openItem": open_item,
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
            "baseAmount": 0.0,
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
        elif event_type == "ADVANCE_PAYMENT" and not is_self_clearing_row:
            ledger["advanceAmount"] += amount
        elif event_type == "PAYMENT":
            ledger["paymentAmount"] += amount
        else:
            ledger["adjustmentAmount"] += amount

        doc_issues = issues_by_doc.get(doc_no, [])
        tds_amount = abs(float(txn.tds_deducted_amount or 0.0))
        tds_base_amount = txn.basic_amount
        if event_type in {"INVOICE", "ADVANCE_PAYMENT"} and tds_base_amount is not None:
            ledger["baseAmount"] += abs(float(tds_base_amount))
        ledger["tdsAmount"] += tds_amount
        ledger["eventCount"] += 1
        ledger["issueCount"] += len(doc_issues)
        ledger["events"].append({
            **ledger_event(txn, event_type, (tds_notes or {}).get(id(txn))),
            "issues": [issue.get("category") for issue in doc_issues],
        })

    case_ledgers = []
    for ledger in ledgers.values():
        ledger["openAmount"] = round(ledger["invoiceAmount"] + ledger["advanceAmount"] - ledger["paymentAmount"] - ledger["adjustmentAmount"], 2)
        ledger["netAmount"] = round(ledger["netAmount"], 2)
        # A clearing group holding only the clearing document's own lines nets to
        # zero by itself; what it settles is not in this file, so it is not balanced.
        clearing_only = ledger["groupType"] == "CLEARING" and not any(
            event["docNo"] != ledger["anchorDocNo"] for event in ledger["events"]
        )
        ledger["status"] = (
            "ISSUE" if ledger["issueCount"]
            else "CLEARING_ONLY" if clearing_only
            else "OPEN" if ledger.get("openItem")
            else "BALANCED" if abs(ledger["netAmount"]) <= 1 else "OPEN"
        )
        case_ledgers.append(ledger)

    return sorted(case_ledgers, key=lambda item: (item.get("status") != "ISSUE", item.get("anchorDocNo") or ""))

def _read_excel_fast(content: bytes) -> pd.DataFrame:
    # calamine (Rust) reads large workbooks ~6x faster than openpyxl and gives
    # the same frame; openpyxl stays as the fallback if it is unavailable or
    # trips on an unusual workbook.
    try:
        return pd.read_excel(BytesIO(content), engine="calamine")
    except Exception:
        return pd.read_excel(BytesIO(content), engine="openpyxl")


def _read_upload(filename: str, content: bytes) -> pd.DataFrame:
    suffix = Path(filename).suffix.lower()
    if suffix == ".csv":
        try:
            return pd.read_csv(BytesIO(content), low_memory=False)
        except UnicodeDecodeError:
            return pd.read_csv(BytesIO(content), encoding="latin-1", low_memory=False)

    try:
        # openpyxl supports both .xlsx and macro-enabled .xlsm workbooks.
        # Legacy .xls requires xlrd, which is intentionally not a dependency.
        if suffix == ".xls":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Legacy .xls files are not supported yet. Save the file as .xlsx and upload it again.",
            )
        return _read_excel_fast(content)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Could not read the spreadsheet. Ensure the first worksheet has a header row and is not password protected.",
        ) from exc


def _present_aliases(columns: list[str], internal_name: str) -> set[str]:
    exact_matches = set(COLUMN_ALIASES[internal_name]).intersection(columns)
    if exact_matches:
        return exact_matches

    normalised_columns = {
        "".join(ch for ch in column.lower() if ch.isalnum())
        for column in columns
    }
    return {
        alias for alias in COLUMN_ALIASES[internal_name]
        if "".join(ch for ch in alias.lower() if ch.isalnum()) in normalised_columns
    }


def _validate_headers(columns: list[str]) -> None:
    # These are the minimum values needed to identify a transaction and run
    # a TDS rule. Other fields are optional and enable more specific checks.
    missing = []
    if not _present_aliases(columns, "posting_date"):
        missing.append("Posting_Date")
    has_tds_section = bool(_present_aliases(columns, "tds_section"))
    has_withholding_pair = bool(
        _present_aliases(columns, "withholding_tax_type")
        and _present_aliases(columns, "withholding_tax_code")
    )
    if not (has_tds_section or has_withholding_pair):
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


def _ldc_exemption_for_posting(txn) -> float | None:
    """LDC exemption % when a certificate covers this row's posting date, else None.

    LDC master values are exemption percentages (see _attach_ldc_certificate):
    60 means TDS is reduced by 60%, 100 means nil TDS, 0 means no relief.
    """
    if not txn.ldc_exemption_number or txn.ldc_exemption_percent is None:
        return None
    if txn.posting_date and (
        (txn.ldc_exempt_from and txn.posting_date < txn.ldc_exempt_from)
        or (txn.ldc_exempt_to and txn.posting_date > txn.ldc_exempt_to)
    ):
        return None
    return float(txn.ldc_exemption_percent)


def _effective_applied_rate(base_amount: float | None, tds_amount: float | None) -> float | None:
    if base_amount is None:
        return None
    try:
        # Invoices are on the credit side, so SAP gives their base as a negative amount.
        base = abs(float(base_amount))
    except (TypeError, ValueError):
        return None
    if base == 0:
        return None

    tds = abs(float(tds_amount or 0.0))
    return round((tds / base) * 100, 4)


CORRECTION_MISMATCH_CATEGORY = "Correction Entry — TDS Mismatch"


def _check_correction_lines(correction_lines, issue_txns, db: Session) -> tuple[dict[int, tuple[str, Any]], set[tuple[str, str]]]:
    """Own-TDS check for correction entries, which the single-row rules skip.

    Returns (results, flagged_docs): results maps id(txn) -> ("passed" | "skipped",
    reason) or ("issue", TDSIssue); flagged_docs holds (company, doc) of
    documents with an issue in this run or an earlier one.

    * no TDS on the entry (e.g. a credit memo cancelling an invoice): nothing of
      its own to check; its effect is applied to the original's issue;
    * TDS = base x expected rate (within Rs 1): passed;
    * TDS differs, but the original document has its own issue (this run or an
      earlier one): the entry follows the original and is explained there;
    * TDS differs with nothing to explain it: an issue on the entry itself.
    """
    flagged_docs = {
        ((txn.company_code or "").strip(), (txn.doc_number or "").strip()) for txn in issue_txns
    }
    references = list({
        ((txn.company_code or "").strip(), str(txn.invoice_reference_document).strip()) for txn in correction_lines
    })
    for start in range(0, len(references), 500):
        rows = db.query(TrackedIssue.company_code, TrackedIssue.doc_no).filter(
            tuple_(TrackedIssue.company_code, TrackedIssue.doc_no).in_(references[start:start + 500])
        )
        flagged_docs.update((row.company_code, row.doc_no) for row in rows)

    results: dict[int, tuple[str, Any]] = {}
    for txn in correction_lines:
        reference = str(txn.invoice_reference_document).strip()
        tds = abs(float(txn.tds_deducted_amount or 0.0))
        base = abs(float(_get_tds_base_amount(txn) or 0.0))
        rate = _get_applicable_rate(txn)
        original_flagged = ((txn.company_code or "").strip(), reference) in flagged_docs
        if tds <= 0:
            results[id(txn)] = ("skipped", (
                f"Correction entry for document {reference} with no TDS of its own; "
                f"its effect is applied to {reference}'s issue."
            ) if original_flagged else (
                f"Correction entry (credit note / reversal) for document {reference} with no TDS on it. "
                f"No TDS issue is recorded for {reference}, and whether its TDS should be reversed by this entry is not checked."
            ))
            continue
        if not base or rate is None:
            results[id(txn)] = ("skipped", (
                f"Correction entry for document {reference}; no base amount or expected rate to check its TDS against."
            ))
            continue
        expected = base * rate / 100
        if abs(expected - tds) <= 1:
            results[id(txn)] = ("passed", (
                f"Correction entry for document {reference}: TDS {tds:,.2f} at {rate:g}% on base "
                f"{base:,.2f} matches the expected rate."
            ))
        elif original_flagged:
            results[id(txn)] = ("skipped", (
                f"Correction entry for document {reference}: its TDS ({tds:,.2f}) follows {reference}, "
                f"which has its own issue; checked there."
            ))
        else:
            results[id(txn)] = ("issue", TDSIssue(
                category=CORRECTION_MISMATCH_CATEGORY,
                message=(
                    f"Correction entry for document {reference} carries TDS {tds:,.2f} on base {base:,.2f}; "
                    f"at the expected {rate:g}% it should be {expected:,.2f}."
                ),
                severity="medium",
                expected_rate=rate,
            ))
    return results, flagged_docs


def _mark_corrected_rows(issues, issue_txns, transactions, validation_rows) -> int:
    """Turn 'issue' rows into 'corrected' when every issue on them is resolved."""
    resolved: dict[int, list[dict[str, Any]]] = {}
    still_open: set[int] = set()
    for issue, txn in zip(issues, issue_txns):
        if issue.get("status") == "resolved":
            resolved.setdefault(id(txn), []).append(issue)
        else:
            still_open.add(id(txn))
    rows_by_txn = {id(txn): row for txn, row in zip(transactions, validation_rows)}
    count = 0
    for txn_id, row_issues in resolved.items():
        row = rows_by_txn.get(txn_id)
        if txn_id in still_open or row is None or row["status"] != "issue":
            continue
        first = row_issues[0]
        row["status"] = "corrected"
        row["originalReason"] = row["reason"]
        # Severity of the issue before it was resolved, for the Review drawer.
        row["originalSeverity"] = first.get("severity")
        row["reason"] = first.get("resolutionNote") or "Resolved in the issue history."
        row["resolutionType"] = first.get("resolutionType")
        row["correctionDocs"] = first.get("correctionDocs")
        count += 1
    return count


def correction_original_status(issues: list[Any]) -> str | None:
    """Where a correction entry's original document stands now, from its saved issues.

    'resolved' when every issue on it is resolved, 'partial' when one is still
    open but a correction was already applied to it (a shortfall remains),
    'open' otherwise; None when the original has no saved issue.
    """
    if not issues:
        return None
    if all(issue.status == "resolved" for issue in issues):
        return "resolved"
    if any(issue.status != "resolved" and (issue.correction_docs or issue.remaining_shortfall is not None) for issue in issues):
        return "partial"
    return "open"


def _mark_correction_originals(db: Session, validation_rows: list[dict[str, Any]]) -> None:
    """Tell each correction row (credit note, TDS top-up, reversal) how its original stands now.

    Read from the issue history after this run updated it, so an original
    from an earlier file counts too (invoices one day, corrections the next).
    """
    rows = [row for row in validation_rows if row.get("rowKind") == "correction" and row.get("correctionOf")]
    keys = list({(str(row.get("companyCode") or "").strip(), str(row["correctionOf"]).strip()) for row in rows})
    found: dict[tuple[str, str], list[Any]] = {}
    for start in range(0, len(keys), 500):
        query = db.query(
            TrackedIssue.company_code, TrackedIssue.doc_no, TrackedIssue.status,
            TrackedIssue.correction_docs, TrackedIssue.remaining_shortfall,
        ).filter(tuple_(TrackedIssue.company_code, TrackedIssue.doc_no).in_(keys[start:start + 500]))
        for issue in query:
            found.setdefault((issue.company_code, issue.doc_no), []).append(issue)
    for row in rows:
        status = correction_original_status(found.get((str(row.get("companyCode") or "").strip(), str(row["correctionOf"]).strip()), []))
        if status:
            row["correctionOriginalStatus"] = status


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
    # Bill amount is retained for display when SAP did not provide a taxable
    # base. It is never used to calculate tax impact or rule outcomes.
    base_amount = _get_tds_base_amount(txn)
    if base_amount is None:
        base_amount = txn.basic_amount if txn.basic_amount is not None else txn.bill_amount
    applied_rate = _effective_applied_rate(base_amount, txn.tds_deducted_amount)
    if applied_rate is None:
        applied_rate = txn.tds_deducted_rate
    tax_impact = 0.0
    tax_base_amount = _get_tds_base_amount(txn)
    # SAP sends no base for a row with no TDS; the rule may have estimated one
    # (Possible Missed TDS Deduction), so expected TDS / tax impact are not ₹0.
    estimated_base = getattr(rule_issue, "estimated_base", None)
    if not tax_base_amount and estimated_base:
        tax_base_amount = estimated_base
        base_amount = estimated_base
    if tax_base_amount is not None and expected_rate is not None:
        expected_tds = abs(float(tax_base_amount) * expected_rate / 100)
        actual_tds = abs(float(txn.tds_deducted_amount or 0.0))
        tax_impact = abs(expected_tds - actual_tds)
        
    category = rule_issue.category
    recommended_action = "Review the transaction and correct the TDS entry where required."
    if category == "LDC Not Yet Valid":
        recommended_action = "LDC exists, but the transaction date is before the certificate validity period, so LDC is not applied. Normal TDS is expected for this transaction date."
    elif category == "LDC Expired":
        recommended_action = "LDC exists, but the transaction date is after the certificate validity period, so LDC is not applied. Normal TDS is expected for this transaction date."
    effective_section = (
        txn.tds_new_section
        if txn.posting_date >= NEW_ACT_EFFECTIVE_DATE and txn.tds_new_section
        else rule_issue.expected_section
        or txn.expected_tds_section
        or txn.tds_legacy_section
        or txn.tds_deducted_section
        or txn.tds_new_section
        or "—"
    )
    return {
        "id": f"UPL-{issue_id:06d}",
        # Same value in every run for the same issue on the same SAP line;
        # the issue history (tracked_issues) is keyed on it.
        "issueKey": build_issue_key(txn, category),
        "fiscalYear": fiscal_year_for(txn),
        "docNo": txn.doc_number or "—",
        "lineItem": txn.line_item_number,
        "assignmentNumber": txn.assignment_number,
        "docType": txn.doc_type or "—",
        "companyCode": txn.company_code or None,
        "vendor": txn.vendor_name or txn.vendor_code or "Unknown vendor",
        "vendorId": txn.vendor_code or "—",
        "vendorPan": txn.vendor_pan or "—",
        # Keep the new-law source reference and legacy compatibility key side
        # by side. `section` is date-effective and is the table/filter label.
        "section": effective_section,
        "newSection": txn.tds_new_section,
        "legacySection": txn.tds_legacy_section or txn.tds_deducted_section,
        "ruleSection": rule_issue.expected_section or txn.expected_tds_section or txn.tds_deducted_section,
        "glAccount": txn.gl_account,
        "profitCenter": txn.profit_center,
        "source": "GL" if txn.expected_tds_section or txn.gl_tds_applicability else "SAP",
        "baseAmount": base_amount,
        "tdsAmount": txn.tds_deducted_amount or 0.0,
        "expectedRate": expected_rate,
        "appliedRate": applied_rate,
        "ldcCertificate": txn.ldc_exemption_number,
        "ldcExemptionPercent": txn.ldc_exemption_percent,
        "ldcValidFrom": txn.ldc_exempt_from.isoformat() if txn.ldc_exempt_from else None,
        "ldcValidTo": txn.ldc_exempt_to.isoformat() if txn.ldc_exempt_to else None,
        "withholdingTaxType": txn.withholding_tax_type,
        "withholdingTaxCode": txn.withholding_tax_code,
        "taxImpact": round(tax_impact, 2),
        "issueType": ISSUE_TYPE_BY_CATEGORY.get(category, "OTHER"),
        "issueTypeLabel": category,
        "category": category,
        "isViolation": rule_issue.severity != "low",
        "severity": rule_issue.severity,
        "status": "open",
        "date": txn.posting_date.isoformat(),
        "postingDate": txn.posting_date.isoformat(),
        "documentDate": txn.bill_date.isoformat() if txn.bill_date else None,
        # The UI also reads this as plainEnglish; issuesSlice fills that in so
        # the same text is not sent twice per issue.
        "description": rule_issue.message,
        "recommendedAction": recommended_action,
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


# Vendor Threshold Tracker disabled: the Threshold Monitoring page now shows
# only the LDC tracker, so this per-vendor/section summary is no longer built
# on upload. Uncomment it and its two call sites to restore the tracker.
# def _threshold_vendor_summaries(transactions) -> list[dict[str, Any]]:
#     grouped: dict[str, dict[str, Any]] = {}
#
#     for txn in transactions:
#         section = _threshold_section_for_transaction(txn)
#         pan = txn.vendor_pan or "—"
#         financial_year = _get_financial_year(txn.posting_date) if txn.posting_date else None
#         company_code = (txn.company_code or "").strip()
#         key = f"{company_code}||{financial_year or ''}||{pan}||{section}"
#         base_amount = _get_tds_base_amount(txn)
#         if base_amount is None:
#             base_amount = txn.basic_amount if txn.basic_amount is not None else txn.bill_amount
#
#         if key not in grouped:
#             grouped[key] = {
#                 "id": key,
#                 "companyCode": txn.company_code or None,
#                 "financialYear": financial_year,
#                 "name": txn.vendor_name or txn.vendor_code or "Unknown vendor",
#                 "vendorId": pan,
#                 "vendorCodes": [],
#                 "vendorNames": [],
#                 "pan": pan,
#                 "section": section,
#                 "currentAmount": 0.0,
#                 "rowCount": 0,
#             }
#
#         vendor_code = txn.vendor_code or "—"
#         vendor_name = txn.vendor_name or txn.vendor_code or "Unknown vendor"
#         if vendor_code not in grouped[key]["vendorCodes"]:
#             grouped[key]["vendorCodes"].append(vendor_code)
#         if vendor_name not in grouped[key]["vendorNames"]:
#             grouped[key]["vendorNames"].append(vendor_name)
#         grouped[key]["currentAmount"] += float(base_amount or 0)
#         grouped[key]["rowCount"] += 1
#
#     for row in grouped.values():
#         if row["vendorNames"]:
#             row["name"] = " / ".join(row["vendorNames"][:2])
#             if len(row["vendorNames"]) > 2:
#                 row["name"] += f" +{len(row['vendorNames']) - 2}"
#
#     return sorted(
#         grouped.values(),
#         key=lambda row: (row["pan"], row["section"]),
#     )


def _transaction_validation_row(txn, status: str, reason: str, row_index: int, tds_note: str | None = None) -> dict[str, Any]:
    base_amount = _get_tds_base_amount(txn)
    if base_amount is None:
        base_amount = txn.basic_amount if txn.basic_amount is not None else txn.bill_amount
    applied_rate = _effective_applied_rate(base_amount, txn.tds_deducted_amount)
    if applied_rate is None:
        applied_rate = txn.tds_deducted_rate
    expected_rate = _get_applicable_rate(txn)
    section = (txn.tds_deducted_section or txn.tds_legacy_section or "").strip().upper()
    has_ldc_rate = txn.ldc_exemption_percent is not None or txn.ldc_approved_rate is not None
    if not has_ldc_rate and section == "194J" and txn.tds_deducted_rate in SECTION_194J_VALID_RATES:
        expected_rate = txn.tds_deducted_rate
    # Rent whose nature SAP does not state: 2% and 10% are both accepted.
    if expected_rate is None and section == "194I" and txn.tds_deducted_rate in SECTION_194I_VALID_RATES:
        expected_rate = txn.tds_deducted_rate

    return {
        "id": f"{status}:{row_index}:{txn.doc_number}:{txn.vendor_code}:{_threshold_section_for_transaction(txn)}",
        # Position in this upload; each issue carries its row's rowIndex so the
        # UI pairs them exactly (an issue's amounts can differ from its row's).
        "rowIndex": row_index,
        "status": status,
        "reason": reason,
        "docNo": txn.doc_number or "—",
        "fiscalYear": fiscal_year_for(txn),
        "lineItem": txn.line_item_number,
        "assignmentNumber": txn.assignment_number,
        "withholdingTaxType": txn.withholding_tax_type,
        "withholdingTaxCode": txn.withholding_tax_code,
        "poNo": txn.po_no or "—",
        "docType": txn.doc_type or "—",
        "companyCode": txn.company_code or None,
        "vendor": txn.vendor_name or txn.vendor_code or "Unknown vendor",
        "vendorId": txn.vendor_code or "—",
        "vendorPan": txn.vendor_pan or "—",
        "profitCenter": txn.profit_center,
        "section": _threshold_section_for_transaction(txn),
        "billAmount": txn.bill_amount,
        "baseAmount": base_amount,
        "tdsAmount": txn.tds_deducted_amount or 0.0,
        "tdsNote": tds_note,
        "appliedRate": applied_rate,
        "expectedRate": expected_rate,
        "ldcCertificate": txn.ldc_exemption_number,
        "ldcExemptionPercent": txn.ldc_exemption_percent,
        "ldcValidFrom": txn.ldc_exempt_from.isoformat() if txn.ldc_exempt_from else None,
        "ldcValidTo": txn.ldc_exempt_to.isoformat() if txn.ldc_exempt_to else None,
        "date": txn.posting_date.isoformat(),
        "postingDate": txn.posting_date.isoformat(),
        "documentDate": txn.bill_date.isoformat() if txn.bill_date else None,
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


def _blank_or_zero_amount(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str) and not value.strip():
        return True
    try:
        return float(value) == 0.0
    except (TypeError, ValueError):
        return False


def _blank_or_zero_section(value: Any) -> bool:
    text = str(value or "").strip()
    if not text or text in {"-", "—"}:
        return True
    try:
        return float(text) == 0.0
    except ValueError:
        return False


def _has_tds_section_signal(txn) -> bool:
    return not all(_blank_or_zero_section(value) for value in (
        txn.tds_raw_section,
        txn.tds_deducted_section,
        txn.tds_legacy_section,
        txn.tds_new_section,
        txn.tds_applicable_section,
    ))


PAYMENT_AGAINST_INVOICE_REASON = "Payment against invoice — TDS is deducted when the invoice is booked, not at payment."


def _is_payment_against_invoice_without_tds(txn) -> bool:
    """A plain (non-advance) payment carrying no TDS: nothing is due on it.

    Its TDS belongs to the invoice it pays, so it passes even when SAP gives
    the payment no section or base (it is not "insufficient data").
    """
    return (
        classify_event(txn) == "PAYMENT"
        and not txn.is_advance_payment
        and _blank_or_zero_amount(txn.tds_deducted_amount)
    )


def _is_skipped_non_tds_document_without_tds_amounts(txn) -> bool:
    doc_type = (txn.doc_type or "").strip().upper()
    if doc_type in ALWAYS_VALIDATE_DOC_TYPES:
        return False
    return (
        doc_type in NON_TDS_DEDUCTION_DOC_TYPES
        and not _has_tds_section_signal(txn)
        and _blank_or_zero_amount(txn.tds_deducted_amount)
    )


def _skipped_non_tds_document_reason(txn) -> str:
    doc_type = (txn.doc_type or "").strip().upper() or "—"
    description = NON_TDS_DEDUCTION_DOC_TYPES.get(doc_type, "non-TDS supporting document")
    return (
        f"Document Type {doc_type} ({description}) is configured as skip-eligible, "
        "and both TDS section and TDS amount are blank/zero; "
        "excluded from TDS validation."
    )


def _is_zero_base_invoice_without_tds(txn) -> bool:
    """Invoice row where SAP left TDS section/rate/base blank and no TDS was deducted.

    These rows are excluded from row-level checks (no base to rate-check), but
    they are exactly the rows where TDS may have been missed, so they still go
    to the batch missing-deduction check.
    """
    return (
        _has_zero_base_amount(txn)
        and not _is_skipped_non_tds_document_without_tds_amounts(txn)
        and classify_event(txn) == "INVOICE"
        and _blank_or_zero_amount(txn.tds_deducted_amount)
    )


def _ldc_advance_chains(transactions):
    """LDC-covered invoices that have advances against them.

    Returns ({id(invoice): (invoice, advances)}, ids of every invoice and
    advance in those chains). The chain is judged once, on the invoice.
    """
    chains = {
        id(invoice): (invoice, advances)
        for invoice, advances in link_advances_to_invoices(transactions)
        if ldc_decides_transaction(invoice)
    }
    members = {id(invoice) for invoice, _ in chains.values()}
    members.update(id(advance) for _, advances in chains.values() for advance in advances)
    return chains, members


def _row_checks(txn, ldc_chains, ldc_chain_members):
    """Per-row checks as a decision flow:

    LDC covers the invoice → with advances: judge advance + invoice together;
                             without: judge the invoice alone (run_all_checks
                             runs LDC first and stops there).
    Advance inside an LDC chain → nothing here; judged with its invoice.
    Otherwise → the normal checks.
    """
    if id(txn) in ldc_chains:
        return [check_ldc_advance_chain(*ldc_chains[id(txn)])]
    if id(txn) in ldc_chain_members:
        return []
    return run_all_checks(txn)


def _skip_ldc_decided(results, ldc_chain_members=frozenset()):
    """Drop batch-check results for rows the LDC check already decided.

    Batch checks still see every row (threshold totals need them all); only
    their findings on LDC-covered rows, or on rows in an LDC advance chain,
    are dropped, since LDC runs first.
    """
    return [
        (txn, rule_issue) for txn, rule_issue in results
        if not ldc_decides_transaction(txn) and id(txn) not in ldc_chain_members
    ]


def _missing_deduction_candidates(transactions, issue_eligible_transactions) -> list[Any]:
    eligible_ids = {id(txn) for txn in issue_eligible_transactions}
    return issue_eligible_transactions + [
        txn for txn in transactions
        if id(txn) not in eligible_ids and _is_zero_base_invoice_without_tds(txn)
    ]


def _threshold_limits(section: str | None) -> tuple[float | None, float | None]:
    """Return (aggregate limit, single-bill limit) for a section.

    The aggregate is per FY, or per month for rent (see threshold_period).
    """
    section_config = SECTIONS.get(section or "")
    if not section_config:
        return None, None
    threshold_config = section_config.get("threshold")
    if isinstance(threshold_config, dict):
        aggregate = (
            threshold_config.get("aggregate_fy")
            or threshold_config.get("others")
            or threshold_config.get("bank_post_office")
        )
        return aggregate, threshold_config.get("single_contract")
    return threshold_config, None


def _note_amount(txn) -> float:
    if txn.basic_amount:
        return abs(float(txn.basic_amount))
    return abs(float(txn.bill_amount or 0.0))


def _ldc_covers_posting_date(txn) -> bool:
    return bool(
        txn.ldc_exemption_number
        and txn.ldc_exempt_from and txn.ldc_exempt_to and txn.posting_date
        and txn.ldc_exempt_from <= txn.posting_date <= txn.ldc_exempt_to
    )


def _nil_rate_ldc_without_tds(txn) -> bool:
    """No TDS deducted and a 100%-exemption (nil) LDC certificate covers the posting date.

    Zero TDS is then correct by certificate, even when SAP left the section,
    rate or base blank, so the row is not "insufficient data".
    """
    return (
        _blank_or_zero_amount(txn.tds_deducted_amount)
        and _ldc_covers_posting_date(txn)
        and (_ldc_exemption_for_posting(txn) or 0) >= 100
    )


def _cannot_verify_note(txn) -> str:
    """Say exactly which SAP value is missing, instead of a generic message."""
    no_signal = not _has_validation_signal(txn)
    zero_base = _has_zero_base_amount(txn)
    if no_signal and zero_base:
        return "Cannot verify — SAP has no TDS section, rate or payment type, and the base amount is ₹0."
    if zero_base:
        return "Cannot verify — base amount is ₹0 in SAP, so the expected TDS cannot be calculated."
    return "Cannot verify — SAP has no TDS section, rate or payment type for this row."


def _build_tds_notes(transactions, issue_reasons_by_transaction_id: dict[int, str]) -> dict[int, str]:
    """Plain-language reason for every row where no TDS was deducted.

    Display-only: explains why zero TDS is acceptable (or not). It does not
    change any rule result.
    """
    tds_by_doc: dict[str, float] = defaultdict(float)
    cumulative_by_group: dict[tuple[str, str, str], float] = defaultdict(float)
    for txn in transactions:
        tds_by_doc[str(txn.doc_number or "").strip().lstrip("0")] += abs(float(txn.tds_deducted_amount or 0.0))
        section = _expected_section(txn)
        if (
            txn.vendor_pan and section and txn.posting_date
            and classify_event(txn) in {"INVOICE", "ADVANCE_PAYMENT"}
            and not _is_advance_clearing_adjustment(txn)
        ):
            group_key = (txn.vendor_pan.strip().upper(), section, threshold_period(section, txn.posting_date))
            cumulative_by_group[group_key] += _note_amount(txn)

    notes: dict[int, str] = {}
    for txn in transactions:
        if not _blank_or_zero_amount(txn.tds_deducted_amount):
            continue

        issue_reason = issue_reasons_by_transaction_id.get(id(txn))
        if issue_reason:
            notes[id(txn)] = f"Not correct — flagged as: {issue_reason}."
            continue

        doc_type = (txn.doc_type or "").strip().upper()
        if _is_advance_clearing_adjustment(txn):
            reference = str(txn.invoice_reference_document or "").strip()
            advance_tds = tds_by_doc.get(reference.lstrip("0"), 0.0)
            notes[id(txn)] = (
                f"Advance adjustment — TDS of ₹{advance_tds:,.2f} was already deducted when advance {reference} was paid."
                if advance_tds > 0
                else f"Advance adjustment — linked advance {reference or '—'} also shows no TDS; check the advance."
            )
            continue
        if doc_type == "AB":
            notes[id(txn)] = "Clearing entry — only matches and settles documents; not a TDS event."
            continue
        if doc_type in {"TP", "TM"}:
            notes[id(txn)] = "Transfer posting — amount moved between accounts; no purchase or payment, so no TDS."
            continue
        if _is_skipped_non_tds_document_without_tds_amounts(txn):
            description = NON_TDS_DEDUCTION_DOC_TYPES.get(doc_type, "Supporting document")
            notes[id(txn)] = f"{description} ({doc_type}) — accounting entry, not a TDS event."
            continue
        if classify_event(txn) == "PAYMENT" and not txn.is_advance_payment:
            notes[id(txn)] = PAYMENT_AGAINST_INVOICE_REASON
            continue
        if _ldc_covers_posting_date(txn):
            period = f"{_format_display_date(txn.ldc_exempt_from)} to {_format_display_date(txn.ldc_exempt_to)}"
            exemption = _ldc_exemption_for_posting(txn) or 0.0
            certificate = f"LDC certificate {txn.ldc_exemption_number} ({exemption:g}% exemption, {period})"
            expected_rate = _get_applicable_rate(txn)
            expected_text = f"{expected_rate:.2f}%" if expected_rate is not None else None
            if exemption >= 100:
                notes[id(txn)] = f"{certificate} — nil TDS, no deduction required."
            elif _has_zero_base_amount(txn) or not _has_validation_signal(txn):
                notes[id(txn)] = (
                    f"{certificate} — expected TDS {expected_text}, but SAP has no base amount/section for this row — cannot verify."
                    if expected_text
                    else f"{certificate} — SAP has no section/base for this row, so the expected rate cannot be worked out — cannot verify."
                )
            else:
                notes[id(txn)] = (
                    f"{certificate} — {expected_text or 'reduced'} TDS expected, but none was deducted — please review."
                )
            continue

        section = _expected_section(txn)
        aggregate_limit, single_limit = _threshold_limits(section)
        if txn.vendor_pan and section and aggregate_limit and txn.posting_date:
            period = threshold_period(section, txn.posting_date)
            group_key = (txn.vendor_pan.strip().upper(), section, period)
            cumulative = cumulative_by_group.get(group_key, 0.0)
            this_amount = _note_amount(txn)
            if cumulative < aggregate_limit and (single_limit is None or this_amount < single_limit):
                single_text = f" and this bill ₹{this_amount:,.2f} is under the single-bill limit ₹{single_limit:,.2f}" if single_limit else ""
                notes[id(txn)] = (
                    f"Below threshold for {section} — vendor's total ₹{cumulative:,.2f} in {period} "
                    f"is under ₹{aggregate_limit:,.2f}{single_text}."
                )
                continue

        if _has_zero_base_amount(txn) or not _has_validation_signal(txn):
            notes[id(txn)] = _cannot_verify_note(txn)
            continue

        notes[id(txn)] = "No TDS deducted and no rule flagged it — please review."

    return notes


class _FastJSONResponse(JSONResponse):
    """JSON response that skips FastAPI's per-value ``jsonable_encoder`` walk.

    Upload results hold hundreds of thousands of plain dicts/strings/numbers,
    and walking them in Python took longer than the analysis itself. Only the
    few non-native values (dates, Decimals, ...) go through jsonable_encoder.
    """

    def render(self, content: Any) -> bytes:
        return json.dumps(
            content,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            default=jsonable_encoder,
        ).encode("utf-8")


@dataclass
class AnalysisBatch:
    """One batch of a large SAP data API pull (services/sap_analysis_job.py).

    The pull is cut into batches that share no vendor, PAN or document, so
    each batch's rules see everything they compare against. What still spans
    batches is worked out over the whole pull first and passed in.
    """

    # Every batch of the pull is saved under this one run (None: the first creates it).
    run_id: int | None = None
    # Whether the whole pull has descriptive TDS section text (picks the translator).
    descriptive: bool | None = None
    # Each GL's TDS pattern over the whole pull (rules.missing_deduction_gl_stats).
    gl_stats: dict | None = None
    # Build the rows the browser shows (validation rows, document ledger).
    respond: bool = False


def prepare_records(frame: pd.DataFrame, *, company_code: str, current_user: User, db: Session) -> tuple[list[dict[str, Any]], int, int]:
    """SAP rows as the rules read them: (records, rows read, unused withholding rows dropped)."""
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

    # One row per SAP line: drop withholding types assigned to the vendor
    # that do not apply to the line (the SAP data API sends them, see
    # drop_unused_withholding_rows); otherwise each reads as missed TDS.
    rows_read = len(records)
    records, unused_withholding_rows = drop_unused_withholding_rows(records)
    return records, rows_read, unused_withholding_rows


def uses_descriptive_sections(records: list[dict[str, Any]]) -> bool:
    """Exports containing compound descriptive section text (either the old
    numbering, e.g. "194C - Ind/HUF - 1%", or the new one, e.g.
    "...-393(1)6(i)") need the decoder + signed-amount normalization;
    ordinary SAP exports with bare section codes use the alias-based translator."""
    return any(looks_like_descriptive_tds_section(get_tds_section_raw(row)) for row in records)


def build_transactions(records: list[dict[str, Any]], uses_descriptive_section: bool) -> list[Any]:
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
    return transactions


def missing_deduction_inputs(transactions) -> list[Any]:
    """The rows check_missing_deduction looks at (correction lines are judged with their original)."""
    issue_eligible_transactions = [
        txn for txn in transactions
        if not _is_skipped_non_tds_document_without_tds_amounts(txn)
        and not _has_zero_base_amount(txn)
    ]
    correction_line_ids = {id(txn) for txn in transactions if references_other_document(txn)}
    return [
        txn for txn in _missing_deduction_candidates(transactions, issue_eligible_transactions)
        if id(txn) not in correction_line_ids
    ]


def analyse_frame(
    frame: pd.DataFrame,
    *,
    filename: str,
    filenames: list[str],
    company_code: str,
    include_informational: bool,
    current_user: User,
    db: Session,
    source: str,
) -> "_FastJSONResponse":
    """Run the TDS rules on SAP line items and save the run (issue history + ledger).

    Shared by the Excel upload and the SAP data API (api/sap_data.py), so rows
    from either source go through the same analysis and reach every page.
    """
    return _FastJSONResponse(run_analysis(
        frame, filename=filename, filenames=filenames, company_code=company_code,
        include_informational=include_informational, current_user=current_user, db=db, source=source,
    ))


def run_analysis(
    frame: pd.DataFrame,
    *,
    filename: str,
    filenames: list[str],
    company_code: str,
    include_informational: bool,
    current_user: User,
    db: Session,
    source: str,
    batch: AnalysisBatch | None = None,
) -> dict[str, Any] | None:
    """analyse_frame's result as a dict. With ``batch`` (one batch of a large
    pull): saved under the batch's run, the browser rows left out unless
    ``batch.respond``, and None when the batch has no TDS-relevant rows."""
    requested_code = company_code.strip()
    records, rows_read, unused_withholding_rows = prepare_records(
        frame, company_code=company_code, current_user=current_user, db=db,
    )
    descriptive = batch.descriptive if batch is not None and batch.descriptive is not None else uses_descriptive_sections(records)
    transactions = build_transactions(records, descriptive)
    del records

    if not transactions:
        if batch is not None:
            return None
        raise HTTPException(
            status_code=422,
            detail="No TDS-relevant transactions were found. Ensure TDS_Section and TDS_Rate are populated.",
        )

    _apply_ldc_master_to_transactions(transactions, db)
    _apply_pan_verification_to_transactions(transactions, db)
    tds_cases, case_stats = build_tds_cases(transactions)
    ldc_utilization = _build_ldc_utilization(transactions)
    _attach_ldc_limits(ldc_utilization, db)

    issues: list[dict[str, Any]] = []
    issue_txns: list[Any] = []  # transaction behind issues[i], for issue tracking
    issue_reasons_by_transaction_id: dict[int, str] = {}
    issue_transaction_ids: set[int] = set()
    # For the Reports page category report: each row's first reported issue,
    # and its first informational result ("TDS Deducted as per LDC", "TDS Not
    # Applicable", ...) that is not reported as an issue.
    first_issue_by_transaction_id: dict[int, dict[str, Any]] = {}
    info_issue_by_transaction_id: dict[int, TDSIssue] = {}

    def record(txn, rule_issue, *, always: bool = False) -> None:
        if always or include_informational or rule_issue.severity != "low":
            issue = _transaction_issue(len(issues) + 1, txn, rule_issue)
            issues.append(issue)
            issue_txns.append(txn)
            issue_transaction_ids.add(id(txn))
            issue_reasons_by_transaction_id.setdefault(id(txn), rule_issue.category)
            first_issue_by_transaction_id.setdefault(id(txn), issue)
        else:
            info_issue_by_transaction_id.setdefault(id(txn), rule_issue)

    issue_eligible_transactions = [
        txn for txn in transactions
        if not _is_skipped_non_tds_document_without_tds_amounts(txn)
        and not _has_zero_base_amount(txn)
    ]
    ldc_chains, ldc_chain_members = _ldc_advance_chains(issue_eligible_transactions)
    # A credit memo, reversal or TDS top-up that references another document
    # is checked through that document's issue (see services/issue_tracker),
    # not on its own: alone it would look like an invoice with TDS missing.
    correction_lines = [txn for txn in transactions if references_other_document(txn)]
    correction_line_ids = {id(txn) for txn in correction_lines}
    row_check_transactions = [txn for txn in issue_eligible_transactions if id(txn) not in correction_line_ids]
    for txn in row_check_transactions:
        for rule_issue in _row_checks(txn, ldc_chains, ldc_chain_members):
            record(txn, rule_issue)

    # Threshold checks operate across transactions, so each result carries a
    # representative transaction from its own vendor/section/FY group.
    for txn, rule_issue in _skip_ldc_decided(check_threshold_breach(issue_eligible_transactions), ldc_chain_members):
        record(txn, rule_issue)

    missing_deduction = check_missing_deduction(
        [txn for txn in _missing_deduction_candidates(transactions, issue_eligible_transactions) if id(txn) not in correction_line_ids],
        gl_stats=batch.gl_stats if batch is not None else None,
    )
    for txn, rule_issue in _skip_ldc_decided(missing_deduction, ldc_chain_members):
        record(txn, rule_issue)

    for txn, rule_issue in _skip_ldc_decided(check_advance_payment_lifecycle(issue_eligible_transactions), ldc_chain_members):
        record(txn, rule_issue)

    for txn, rule_issue in _check_ldc_limit_breach(issue_eligible_transactions, ldc_utilization):
        record(txn, rule_issue, always=True)

    # Correction entries (credit memo / reversal / TDS top-up pointing at another
    # document) skip the single-row rules above, but their own TDS is still
    # checked against the expected rate. See _check_correction_lines.
    correction_results, correction_flagged_docs = _check_correction_lines(correction_lines, issue_txns, db)
    for txn in correction_lines:
        outcome = correction_results.get(id(txn))
        if outcome and outcome[0] == "issue":
            record(txn, outcome[1], always=True)

    vendors = sorted({issue["vendor"] for issue in issues if issue["vendor"]})
    sections = sorted({issue["section"] for issue in issues if issue["section"] and issue["section"] != "—"})
    # Vendor Threshold Tracker disabled; see _threshold_vendor_summaries.
    # threshold_vendors = _threshold_vendor_summaries(transactions)
    threshold_vendors = []
    tds_notes = _build_tds_notes(transactions, issue_reasons_by_transaction_id)
    # A correction entry with no TDS of its own is not missing SAP data, so it
    # gets this note instead of the generic "Cannot verify".
    for txn in correction_lines:
        if abs(float(txn.tds_deducted_amount or 0.0)) <= 0 and id(txn) not in issue_transaction_ids:
            tds_notes[id(txn)] = f"Credit note for invoice {str(txn.invoice_reference_document).strip()}, no TDS on it."
    browser_rows = batch is None or batch.respond
    case_ledger = _build_case_ledger_from_transactions(transactions, issues, tds_notes) if browser_rows else []
    skipped_validation_rows = sum(
        id(txn) not in issue_transaction_ids and _is_skipped_non_tds_document_without_tds_amounts(txn)
        for txn in transactions
    )
    insufficient_data_rows = sum(
        id(txn) not in issue_transaction_ids
        and not _is_skipped_non_tds_document_without_tds_amounts(txn)
        and not _is_payment_against_invoice_without_tds(txn)
        and (_has_zero_base_amount(txn) or not _has_validation_signal(txn))
        for txn in transactions
    )
    issue_rows = len(issue_transaction_ids)
    passed_rows = max(0, len(transactions) - issue_rows - insufficient_data_rows - skipped_validation_rows)
    validation_rows = []
    for row_index, txn in enumerate(transactions, start=1):
        txn_id = id(txn)
        if txn_id in issue_transaction_ids:
            validation_rows.append(_transaction_validation_row(
                txn,
                "issue",
                issue_reasons_by_transaction_id.get(txn_id, "Issue found"),
                row_index,
                tds_notes.get(txn_id),
            ))
        elif txn_id in correction_line_ids:
            status, reason = correction_results.get(txn_id, ("skipped", ""))
            row = _transaction_validation_row(txn, status, reason, row_index, tds_notes.get(txn_id))
            row["rowKind"] = "correction"
            row["correctionOf"] = txn.invoice_reference_document
            # Whether the original document has its own issue (this run or earlier).
            row["correctionOriginalFlagged"] = (
                (txn.company_code or "").strip(), str(txn.invoice_reference_document).strip()
            ) in correction_flagged_docs
            validation_rows.append(row)
        elif _is_skipped_non_tds_document_without_tds_amounts(txn):
            validation_rows.append(_transaction_validation_row(
                txn,
                "skipped",
                _skipped_non_tds_document_reason(txn),
                row_index,
                tds_notes.get(txn_id),
            ))
        elif _nil_rate_ldc_without_tds(txn):
            validation_rows.append(_transaction_validation_row(
                txn,
                "passed",
                f"LDC certificate {txn.ldc_exemption_number} gives 100% exemption on this posting date, so no TDS is required.",
                row_index,
                tds_notes.get(txn_id),
            ))
        elif _is_payment_against_invoice_without_tds(txn):
            validation_rows.append(_transaction_validation_row(
                txn,
                "passed",
                PAYMENT_AGAINST_INVOICE_REASON,
                row_index,
                tds_notes.get(txn_id),
            ))
        elif _has_zero_base_amount(txn):
            validation_rows.append(_transaction_validation_row(
                txn,
                "insufficient",
                "Base amount is zero, so TDS cannot be validated for this row.",
                row_index,
                tds_notes.get(txn_id),
            ))
        elif not _has_validation_signal(txn):
            validation_rows.append(_transaction_validation_row(
                txn,
                "insufficient",
                "Missing section/rate/applicable section/payment type, so rules cannot validate this row.",
                row_index,
                tds_notes.get(txn_id),
            ))
        else:
            validation_rows.append(_transaction_validation_row(
                txn,
                "passed",
                "Validated with no issue found.",
                row_index,
                tds_notes.get(txn_id),
            ))

    # One business category per row for the Reports page (services/report_category.py).
    advance_roles = build_advance_roles(issue_eligible_transactions)
    for txn, row in zip(transactions, validation_rows):
        row.update(report_fields(
            txn,
            row,
            first_issue_by_transaction_id.get(id(txn)),
            info_issue_by_transaction_id.get(id(txn)),
            advance_roles.get(id(txn)),
            id(txn) in ldc_chain_members,
        ))
    # Each issue's business sheet, saved with it so Open Issues can split by it.
    # A row's first issue takes the row's own category, matching this upload's tabs.
    report_category_by_txn = {id(txn): row.get("reportCategory") for txn, row in zip(transactions, validation_rows)}
    for issue, txn in zip(issues, issue_txns):
        if first_issue_by_transaction_id.get(id(txn)) is issue and report_category_by_txn.get(id(txn)):
            issue["reportCategory"] = report_category_by_txn[id(txn)]
        else:
            issue["reportCategory"] = issue_report_category(issue, txn, advance_roles.get(id(txn)))
    # Link each issue to its validation row. Matching on amounts is not enough:
    # "Possible Missed TDS Deduction" estimates a base where the row has none.
    row_index_by_txn = {id(txn): row_index for row_index, txn in enumerate(transactions, start=1)}
    for issue, txn in zip(issues, issue_txns):
        issue["rowIndex"] = row_index_by_txn.get(id(txn))
    # Each row as analysed, saved with its ledger line for the TDS Category
    # Report across runs; resolutions are applied when the report is read.
    report_rows = {id(txn): {key: value for key, value in row.items() if key not in ("id", "rowIndex")} for txn, row in zip(transactions, validation_rows)}

    passed_rows = sum(row["status"] == "passed" for row in validation_rows)
    issue_rows = sum(row["status"] == "issue" for row in validation_rows)
    insufficient_data_rows = sum(row["status"] == "insufficient" for row in validation_rows)
    skipped_validation_rows = sum(row["status"] == "skipped" for row in validation_rows)

    stats = {
        "rowsRead": rows_read,
        "unusedWithholdingRows": unused_withholding_rows,
        "transactionsBuilt": len(validation_rows),
        "rowsSkipped": skipped_validation_rows,
        "passedRows": passed_rows,
        "issueRows": issue_rows,
        "insufficientDataRows": insufficient_data_rows,
        "validatedRows": passed_rows + issue_rows,
        "issuesFound": len(issues),
        "ledgerCases": len(case_ledger),
        "openLedgerCases": sum(case.get("openItem") or case["status"] == "OPEN" for case in case_ledger),
        "issueLedgerCases": sum(case["status"] == "ISSUE" for case in case_ledger),
        "balancedLedgerCases": sum(case["status"] == "BALANCED" for case in case_ledger),
        "high": sum(issue["severity"] == "high" for issue in issues),
        "medium": sum(issue["severity"] == "medium" for issue in issues),
        "low": sum(issue["severity"] == "low" for issue in issues),
    }

    # Compare with earlier runs: new / recurring / reopened issues, and earlier
    # issues now resolved by a reversal or correction posted since. Issues
    # resolved here come back with status "resolved". A database problem only
    # costs the history; the analysis itself is still returned.
    try:
        tracking = track_rule_run(
            db,
            issues=issues,
            issue_txns=issue_txns,
            transactions=transactions,
            user_id=current_user.id,
            source=source,
            file_name=filename,
            include_informational=include_informational,
            run_id=batch.run_id if batch is not None else None,
        )
    except Exception as exc:  # noqa: BLE001 - history must never block analysis
        db.rollback()
        if batch is not None:
            raise  # a batch whose issues were not saved fails the pull, see sap_analysis_job
        logger.exception("Issue tracking failed for %s %s", source, filename)
        tracking = {"error": "Issue history could not be updated for this run."}

    # Rows whose issues the issue history already counts as resolved (a
    # correction or reversal posted in this run or an earlier one) are shown as
    # corrected, not as open issues, so this upload's counts match Open Issues.
    if not tracking.get("error"):
        corrected = _mark_corrected_rows(issues, issue_txns, transactions, validation_rows)
        if corrected:
            stats["issueRows"] = sum(row["status"] == "issue" for row in validation_rows)
            stats["correctedRows"] = corrected
            stats["validatedRows"] = stats["passedRows"] + stats["issueRows"] + corrected
            stats["openIssues"] = sum(issue.get("status") != "resolved" for issue in issues)
        # Reports: a corrected document is filed where it stands now (e.g.
        # Properly Deducted after a top-up), not under its original issue.
        apply_resolutions(validation_rows)
        _mark_correction_originals(db, validation_rows)

    # Save this run's lines so the Document / GL Ledger can join them with
    # earlier and later days (services/ledger_store.py). Like the issue
    # history, a failure here must not block the analysis.
    if tracking.get("runId"):
        try:
            tracking["ledger"] = save_run_lines(db, tracking["runId"], [
                (txn, event_type, ledger_event(txn, event_type, tds_notes.get(id(txn))))
                for txn in transactions
                for event_type in (classify_event(txn),)
            ], reports=report_rows, refresh=batch is None)
        except Exception:  # noqa: BLE001
            db.rollback()
            if batch is not None:
                raise
            logger.exception("Saving ledger lines failed for %s %s", source, filename)
            tracking["ledgerError"] = "Ledger lines could not be saved for this run."

    # A batch of a large pull sends no rows to the browser. Its rows are saved
    # for the Issues page (services/upload_rows.py), its issues and lines as above.
    if not browser_rows and tracking.get("runId"):
        from services.upload_rows import save_upload_rows

        save_upload_rows(db, tracking["runId"], validation_rows, issues)

    # A batch of a large pull sends no rows to the browser: its issues and
    # lines are saved, and every page reads them from there.
    return {
        "uploadId": str(uuid4()),
        "fileName": filename,
        "fileNames": filenames,
        "companyCode": requested_code or None,
        "issues": issues if browser_rows else [],
        "stats": stats,
        "vendors": vendors,
        "sections": sections,
        "thresholdVendors": threshold_vendors,
        "ldcUtilization": ldc_utilization,
        # Not read by the UI (the Document Ledger uses caseLedger) and ~1/6 of
        # the payload on large uploads, so it is left empty here.
        "tdsCases": [],
        "caseStats": case_stats,
        "caseLedger": case_ledger,
        "validationRows": validation_rows if browser_rows else [],
        "unrecognizedColumns": [],
        "errors": [],
        "tracking": tracking,
        # Without the rows, the browser can't tell which FY the data is in.
        **({} if browser_rows else {"financialYearCounts": _financial_year_counts(transactions)}),
    }


def _financial_year_counts(transactions) -> dict[str, int]:
    """Rows per Indian FY label ('FY 2025-26'), as the browser's dominantFinancialYear counts them."""
    counts: dict[str, int] = defaultdict(int)
    for txn in transactions:
        posted = txn.posting_date
        if posted:
            start = posted.year if posted.month >= 4 else posted.year - 1
            counts[f"FY {start}-{str(start + 1)[-2:]}"] += 1
    return dict(counts)


@router.post("/upload", response_class=_FastJSONResponse)
async def upload_sap_file(
    files: list[UploadFile] | None = File(None),
    file: UploadFile | None = File(None),
    company_code: str = Form(""),
    include_informational: bool = Form(False),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Analyse one or more SAP CSV/XLSX extracts and return issues for the frontend.

    Multiple files are stacked into a single extract before analysis, so
    documents split across files (e.g. invoices in one, payments in another)
    still group into the same ledger. ``file`` is kept for older clients.
    """
    uploads = [*(files or []), *([file] if file else [])]
    if not uploads:
        raise HTTPException(status_code=422, detail="Choose at least one file to upload.")

    frames: list[pd.DataFrame] = []
    filenames: list[str] = []
    for upload in uploads:
        name = upload.filename or "upload"
        if Path(name).suffix.lower() not in SUPPORTED_EXTENSIONS:
            raise HTTPException(status_code=415, detail=f"{name}: upload a CSV, XLSX, XLSM, or XLS file.")

        content = await upload.read()
        if not content:
            raise HTTPException(status_code=422, detail=f"{name}: the uploaded file is empty.")
        if len(content) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail=f"{name}: the uploaded file exceeds the 25 MB limit.")

        part = _read_upload(name, content)
        # Strip headers per file so "Amount " and "Amount" line up on concat.
        part.columns = [str(column).strip() for column in part.columns]
        if not part.empty:
            frames.append(part)
        filenames.append(name)

    if not frames:
        raise HTTPException(status_code=422, detail="The uploaded file(s) have no transaction rows.")
    # Outer-join on columns so files with slightly different layouts still
    # combine; columns missing from one file become blank for its rows.
    frame = pd.concat(frames, ignore_index=True, sort=False) if len(frames) > 1 else frames[0]
    filename = filenames[0] if len(filenames) == 1 else f"{len(filenames)} files ({', '.join(filenames)})"

    # The analysis is CPU and database work that takes minutes on a large
    # extract; run it in a worker thread so the server keeps answering other
    # requests (pages, other users) meanwhile instead of freezing.
    return await run_in_threadpool(
        analyse_frame,
        frame,
        filename=filename,
        filenames=filenames,
        company_code=company_code,
        include_informational=include_informational,
        current_user=current_user,
        db=db,
        source="upload",
    )


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
    _apply_pan_verification_to_transactions(transactions, db)
    tds_cases, case_stats = build_tds_cases(transactions)
    ldc_utilization = _build_ldc_utilization(transactions)
    _attach_ldc_limits(ldc_utilization, db)

    issues: list[dict[str, Any]] = []
    issue_transaction_ids: set[int] = set()
    issue_eligible_transactions = [
        txn for txn in transactions
        if not _is_skipped_non_tds_document_without_tds_amounts(txn)
        and not _has_zero_base_amount(txn)
    ]

    ldc_chains, ldc_chain_members = _ldc_advance_chains(issue_eligible_transactions)
    for txn in issue_eligible_transactions:
        for rule_issue in _row_checks(txn, ldc_chains, ldc_chain_members):
            if rule_issue.severity != "low":
                issues.append(_transaction_issue(len(issues) + 1, txn, rule_issue))
                issue_transaction_ids.add(id(txn))

    for txn, rule_issue in _skip_ldc_decided(check_threshold_breach(issue_eligible_transactions), ldc_chain_members):
        if rule_issue.severity != "low":
            issues.append(_transaction_issue(len(issues) + 1, txn, rule_issue))
            issue_transaction_ids.add(id(txn))

    for txn, rule_issue in _skip_ldc_decided(check_missing_deduction(_missing_deduction_candidates(transactions, issue_eligible_transactions)), ldc_chain_members):
        if rule_issue.severity != "low":
            issues.append(_transaction_issue(len(issues) + 1, txn, rule_issue))
            issue_transaction_ids.add(id(txn))

    for txn, rule_issue in _skip_ldc_decided(check_advance_payment_lifecycle(issue_eligible_transactions), ldc_chain_members):
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
    # Vendor Threshold Tracker disabled; see _threshold_vendor_summaries.
    # threshold_vendors = _threshold_vendor_summaries(transactions)
    threshold_vendors = []
    case_ledger = _build_case_ledger(joined_rows, issues)
    skipped_validation_rows = sum(
        id(txn) not in issue_transaction_ids and _is_skipped_non_tds_document_without_tds_amounts(txn)
        for txn in transactions
    )
    insufficient_data_rows = sum(
        id(txn) not in issue_transaction_ids
        and not _is_skipped_non_tds_document_without_tds_amounts(txn)
        and not _is_payment_against_invoice_without_tds(txn)
        and (_has_zero_base_amount(txn) or not _has_validation_signal(txn))
        for txn in transactions
    )
    issue_rows = len(issue_transaction_ids)
    passed_rows = max(0, len(transactions) - issue_rows - insufficient_data_rows - skipped_validation_rows)

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
            "skippedRows": skipped_validation_rows,
            "issuesFound": len(issues),
            "ledgerCases": len(case_ledger),
            "openLedgerCases": sum(case.get("openItem") or case["status"] == "OPEN" for case in case_ledger),
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
        "GL_Description", "TDS_Section", "TDS_Rate", "TDS_Amount", "Profit_Center",
    ]
    example = [
        "1001", "V0001", "Example Vendor", "ABCDE1234F", "2026-04-01",
        "KR", "1900000001", "100000", "100000", "500100",
        "Professional fees", "194J", "10", "10000", "PC1001",
    ]
    csv = ",".join(columns) + "\n" + ",".join(example) + "\n"
    return StreamingResponse(
        iter([csv]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=tds_sap_upload_template.csv"},
    )
