from datetime import datetime
from typing import Any, List, Optional
import pandas as pd

from rules.transaction_model import Transaction


# Mahindra export headers → internal keys.
# First name in each tuple is the live export column; later names are legacy fallbacks.
COLUMN_ALIASES = {
    "company_code": ("Company_Code",),
    "vendor_code": ("Vendor_Code", "VendorCode", "Vendor"),
    "vendor_name": ("Vendor_Name", "VendorName", "vendor_name"),
    "pan": ("PAN", "Pan"),
    "person": ("Person_Code", "Person", "person"),
    "bill_date": ("Bill_Date", "bill_date"),
    "bill_no": ("Bill_No", "BillNo", "bill_no"),
    "po_no": ("PO_Number", "PO_No"),
    "gl_account": ("GL", "GL_Account"),
    "gl_description": ("GL_Description", "GLDescription", "GL_Desc"),
    "description": ("Description",),
    "bill_amount": ("Bill_Amount", "bill_amount"),
    "basic_amount": ("Basic_Amount", "basic_amount"),
    "posting_date": ("Posting_Date", "posting_date"),
    "doc_type": ("Document_Type", "doc_type"),
    "doc_number": ("Document_No", "doc_number"),
    "tds_section_code": ("TDS_Section_Code",),
    "tds_section": ("TDS_Section", "TDSSection", "tds_section"),
    "tds_rate": ("TDS_Rate", "TDSRate", "tds_rate"),
    "tds_amount": ("TDS_Amount", "TDSAmount", "TDS_Deducted_Amount"),
    "hsn_sac_code": ("HSN_SAC_Code",),
    "debit_credit": ("deb_cred",),
    "tds_applicable_section": ("TDS_Applicable_Section",),
    "tds_applicable_rate": ("TDS_Applicable_Rate",),
    "tds_applicable_amount": ("TDS_Applicable_Amount",),
    "ldc_exemption_percent": ("LDC_Exemption_Percent",),
    "ldc_exempt_from": ("LDC_Exempt_From",),
    "ldc_exempt_to": ("LDC_Exempt_To",),
    "ldc_exemption_number": ("LDC_Exemption_Number",),
    "ldc_exemption_reason": ("LDC_Exemption_Reason",),
    "advance_document_reference": ("Advance_Document_Linkage",),
}


def _get(row: dict, field: str) -> Any:
    """Read a value using Mahindra column names, with legacy fallbacks."""
    for key in COLUMN_ALIASES.get(field, (field,)):
        if key in row and row[key] is not None and str(row[key]).strip() not in ("", "nan", "None"):
            return row[key]
    return None


def get_tds_section_raw(row: dict) -> str:
    """
    Reads a row's TDS section value using the same alias resolution as
    the translators (handles TDS_Section, TDSSection, tds_section, ...).
    Exposed for callers like the upload endpoint that need to inspect
    this value BEFORE deciding which translator function to use.
    """
    return str(_get(row, "tds_section") or "")


