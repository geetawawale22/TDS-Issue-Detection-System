from pydantic import BaseModel
from typing import Optional
from datetime import date


class Transaction(BaseModel):
    """
    Standard internal transaction shape. Every rule in the engine
    operates ONLY on this model — never on raw SAP column names.
    When real Mahindra data structure is confirmed, only the
    translator function that builds this object changes.
    """

    # --- Document Identification ---
    doc_number: str
    line_item_number: Optional[str] = None      # BUZEI — not yet confirmed by Mahindra
    doc_type: str                                 # KZ, RE, KR, AB, AC, KA etc.
    posting_date: date
    bill_date: Optional[date] = None
    bill_no: Optional[str] = None
    po_no: Optional[str] = None
    company_code: Optional[str] = None            # BUKRS — not yet confirmed

    # --- Vendor Information ---
    vendor_code: str
    vendor_name: Optional[str] = None
    vendor_pan: str
    vendor_category: Optional[str] = None         # derived from PAN 4th char, or SAP field if confirmed
    person: Optional[str] = None

    # --- GL / Nature of Transaction ---
    gl_account: str
    gl_description: Optional[str] = None
    hsn_sac_code: Optional[str] = None            # not yet confirmed by Mahindra

    # --- Amounts ---
    bill_amount: float
    basic_amount: float                            # TDS calculation base (assumed GST-excluded)
    debit_credit: Optional[str] = None            # H / S

    # --- Flags (POC-derived logic, populated during ingestion or later confirmed by Mahindra) ---
    is_advance_payment: Optional[bool] = None      # True if doc_type indicates advance (e.g. KZ)
    is_provision_entry: Optional[bool] = None       # True for year-end provision entries
    is_non_filer: Optional[bool] = None              # Section 206AB — vendor hasn't filed ITR
    has_form_15g_15h: Optional[bool] = None
    is_transporter: Optional[bool] = None            # 194C transporter exemption
    residential_status: Optional[str] = None         # "Resident" / "Non-Resident"

    # --- TDS Applicable (what SHOULD have been deducted) ---
    tds_applicable_section: Optional[str] = None   # not yet confirmed by Mahindra
    tds_applicable_rate: Optional[float] = None
    tds_applicable_amount: Optional[float] = None

    # --- TDS Deducted (what WAS actually deducted) ---
    tds_deducted_section: Optional[str] = None     # e.g. "194J" — actual IT Act section
    tds_deducted_rate: Optional[float] = None      # e.g. 2.0 — actual percentage
    tds_deducted_amount: Optional[float] = None    # actual ₹ deducted — not yet confirmed by Mahindra

    # --- LDC (Lower Deduction Certificate) — optional, only if applicable ---
    ldc_exemption_percent: Optional[float] = None
    ldc_exempt_from: Optional[date] = None
    ldc_exempt_to: Optional[date] = None
    ldc_exemption_number: Optional[str] = None
    ldc_exemption_reason: Optional[str] = None

    # --- Advance Payment Linkage — optional, only if applicable ---
    advance_document_reference: Optional[str] = None

    class Config:
        from_attributes = True