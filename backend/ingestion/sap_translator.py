from datetime import date, datetime
from functools import lru_cache
import re
from typing import Any, List, Optional
import pandas as pd

from rules.transaction_model import Transaction
from rules.gl_account_rules import apply_gl_rule


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
    "withholding_tax_base_amount": ("Withholding_Tax_Base_Amount",),
    "posting_date": ("Posting_Date", "posting_date"),
    "doc_type": ("Document_Type", "Document_Typ", "doc_type"),
    "transaction_kind": ("Payment_Type", "Nature_Of_Payment", "Transaction_Kind", "transaction_kind"),
    "assignment_number": ("Assignment_Number", "ZUONR"),
    "doc_number": ("Document_No", "Document_Number", "Accounting_Document_Number", "doc_number"),
    "line_item_number": ("Line_Item", "Line_Item_Number", "BUZEI"),
    "fiscal_year": ("Fiscal_Year", "GJAHR"),
    "tds_section_code": (
        "TDS_Section_Code", "TDSSectionCode", "TDS_SectionCode", "TDS Section Code",
        "official_withholding_tax_key", "official_withholding_tax_ke",
        "Official_Withholding_Tax_Key", "Official Withholding Tax Key",
    ),
    "tds_section": ("TDS_Section", "TDSSection", "tds_section"),
    "tds_section_description": (
        "TDS_Description", "tds_description", "TDS_Section_Description",
        "TDSSectionDescription", "TDS Description", "Section_Description",
    ),
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
    "tds_rate": ("TDS_Rate", "TDSRate", "tds_rate", "tds_rat", "WTax_Rate", "wtax_rate", "wtax_rat"),
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