def looks_like_descriptive_tds_section(raw_text: str) -> bool:
    """
    True for Mahindra's compound descriptive TDS_Section text, in
    EITHER numbering scheme — e.g. '194C - Ind/HUF - 1%' (old) or
    'Ind/HUF-1%-New Sec-393(1)6(i)' (new). This text needs
    decode_tds_section_string() AND signed-amount normalization
    (both only done in build_transactions_from_sap_export).

    False for a bare section code like '194C', which the simpler
    build_transactions_from_sap_rows already handles correctly and
    which also carries extra fields (LDC, applicable section/rate,
    advance-payment linkage, etc.) that the export translator doesn't
    populate — so bare codes must NOT be rerouted away from it.

    NOTE: previously this was detected by checking for '393(' only,
    which missed old-numbering descriptive text like '194C - Ind/HUF
    - 1%' entirely (confirmed via a real sample file), silently
    routing it to the generic translator, which neither decodes the
    section text nor normalizes the signed TDS amount — causing
    near-universal false "amount mismatch" positives on that data.
    """
    return bool(raw_text) and ("-" in raw_text or "%" in raw_text)


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
    4th letter P -> Individual and H -> HUF. Both receive the 1% contractor
    rate under Section 194C. C/F/T/A are non-individual categories and receive
    the 2% contractor rate; other PAN statuses must not be assumed individual.
    """
    if not pan or len(pan) < 4:
        return None
    fourth_char = pan[3].upper()
    if fourth_char == "P":
        return "Individual"
    if fourth_char == "H":
        return "HUF"
    if fourth_char in ("C", "F", "T", "A"):
        return "Firm/Trust/AOP/Company"
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

    Accepts Mahindra export column names (Company_Code, Vendor_Code, …).
    Legacy internal names are still accepted as fallbacks.

    Grouping rule (confirmed from Mahindra sample data):
    - Multiple rows can share the same doc_number + GL_Account + bill_amount
      when SAP checks several withholding tax types on the same line.
    - Only rows where a real TDS section/rate is populated represent a
      real TDS-relevant transaction; blank rows are dropped.
    """
    transactions: List[Transaction] = []

    for row in raw_rows:
        section_value = str(_get(row, "tds_section") or "").strip()
        rate_value = _parse_rate_percent(_get(row, "tds_rate"))

        if not section_value or rate_value is None:
            continue  # no real TDS section/rate on this row — skip

        pan = str(_get(row, "pan") or "").strip()

        txn = Transaction(
            doc_number=str(_get(row, "doc_number") or ""),
            doc_type=str(_get(row, "doc_type") or ""),
            posting_date=_parse_date(_get(row, "posting_date")),
            bill_date=_parse_date(_get(row, "bill_date")),
            bill_no=str(_get(row, "bill_no") or "").strip() or None,
            po_no=str(_get(row, "po_no") or "").strip() or None,
            company_code=str(_get(row, "company_code") or "").strip() or None,

            vendor_code=str(_get(row, "vendor_code") or ""),
            vendor_name=str(_get(row, "vendor_name") or "").strip() or None,
            vendor_pan=pan,
            vendor_category=_derive_vendor_category(pan),
            person=str(_get(row, "person") or "").strip() or None,

            gl_account=str(_get(row, "gl_account") or ""),
            gl_description=str(_get(row, "gl_description") or "").strip() or None,
            hsn_sac_code=str(_get(row, "hsn_sac_code") or "").strip() or None,

            bill_amount=float(_get(row, "bill_amount") or 0),
            basic_amount=float(_get(row, "basic_amount") or 0),
            debit_credit=str(_get(row, "debit_credit") or "").strip() or None,

            tds_applicable_section=str(_get(row, "tds_applicable_section") or "").strip() or None,
            tds_applicable_rate=_safe_float(_get(row, "tds_applicable_rate")),
            tds_applicable_amount=_safe_float(_get(row, "tds_applicable_amount")),

            tds_deducted_section=section_value,
            tds_legacy_section=section_value,
            tds_deducted_rate=rate_value,
            tds_deducted_amount=_safe_float(_get(row, "tds_amount")),

            ldc_exemption_percent=_safe_float(_get(row, "ldc_exemption_percent")),
            ldc_exempt_from=_parse_date(_get(row, "ldc_exempt_from")),
            ldc_exempt_to=_parse_date(_get(row, "ldc_exempt_to")),
            ldc_exemption_number=str(_get(row, "ldc_exemption_number") or "").strip() or None,
            ldc_exemption_reason=str(_get(row, "ldc_exemption_reason") or "").strip() or None,

            advance_document_reference=str(_get(row, "advance_document_reference") or "").strip() or None,
        )
        transactions.append(txn)

    return transactions


def build_transactions_from_sap_export(raw_rows: List[dict]) -> List[Transaction]:
    """
    Translator for Mahindra's real SAP export format (Company_Code,
    Vendor_Code, TDS_Section descriptive text, signed TDS_Amount).

    An explicit 0% rate is retained. It is meaningful evidence for rules
    such as LDC nil-rate, GL exclusions, and threshold checks; only a blank
    or unparseable rate means this export row has no TDS data to evaluate.
    """
    from rules.tds_rule_engine import decode_tds_section_string, extract_new_section_reference

    transactions: List[Transaction] = []

    for row in raw_rows:
        rate = _safe_float(_get(row, "tds_rate"))
        if rate is None:
            continue  # no TDS rate was supplied on this export row

        raw_section_text = get_tds_section_raw(row)
        old_section, parsed_rate = decode_tds_section_string(raw_section_text)
        new_section = extract_new_section_reference(raw_section_text)

        # Prefer the decoded section; fall back to rate column if text is missing
        final_rate = rate
        # TDS_Amount comes signed (credit/debit convention) — normalize to positive
        raw_amount = _safe_float(_get(row, "tds_amount"))
        tds_amount = abs(raw_amount) if raw_amount is not None else None

        pan = str(_get(row, "pan") or "").strip()

        # Deductee category is often stated directly in the text
        # (e.g. "Ind/HUF"), cross-check against PAN-derived category later
        vendor_category = _derive_vendor_category(pan)

        txn = Transaction(
            doc_number=str(_get(row, "doc_number") or ""),
            doc_type=str(_get(row, "doc_type") or ""),
            posting_date=_parse_date(_get(row, "posting_date")),
            bill_date=_parse_date(_get(row, "bill_date")),
            bill_no=str(_get(row, "bill_no") or "").strip() or None,
            po_no=str(_get(row, "po_no") or "").strip() or None,
            company_code=str(_get(row, "company_code") or "").strip() or None,

            vendor_code=str(_get(row, "vendor_code") or ""),
            vendor_name=str(_get(row, "vendor_name") or "").strip() or None,
            vendor_pan=pan,
            vendor_category=vendor_category,
            person=str(_get(row, "person") or "").strip() or None,

            gl_account=str(_get(row, "gl_account") or "").strip() or None,
            gl_description=str(_get(row, "gl_description") or "").strip() or None,

            bill_amount=_safe_float(_get(row, "bill_amount")) or 0.0,
            basic_amount=_safe_float(_get(row, "basic_amount")),  # None if blank — do NOT fall back to bill_amount (GST-inclusive), that produces false positives

            tds_deducted_section=old_section,
            tds_legacy_section=old_section,
            tds_new_section=new_section,
            tds_deducted_rate=final_rate,
            tds_deducted_amount=tds_amount,
            tds_raw_amount=raw_amount,  # signed, for audit traceability
        )
        transactions.append(txn)

    return transactions