from datetime import datetime
from typing import List, Optional
import pandas as pd

from rules.transaction_model import Transaction


def _parse_date(value) -> Optional[datetime.date]:
    """Handles date strings like '1/1/2026' safely, returns None if blank."""
    if value is None or str(value).strip() in ("", "nan", "None"):
        return None
    if isinstance(value, datetime):
        return value.date()
    return pd.to_datetime(value).date()


def _derive_vendor_category(pan: str) -> Optional[str]:
    """
    Derives vendor category from PAN's 4th character.
    Confirmed rule from Mahindra's examples:
    4th letter C, F, T, or A -> Firm/Trust/AOP/Company (2% rate context)
    Any other letter (e.g. P) -> Individual (1% rate context)
    """
    if not pan or len(pan) < 4:
        return None
    fourth_char = pan[3].upper()
    if fourth_char in ("C", "F", "T", "A"):
        return "Firm/Trust/AOP/Company"
    elif fourth_char == "P":
        return "Individual"
    else:
        return "Other"


def _safe_float(value) -> Optional[float]:
    """Converts to float safely, returns None for blank/invalid values."""
    if value is None or str(value).strip() in ("", "nan", "None"):
        return None
    try:
        return float(value)
    except (ValueError, TypeError):
        return None


def _parse_rate_percent(value) -> Optional[float]:
    """
    Parses a rate value that may come as '2%', '2.0%', '2', or 2.0
    and returns a clean float percentage (e.g. 2.0). Returns None
    if blank or unparseable.
    """
    if value is None or str(value).strip() in ("", "nan", "None"):
        return None
    cleaned = str(value).strip().replace("%", "")
    try:
        return float(cleaned)
    except (ValueError, TypeError):
        return None


def build_transactions_from_sap_rows(raw_rows: List[dict]) -> List[Transaction]:
    """
    Converts raw SAP-style rows into a clean list of Transaction objects.

    Grouping rule (confirmed from Mahindra sample data):
    - Multiple rows can share the same doc_number + GL_Account + bill_amount
      when SAP checks several withholding tax types on the same line.
    - Only rows where a real TDS section/rate is populated represent a
      real TDS-relevant transaction; blank rows are dropped.
    """
    transactions: List[Transaction] = []

    for row in raw_rows:
        section_value = str(row.get("tds_section") or "").strip()
        rate_value = _parse_rate_percent(row.get("tds_rate"))

        if not section_value or rate_value is None:
            continue  # no real TDS section/rate on this row — skip

        pan = str(row.get("Pan") or "").strip()

        txn = Transaction(
            doc_number=str(row.get("doc_number")),
            doc_type=str(row.get("doc_type") or ""),
            posting_date=_parse_date(row.get("posting_date")),
            bill_date=_parse_date(row.get("bill_date")),
            bill_no=str(row.get("bill_no") or "").strip() or None,
            po_no=str(row.get("PO_No") or "").strip() or None,
            company_code=str(row.get("Company_Code") or "").strip() or None,

            vendor_code=str(row.get("Vendor") or ""),
            vendor_name=str(row.get("vendor_name") or "").strip() or None,
            vendor_pan=pan,
            vendor_category=_derive_vendor_category(pan),
            person=str(row.get("person") or "").strip() or None,

            gl_account=str(row.get("GL_Account") or ""),
            gl_description=str(row.get("GL_Desc") or "").strip() or None,
            hsn_sac_code=str(row.get("HSN_SAC_Code") or "").strip() or None,

            bill_amount=float(row.get("bill_amount") or 0),
            basic_amount=float(row.get("basic_amount") or 0),
            debit_credit=str(row.get("deb_cred") or "").strip() or None,

            tds_applicable_section=str(row.get("TDS_Applicable_Section") or "").strip() or None,
            tds_applicable_rate=_safe_float(row.get("TDS_Applicable_Rate")),
            tds_applicable_amount=_safe_float(row.get("TDS_Applicable_Amount")),

            tds_deducted_section=section_value,
            tds_deducted_rate=rate_value,
            tds_deducted_amount=_safe_float(row.get("TDS_Deducted_Amount")),

            ldc_exemption_percent=_safe_float(row.get("LDC_Exemption_Percent")),
            ldc_exempt_from=_parse_date(row.get("LDC_Exempt_From")),
            ldc_exempt_to=_parse_date(row.get("LDC_Exempt_To")),
            ldc_exemption_number=str(row.get("LDC_Exemption_Number") or "").strip() or None,
            ldc_exemption_reason=str(row.get("LDC_Exemption_Reason") or "").strip() or None,

            advance_document_reference=str(row.get("Advance_Document_Linkage") or "").strip() or None,
        )
        transactions.append(txn)

    return transactions