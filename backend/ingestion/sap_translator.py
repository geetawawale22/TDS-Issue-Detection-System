from datetime import date, datetime
from functools import lru_cache
import re
from typing import Any, List, Optional
import pandas as pd

from rules.transaction_model import Transaction


# Mahindra export headers → internal keys.
# First name in each tuple is the live export column; later names are legacy fallbacks.
COLUMN_ALIASES = {
    "company_code": ("Company_Code",),
    "vendor_code": ("Vendor_Code", "Vendor_Number", "VendorCode", "Vendor"),
    "vendor_name": ("Vendor_Name", "VendorName", "vendor_name"),
    "pan": ("PAN", "Pan", "Vendor_PAN"),
    "person": ("Person_Code", "Person", "person"),
    "bill_date": ("Bill_Date", "Document_Date", "bill_date"),
    "bill_no": ("Bill_No", "Reference_Document", "BillNo", "bill_no"),
    "po_no": (
        "PO_Number", "PO_No", "PO", "PONumber", "PO Number",
        "Purchase_Order", "Purchase Order", "PurchaseOrder",
        "Purchasing_Document", "Purchasing Document", "PurchasingDocument",
        "EBELN",
    ),
    "gl_account": ("GL", "GL_Account"),
    "gl_description": ("GL_Description", "GLDescription", "GL_Desc"),
    "description": ("Description",),
    "bill_amount": ("Bill_Amount", "bill_amount", "Document_Amount", "Local_Amount", "Amount", "Amount_Document_Currency", "Amount_Local_Currency"),
    "basic_amount": ("Basic_Amount", "basic_amount", "TDS_Base_Amount", "Withholding_Tax_Base_Amount"),
    "posting_date": ("Posting_Date", "posting_date"),
    "doc_type": ("Document_Type", "Document_Typ", "doc_type"),
    "transaction_kind": ("Payment_Type", "Nature_Of_Payment", "Transaction_Kind", "transaction_kind"),
    "assignment_number": ("Assignment_Number", "ZUONR"),
    "doc_number": ("Document_No", "Document_Number", "Accounting_Document_Number", "doc_number"),
    "line_item_number": ("Line_Item", "Line_Item_Number", "BUZEI"),
    "fiscal_year": ("Fiscal_Year", "GJAHR"),
    "tds_section_code": ("TDS_Section_Code",),
    "tds_section": ("TDS_Section", "TDSSection", "tds_section", "tds_description", "TDS_Description"),
    "withholding_tax_type": (
        "Withholding_Tax_Type",
        "withholding_tax_type",
        "withholding_tax_ty",
        "withholding_tax_typ",
        "withholding_tax_t",
        "withholding_tax_type_",
        "WTax_Type",
        "WTaxType",
        "WTax_Type_",
        "WITHT",
        "WHT_Type",
        "WHTType",
    ),
    "withholding_tax_code": (
        "Withholding_Tax_Code",
        "withholding_tax_code",
        "withholding_tax_cod",
        "withholding_tax_cd",
        "withholding_tax_c",
        "withholding_tax_code_",
        "WTx",
        "WTx_Code",
        "WTax_Code",
        "WTaxCode",
        "WT_WITHCD",
        "WHT_Code",
        "WHTCode",
    ),
    "tds_rate": ("TDS_Rate", "TDSRate", "tds_rate"),
    "tds_amount": ("TDS_Amount", "TDSAmount", "TDS_Deducted_Amount", "Withholding_Tax_Amount"),
    "hsn_sac_code": ("HSN_SAC_Code",),
    "debit_credit": ("deb_cred", "Debit_Credit", "Debit_Credit_Indicator"),
    "tds_applicable_section": ("TDS_Applicable_Section",),
    "tds_applicable_rate": ("TDS_Applicable_Rate",),
    "tds_applicable_amount": ("TDS_Applicable_Amount",),
    "ldc_exemption_percent": ("LDC_Exemption_Percent",),
    "ldc_exempt_from": ("LDC_Exempt_From",),
    "ldc_exempt_to": ("LDC_Exempt_To",),
    "ldc_exemption_number": ("LDC_Exemption_Number",),
    "ldc_exemption_reason": ("LDC_Exemption_Reason",),
    "advance_document_reference": ("Advance_Document_Linkage",),
    "special_gl_transaction_type": ("Special_GL_Transaction_Type", "special_gl_transaction_type", "UMSKS"),
    "special_gl_indicator": ("Special_GL_Indicator", "special_gl_indicator", "special_gl_indicator", "UMSKZ"),
    "clearing_document": ("Clearing_Document", "Clearing_Document_Number", "AUGBL"),
    "clearing_fiscal_year": ("Clearing_Fiscal_Year", "AUGGJ"),
    "clearing_date": ("Clearing_Date", "AUGDT"),
    "invoice_reference_document": ("Reference_Document_Number", "REBZG", "Invoice_Reference_Document"),
    "invoice_reference_fiscal_year": ("Reference_Fiscal_Year", "REBZJ", "Invoice_Reference_Fiscal_Year"),
    "invoice_reference_line_item": ("Reference_Line_Item", "REBZZ", "Invoice_Reference_Line_Item"),
}


