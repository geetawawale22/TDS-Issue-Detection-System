"""Temporary in-memory TDS case builder for uploaded SAP files.

This is the first step toward the case architecture from the walkthrough.
It intentionally does not persist anything yet; it converts the current
upload's Transaction objects into deterministic, case-shaped rows.
"""

from __future__ import annotations

from collections import Counter
from datetime import date
from hashlib import sha256
from typing import Any

from rules.transaction_model import Transaction


INVOICE_DOC_TYPES = {"RE", "KR", "F1", "F2", "F3", "FA", "LQ", "RH", "RP", "KW", "ZU"}
ADVANCE_DOC_TYPES = {"KA"}
PAYMENT_DOC_TYPES = {"KZ"}
CREDIT_DOC_TYPES = {"KG", "F4", "F5", "F6", "KC"}
DEBIT_NOTE_DOC_TYPES = {"KN", "KD"}
CLEARING_DOC_TYPES = {"AB"}
TRANSFER_POSTING_DOC_TYPES = {"TP", "TM"}
TDS_PAYMENT_DOC_TYPES = {"BT"}
JOURNAL_DOC_TYPES = {"JV"}
PROVISION_DOC_TYPES = {"JR"}
SUPPORTING_DOC_TYPES = {
    "SA", "ST", "BR", "ML", "PR", "QR", "QS", "UG", "ZY", "ZZ",
    "WA", "WE", "WI", "WL", "WN", "W2", "W3",
}


def _financial_year(value: date) -> str:
    start_year = value.year if value.month >= 4 else value.year - 1
    return f"{start_year}-{str(start_year + 1)[-2:]}"


def _base_amount(txn: Transaction) -> float:
    if txn.basic_amount is not None:
        return float(txn.basic_amount)
    return float(txn.bill_amount or 0)


def classify_event(txn: Transaction) -> str:
    doc_type = (txn.doc_type or "").strip().upper()

    if doc_type in INVOICE_DOC_TYPES:
        return "INVOICE"
    if txn.is_advance_payment or doc_type in ADVANCE_DOC_TYPES:
        return "ADVANCE_PAYMENT"
    if doc_type in PAYMENT_DOC_TYPES:
        return "PAYMENT"
    if doc_type in CREDIT_DOC_TYPES:
        return "CREDIT_MEMO"
    if doc_type in DEBIT_NOTE_DOC_TYPES:
        return "DEBIT_NOTE"
    if doc_type in CLEARING_DOC_TYPES:
        return "CLEARING"
    if doc_type in TRANSFER_POSTING_DOC_TYPES:
        return "TRANSFER_POSTING"
    if doc_type in TDS_PAYMENT_DOC_TYPES:
        return "TDS_PAYMENT"
    if doc_type in JOURNAL_DOC_TYPES:
        return "JOURNAL"
    if doc_type in PROVISION_DOC_TYPES:
        return "PROVISION"
    if doc_type in SUPPORTING_DOC_TYPES:
        return "SUPPORTING"
    if (txn.bill_amount or 0) < 0:
        return "REVERSAL"
    return "UNKNOWN"


def _case_id(txn: Transaction, event_type: str, row_number: int) -> str:
    fiscal_year = _financial_year(txn.posting_date)
    line_item = txn.line_item_number or str(row_number)
    seed = "|".join([
        "SAP_UPLOAD",
        txn.company_code or "",
        fiscal_year,
        txn.doc_number or "",
        line_item,
        event_type,
    ])
    prefix = "TDS-ADV" if event_type == "ADVANCE_PAYMENT" else "TDS-INV" if event_type == "INVOICE" else "TDS-EVT"
    return f"{prefix}-{sha256(seed.encode('utf-8')).hexdigest()[:12].upper()}"


def build_tds_cases(transactions: list[Transaction]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    event_counts: Counter[str] = Counter()

    for row_number, txn in enumerate(transactions, start=1):
        event_type = classify_event(txn)
        event_counts[event_type] += 1
        creates_case = event_type in {"INVOICE", "ADVANCE_PAYMENT"}
        base_amount = _base_amount(txn)

        cases.append({
            "id": _case_id(txn, event_type, row_number),
            "eventType": event_type,
            "createsCase": creates_case,
            "companyCode": txn.company_code or None,
            "financialYear": _financial_year(txn.posting_date),
            "docNo": txn.doc_number or "—",
            "lineItem": txn.line_item_number or str(row_number),
            "docType": txn.doc_type or "—",
            "vendor": txn.vendor_name or txn.vendor_code or "Unknown vendor",
            "vendorId": txn.vendor_code or "—",
            "vendorPan": txn.vendor_pan or "—",
            "postingDate": txn.posting_date.isoformat(),
            "poNo": txn.po_no or "—",
            "baseAmount": base_amount,
            "actualTds": float(txn.tds_deducted_amount or 0),
            "section": txn.tds_deducted_section or txn.tds_legacy_section or txn.tds_applicable_section or "—",
            "ldcCertificate": txn.ldc_exemption_number,
            "status": "CASE_CREATED" if creates_case else "ATTACH_TO_CASE",
        })

    case_count = sum(1 for case in cases if case["createsCase"])
    stats = {
        "totalEvents": len(cases),
        "caseCount": case_count,
        "invoiceCases": event_counts["INVOICE"],
        "advanceCases": event_counts["ADVANCE_PAYMENT"],
        "paymentEvents": event_counts["PAYMENT"],
        "creditEvents": event_counts["CREDIT_MEMO"],
        "reversalEvents": event_counts["REVERSAL"],
        "clearingEvents": event_counts["CLEARING"],
        "transferEvents": event_counts["TRANSFER_POSTING"],
        "supportingEvents": (
            event_counts["SUPPORTING"]
            + event_counts["TDS_PAYMENT"]
            + event_counts["DEBIT_NOTE"]
            + event_counts["JOURNAL"]
            + event_counts["PROVISION"]
        ),
        "unknownEvents": event_counts["UNKNOWN"],
    }
    return cases, stats