def _normalise_header_name(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


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

_BLANK_VALUES = frozenset(("", "nan", "None"))


def _get(row: dict, field: str) -> Any:
    """Read a value using Mahindra column names, with legacy fallbacks."""
    return _row_reader(row)(field)


def _row_reader(row: dict):
    """Return ``field -> value`` for one row, resolving headers once per row.

    The translators read ~35 fields per row; building the header tuple once
    here instead of inside every ``_get`` call keeps that per-row work flat.
    """
    keys = tuple(row)

    def read(field: str) -> Any:
        for key in _field_lookup_keys(keys, field):
            value = row[key]
            if value is not None and str(value).strip() not in _BLANK_VALUES:
                return value
        return None

    return read


@lru_cache(maxsize=4096)
def _field_lookup_keys(keys: tuple, field: str) -> tuple:
    """Row headers to try, in order, when reading ``field``.

    Every row of an upload shares the same headers, so the alias search is
    done once per column layout instead of once per row. The order matches
    the per-row search it replaces: exact alias matches first, then aliases
    matched after normalising header spelling (case, spaces, underscores).
    """
    aliases = COLUMN_ALIASES.get(field, (field,))
    present = set(keys)
    exact = [alias for alias in aliases if alias in present]
    header_map = _normalised_header_map(keys)
    normalised = [
        header_map[_normalise_header_name_cached(alias)]
        for alias in aliases
        if _normalise_header_name_cached(alias) in header_map
    ]
    ordered = []
    for key in (*exact, *normalised):
        if key not in ordered:
            ordered.append(key)
    return tuple(ordered)


@lru_cache(maxsize=4096)
def _normalise_header_name_cached(value: str) -> str:
    return _normalise_header_name(value)


@lru_cache(maxsize=64)
def _normalised_header_map(keys: tuple) -> dict[str, Any]:
    # Later headers win on a clash, matching the previous dict-comprehension.
    return {_normalise_header_name(key): key for key in keys}


def get_tds_section_code_raw(row: dict) -> str:
    """Return the compact/applied section code column, if present."""
    explicit_code = _get(row, "tds_section_code")
    if explicit_code is not None:
        return str(explicit_code or "")

    section_value = str(_get(row, "tds_section") or "").strip()
    return section_value if _normalise_explicit_tds_section_code(section_value) else ""


def get_tds_section_description_raw(row: dict) -> str:
    """Return the rich descriptive section text used to infer expected section."""
    description = _get(row, "tds_section_description")
    if description is not None:
        return str(description or "")

    section_value = str(_get(row, "tds_section") or "").strip()
    return "" if _normalise_explicit_tds_section_code(section_value) else section_value


def get_tds_section_raw(row: dict) -> str:
    """Return descriptive section text when available, else the compact code."""
    return get_tds_section_description_raw(row) or get_tds_section_code_raw(row)


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


def _normalise_explicit_tds_section_code(value) -> Optional[str]:
    """Return an explicit legacy section code such as 194C/194J when present.

    Some SAP extracts carry both a compact applied-section code and a richer
    descriptive section text. If a user edits only the compact code, keep that
    as the applied section and preserve the decoded descriptive section as the
    expected section for mismatch validation.
    """
    section = str(value or "").strip().upper()
    if not section or section in ("NAN", "NONE"):
        return None
    if section in ADVANCE_SECTION_ALIASES:
        return ADVANCE_SECTION_ALIASES[section]
    if re.fullmatch(r"19\d[A-Z]{0,3}", section):
        return section
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

    from rules.tds_rule_engine import (
        decode_tds_section_string,
        extract_new_section_reference,
        infer_payment_type_from_tds_text,
    )

    for row in raw_rows:
        get = _row_reader(row)
        raw_section_code = get_tds_section_code_raw(row)
        raw_section_description = get_tds_section_description_raw(row)
        raw_section_value = raw_section_code or str(get("tds_section") or "").strip()
        withholding_tax_type = str(get("withholding_tax_type") or "").strip().upper()
        withholding_tax_code = str(get("withholding_tax_code") or "").strip().upper()
        if not raw_section_value and withholding_tax_type and withholding_tax_code:
            raw_section_value = f"{withholding_tax_type}/{withholding_tax_code}"

        descriptive_text = raw_section_description or (raw_section_value if looks_like_descriptive_tds_section(raw_section_value) else "")
        expected_section, parsed_rate = decode_tds_section_string(descriptive_text)
        explicit_section = _normalise_explicit_tds_section_code(raw_section_code or raw_section_value)
        applied_section = explicit_section or expected_section or raw_section_value

        doc_type = str(get("doc_type") or "")
        section_value, is_advance_payment = _normalise_section_and_advance(
            applied_section,
            doc_type,
            str(get("special_gl_indicator") or ""),
            str(get("special_gl_transaction_type") or ""),
        )
        rate_value = _parse_rate_percent(get("tds_rate"))
        if rate_value is None:
            rate_value = parsed_rate
        transaction_kind = str(get("transaction_kind") or "").strip() or None
        if transaction_kind is None:
            transaction_kind = infer_payment_type_from_tds_text(descriptive_text)

        pan = _normalise_pan(get("pan"))

        txn = Transaction(
            doc_number=str(get("doc_number") or ""),
            line_item_number=str(get("line_item_number") or "").strip() or None,
            doc_type=doc_type,
            transaction_kind=transaction_kind,
            assignment_number=str(get("assignment_number") or "").strip() or None,
            posting_date=_parse_date(get("posting_date")),
            bill_date=_parse_date(get("bill_date")),
            bill_no=str(get("bill_no") or "").strip() or None,
            po_no=str(get("po_no") or "").strip() or None,
            company_code=str(get("company_code") or "").strip() or None,
            fiscal_year=str(get("fiscal_year") or "").strip() or None,

            vendor_code=str(get("vendor_code") or ""),
            vendor_name=str(get("vendor_name") or "").strip() or None,
            vendor_pan=pan,
            vendor_category=_derive_vendor_category(pan),
            person=str(get("person") or "").strip() or None,

            gl_account=str(get("gl_account") or ""),
            gl_description=str(get("gl_description") or "").strip() or None,
            hsn_sac_code=str(get("hsn_sac_code") or "").strip() or None,

            bill_amount=float(get("bill_amount") or 0),
            basic_amount=float(get("basic_amount") or 0),
            debit_credit=str(get("debit_credit") or "").strip() or None,
            clearing_document=str(get("clearing_document") or "").strip() or None,
            clearing_fiscal_year=str(get("clearing_fiscal_year") or "").strip() or None,
            clearing_date=_parse_date(get("clearing_date")),
            invoice_reference_document=str(get("invoice_reference_document") or "").strip() or None,
            invoice_reference_fiscal_year=str(get("invoice_reference_fiscal_year") or "").strip() or None,
            invoice_reference_line_item=str(get("invoice_reference_line_item") or "").strip() or None,
            is_advance_payment=is_advance_payment,

            tds_raw_section=descriptive_text or section_value,
            tds_applicable_section=(
                expected_section
                if explicit_section and expected_section and explicit_section != expected_section
                else str(get("tds_applicable_section") or "").strip() or None
            ),
            tds_applicable_rate=_safe_float(get("tds_applicable_rate")),
            tds_applicable_amount=_safe_float(get("tds_applicable_amount")),

            tds_deducted_section=section_value,
            tds_legacy_section=section_value,
            tds_new_section=extract_new_section_reference(descriptive_text),
            tds_deducted_rate=rate_value,
            tds_deducted_amount=_safe_float(get("tds_amount")),
            withholding_tax_type=withholding_tax_type or None,
            withholding_tax_code=withholding_tax_code or None,
            withholding_tax_base_amount=_safe_float(get("withholding_tax_base_amount")),

            ldc_exemption_percent=_safe_float(get("ldc_exemption_percent")),
            ldc_exempt_from=_parse_date(get("ldc_exempt_from")),
            ldc_exempt_to=_parse_date(get("ldc_exempt_to")),
            ldc_exemption_number=str(get("ldc_exemption_number") or "").strip() or None,
            ldc_exemption_reason=str(get("ldc_exemption_reason") or "").strip() or None,

            advance_document_reference=str(get("advance_document_reference") or "").strip() or None,
        )
        apply_gl_rule(txn)
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
        get = _row_reader(row)
        rate = _safe_float(get("tds_rate"))

        raw_section_text = get_tds_section_description_raw(row) or get_tds_section_raw(row)
        withholding_tax_type = str(get("withholding_tax_type") or "").strip().upper()
        withholding_tax_code = str(get("withholding_tax_code") or "").strip().upper()
        if not raw_section_text and withholding_tax_type and withholding_tax_code:
            raw_section_text = f"{withholding_tax_type}/{withholding_tax_code}"
        old_section, parsed_rate = decode_tds_section_string(raw_section_text)
        explicit_section = _normalise_explicit_tds_section_code(get_tds_section_code_raw(row))
        applied_section = explicit_section or old_section
        new_section = extract_new_section_reference(raw_section_text)
        transaction_kind = str(get("transaction_kind") or "").strip() or None
        if transaction_kind is None:
            transaction_kind = infer_payment_type_from_tds_text(raw_section_text)

        # Prefer the explicit rate column; fall back to the percentage parsed from tds_description.
        final_rate = rate if rate is not None else parsed_rate
        # TDS_Amount comes signed (credit/debit convention) — normalize to positive
        raw_amount = _safe_float(get("tds_amount"))
        tds_amount = abs(raw_amount) if raw_amount is not None else None

        pan = _normalise_pan(get("pan"))

        # Deductee category is often stated directly in the text
        # (e.g. "Ind/HUF"), cross-check against PAN-derived category later
        vendor_category = _derive_vendor_category(pan)
        doc_type = str(get("doc_type") or "")
        _, is_advance_payment = _normalise_section_and_advance(
            applied_section,
            doc_type,
            str(get("special_gl_indicator") or ""),
            str(get("special_gl_transaction_type") or ""),
        )

        txn = Transaction(
            doc_number=str(get("doc_number") or ""),
            line_item_number=str(get("line_item_number") or "").strip() or None,
            doc_type=doc_type,
            transaction_kind=transaction_kind,
            assignment_number=str(get("assignment_number") or "").strip() or None,
            posting_date=_parse_date(get("posting_date")),
            bill_date=_parse_date(get("bill_date")),
            bill_no=str(get("bill_no") or "").strip() or None,
            po_no=str(get("po_no") or "").strip() or None,
            company_code=str(get("company_code") or "").strip() or None,
            fiscal_year=str(get("fiscal_year") or "").strip() or None,

            vendor_code=str(get("vendor_code") or ""),
            vendor_name=str(get("vendor_name") or "").strip() or None,
            vendor_pan=pan,
            vendor_category=vendor_category,
            person=str(get("person") or "").strip() or None,

            gl_account=str(get("gl_account") or "").strip() or None,
            gl_description=str(get("gl_description") or "").strip() or None,

            bill_amount=_safe_float(get("bill_amount")) or 0.0,
            basic_amount=_safe_float(get("basic_amount")),  # None if blank — do NOT fall back to bill_amount (GST-inclusive), that produces false positives
            debit_credit=str(get("debit_credit") or "").strip() or None,
            clearing_document=str(get("clearing_document") or "").strip() or None,
            clearing_fiscal_year=str(get("clearing_fiscal_year") or "").strip() or None,
            clearing_date=_parse_date(get("clearing_date")),
            invoice_reference_document=str(get("invoice_reference_document") or "").strip() or None,
            invoice_reference_fiscal_year=str(get("invoice_reference_fiscal_year") or "").strip() or None,
            invoice_reference_line_item=str(get("invoice_reference_line_item") or "").strip() or None,
            is_advance_payment=is_advance_payment,

            tds_raw_section=raw_section_text,
            tds_applicable_section=old_section if explicit_section and old_section and explicit_section != old_section else None,
            tds_deducted_section=applied_section,
            tds_legacy_section=applied_section,
            tds_new_section=new_section,
            tds_deducted_rate=final_rate,
            tds_deducted_amount=tds_amount,
            tds_raw_amount=raw_amount,  # signed, for audit traceability
            withholding_tax_type=withholding_tax_type or None,
            withholding_tax_code=withholding_tax_code or None,
            withholding_tax_base_amount=_safe_float(get("withholding_tax_base_amount")),
        )
        apply_gl_rule(txn)
        transactions.append(txn)

    return transactions