PAN_IN_GSTIN_REGEX = re.compile(r"^[0-9]{2}([A-Z]{5}[0-9]{4}[A-Z])[0-9A-Z]{3}$")
PAN_REGEX = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")

ADVANCE_SECTION_ALIASES = {
    "194CP": "194C",
    "194JP": "194J",
    "194LQ": "194Q",
}


def _normalise_pan(value: str | None) -> str:
    pan = str(value or "").strip().upper()
    if PAN_REGEX.match(pan):
        return pan
    gstin_match = PAN_IN_GSTIN_REGEX.match(pan)
    if gstin_match:
        return gstin_match.group(1)
    return pan


def _normalise_section_and_advance(
    section_value: str | None,
    doc_type: str | None,
    special_gl_indicator: str | None,
    special_gl_transaction_type: str | None = None,
) -> tuple[str, bool]:
    section = str(section_value or "").strip().upper()
    section_text = str(section_value or "").strip().lower()
    special_gl = str(special_gl_indicator or "").strip().upper()
    special_gl_type = str(special_gl_transaction_type or "").strip().upper()
    special_gl_text = f"{special_gl} {special_gl_type}".lower()
    is_advance = (
        str(doc_type or "").strip().upper() == "KA"
        or special_gl in {"A"}
        or special_gl_type in {"A"}
        or "advance" in section_text
        or "down payment" in section_text
        or "downpayment" in section_text
        or "advance" in special_gl_text
        or "down payment" in special_gl_text
        or "downpayment" in special_gl_text
    )
    if section in ADVANCE_SECTION_ALIASES:
        return ADVANCE_SECTION_ALIASES[section], True
    return section, is_advance

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


@lru_cache(maxsize=4096)
def _parse_date_string(value: str) -> Optional[date]:
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            pass
    return pd.to_datetime(value).date()


def _parse_date(value) -> Optional[date]:
    """Handles date strings like '1/1/2026' safely, returns None if blank."""
    if value is None or str(value).strip() in ("", "nan", "None"):
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return _parse_date_string(str(value).strip())


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
        raw_section_value = str(_get(row, "tds_section") or "").strip()
        withholding_tax_type = str(_get(row, "withholding_tax_type") or "").strip().upper()
        withholding_tax_code = str(_get(row, "withholding_tax_code") or "").strip().upper()
        if not raw_section_value and withholding_tax_type and withholding_tax_code:
            raw_section_value = f"{withholding_tax_type}/{withholding_tax_code}"
        doc_type = str(_get(row, "doc_type") or "")
        section_value, is_advance_payment = _normalise_section_and_advance(
            raw_section_value,
            doc_type,
            str(_get(row, "special_gl_indicator") or ""),
            str(_get(row, "special_gl_transaction_type") or ""),
        )
        rate_value = _parse_rate_percent(_get(row, "tds_rate"))
        transaction_kind = str(_get(row, "transaction_kind") or "").strip() or None

        pan = _normalise_pan(_get(row, "pan"))

        txn = Transaction(
            doc_number=str(_get(row, "doc_number") or ""),
            line_item_number=str(_get(row, "line_item_number") or "").strip() or None,
            doc_type=doc_type,
            transaction_kind=transaction_kind,
            assignment_number=str(_get(row, "assignment_number") or "").strip() or None,
            posting_date=_parse_date(_get(row, "posting_date")),
            bill_date=_parse_date(_get(row, "bill_date")),
            bill_no=str(_get(row, "bill_no") or "").strip() or None,
            po_no=str(_get(row, "po_no") or "").strip() or None,
            company_code=str(_get(row, "company_code") or "").strip() or None,
            fiscal_year=str(_get(row, "fiscal_year") or "").strip() or None,

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
            clearing_document=str(_get(row, "clearing_document") or "").strip() or None,
            clearing_fiscal_year=str(_get(row, "clearing_fiscal_year") or "").strip() or None,
            clearing_date=_parse_date(_get(row, "clearing_date")),
            invoice_reference_document=str(_get(row, "invoice_reference_document") or "").strip() or None,
            invoice_reference_fiscal_year=str(_get(row, "invoice_reference_fiscal_year") or "").strip() or None,
            invoice_reference_line_item=str(_get(row, "invoice_reference_line_item") or "").strip() or None,
            is_advance_payment=is_advance_payment,

            tds_raw_section=section_value,
            tds_applicable_section=str(_get(row, "tds_applicable_section") or "").strip() or None,
            tds_applicable_rate=_safe_float(_get(row, "tds_applicable_rate")),
            tds_applicable_amount=_safe_float(_get(row, "tds_applicable_amount")),

            tds_deducted_section=section_value,
            tds_legacy_section=section_value,
            tds_deducted_rate=rate_value,
            tds_deducted_amount=_safe_float(_get(row, "tds_amount")),
            withholding_tax_type=withholding_tax_type or None,
            withholding_tax_code=withholding_tax_code or None,

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
    from rules.tds_rule_engine import (
        decode_tds_section_string,
        extract_new_section_reference,
        infer_payment_type_from_tds_text,
    )

    transactions: List[Transaction] = []

    for row in raw_rows:
        rate = _safe_float(_get(row, "tds_rate"))

        raw_section_text = get_tds_section_raw(row)
        withholding_tax_type = str(_get(row, "withholding_tax_type") or "").strip().upper()
        withholding_tax_code = str(_get(row, "withholding_tax_code") or "").strip().upper()
        if not raw_section_text and withholding_tax_type and withholding_tax_code:
            raw_section_text = f"{withholding_tax_type}/{withholding_tax_code}"
        old_section, parsed_rate = decode_tds_section_string(raw_section_text)
        new_section = extract_new_section_reference(raw_section_text)
        transaction_kind = str(_get(row, "transaction_kind") or "").strip() or None
        if transaction_kind is None:
            transaction_kind = infer_payment_type_from_tds_text(raw_section_text)

        # Prefer the explicit rate column; fall back to the percentage parsed from tds_description.
        final_rate = rate if rate is not None else parsed_rate
        # TDS_Amount comes signed (credit/debit convention) — normalize to positive
        raw_amount = _safe_float(_get(row, "tds_amount"))
        tds_amount = abs(raw_amount) if raw_amount is not None else None

        pan = _normalise_pan(_get(row, "pan"))

        # Deductee category is often stated directly in the text
        # (e.g. "Ind/HUF"), cross-check against PAN-derived category later
        vendor_category = _derive_vendor_category(pan)
        doc_type = str(_get(row, "doc_type") or "")
        _, is_advance_payment = _normalise_section_and_advance(
            old_section,
            doc_type,
            str(_get(row, "special_gl_indicator") or ""),
            str(_get(row, "special_gl_transaction_type") or ""),
        )

        txn = Transaction(
            doc_number=str(_get(row, "doc_number") or ""),
            line_item_number=str(_get(row, "line_item_number") or "").strip() or None,
            doc_type=doc_type,
            transaction_kind=transaction_kind,
            assignment_number=str(_get(row, "assignment_number") or "").strip() or None,
            posting_date=_parse_date(_get(row, "posting_date")),
            bill_date=_parse_date(_get(row, "bill_date")),
            bill_no=str(_get(row, "bill_no") or "").strip() or None,
            po_no=str(_get(row, "po_no") or "").strip() or None,
            company_code=str(_get(row, "company_code") or "").strip() or None,
            fiscal_year=str(_get(row, "fiscal_year") or "").strip() or None,

            vendor_code=str(_get(row, "vendor_code") or ""),
            vendor_name=str(_get(row, "vendor_name") or "").strip() or None,
            vendor_pan=pan,
            vendor_category=vendor_category,
            person=str(_get(row, "person") or "").strip() or None,

            gl_account=str(_get(row, "gl_account") or "").strip() or None,
            gl_description=str(_get(row, "gl_description") or "").strip() or None,

            bill_amount=_safe_float(_get(row, "bill_amount")) or 0.0,
            basic_amount=_safe_float(_get(row, "basic_amount")),  # None if blank — do NOT fall back to bill_amount (GST-inclusive), that produces false positives
            debit_credit=str(_get(row, "debit_credit") or "").strip() or None,
            clearing_document=str(_get(row, "clearing_document") or "").strip() or None,
            clearing_fiscal_year=str(_get(row, "clearing_fiscal_year") or "").strip() or None,
            clearing_date=_parse_date(_get(row, "clearing_date")),
            invoice_reference_document=str(_get(row, "invoice_reference_document") or "").strip() or None,
            invoice_reference_fiscal_year=str(_get(row, "invoice_reference_fiscal_year") or "").strip() or None,
            invoice_reference_line_item=str(_get(row, "invoice_reference_line_item") or "").strip() or None,
            is_advance_payment=is_advance_payment,

            tds_raw_section=raw_section_text,
            tds_deducted_section=old_section,
            tds_legacy_section=old_section,
            tds_new_section=new_section,
            tds_deducted_rate=final_rate,
            tds_deducted_amount=tds_amount,
            tds_raw_amount=raw_amount,  # signed, for audit traceability
            withholding_tax_type=withholding_tax_type or None,
            withholding_tax_code=withholding_tax_code or None,
        )
        transactions.append(txn)

    return transactions
