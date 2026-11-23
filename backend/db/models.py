from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, ForeignKey,
    Numeric, Text, Date, UniqueConstraint, Index
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from db.database import Base


# ============================================================
# USERS TABLE
# ============================================================

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    full_name = Column(String(100), nullable=False)
    username = Column(String(50), unique=True, nullable=False, index=True)
    email = Column(String(150), unique=True, nullable=False, index=True)
    hashed_password = Column(String(255), nullable=True)
    # Nullable now — user has no password until they complete
    # the "set your password" flow via the invite link.

    role = Column(String(20), nullable=False, default="accountant")
    # role values: "admin" or "accountant"

    is_active = Column(Boolean, default=False)
    # Starts False — becomes True only after user sets their
    # password for the first time via the invite link.

    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    # Which admin created this user account — audit trail.

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationship: which company codes this user can access
    company_codes = relationship(
        "CompanyCodeAccess",
        back_populates="user",
        cascade="all, delete-orphan",
        foreign_keys="CompanyCodeAccess.user_id"
    )


# ============================================================
# COMPANY CODE ACCESS TABLE
# Explicit table (instead of plain association table) so we can
# store extra info later - e.g. who granted access, when, notes.
# ============================================================

class CompanyCodeAccess(Base):
    __tablename__ = "company_code_access"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    company_code = Column(String(10), nullable=False)
    # valid values as per project: "1001", "1079", "1081"

    granted_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    granted_at = Column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User", back_populates="company_codes", foreign_keys=[user_id])



# ============================================================
# PASSWORD SETUP TOKENS TABLE
# Handles both first-time password setup (invite) and
# forgot-password (reset) flows using the same mechanism.
# ============================================================

class PasswordSetupToken(Base):
    __tablename__ = "password_setup_tokens"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    token_hash = Column(String(255), unique=True, nullable=False, index=True)
    # We store a HASH of the token, never the raw token itself —
    # same principle as password storage.

    token_type = Column(String(20), nullable=False)
    # "invite" — first-time password setup (longer expiry)
    # "reset"  — forgot password (shorter expiry)

    expires_at = Column(DateTime(timezone=True), nullable=False)
    used = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class CompanyCode(Base):
    __tablename__ = "company_codes"

    id = Column(Integer, primary_key=True, index=True)
    code = Column(String(10), unique=True, nullable=False, index=True)
    name = Column(String(255), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class VendorMaster(Base):
    __tablename__ = "vendor_master"

    id = Column(Integer, primary_key=True, index=True)
    vendor_code = Column(String(50), nullable=False, index=True)
    vendor_name = Column(String(255), nullable=False)
    vendor_pan = Column(String(20), nullable=False, index=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class CompanyCodeTanMapping(Base):
    __tablename__ = "company_code_tan_mapping"

    id = Column(Integer, primary_key=True, index=True)
    company_code = Column(String(10), nullable=False, index=True)
    legal_entity_name = Column(String(255), nullable=True)
    deductor_tan = Column(String(20), nullable=False, index=True)
    deductor_pan = Column(String(20), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("company_code", "deductor_tan", name="uq_company_code_tan_mapping_company_tan"),
    )


class LDCCertificateMaster(Base):
    __tablename__ = "ldc_certificate_master"

    id = Column(Integer, primary_key=True, index=True)
    certificate_number = Column(String(100), nullable=False, index=True)
    certificate_type = Column(String(20), nullable=False)
    vendor_pan = Column(String(20), nullable=False, index=True)
    vendor_code = Column(String(50), nullable=True, index=True)
    vendor_name = Column(String(255), nullable=True)

    company_code = Column(String(10), nullable=True, index=True)
    deductor_tan = Column(String(20), nullable=True, index=True)
    wtax_type = Column(String(20), nullable=True, index=True)
    wtx_code = Column(String(20), nullable=True, index=True)
    applicable_tds_section = Column(String(50), nullable=False, index=True)
    approved_tds_rate = Column(Numeric(7, 4), nullable=False)

    valid_from = Column(Date, nullable=False)
    valid_to = Column(Date, nullable=False)
    tax_year = Column(String(20), nullable=True)

    approved_amount_limit = Column(Numeric(18, 2), nullable=True)
    amount_utilized = Column(Numeric(18, 2), nullable=False, default=0)
    status = Column(String(20), nullable=False, default="ACTIVE", index=True)
    is_verified = Column(Boolean, nullable=False, default=False)
    last_verified_date = Column(Date, nullable=True)

    parent_certificate_number = Column(String(100), nullable=True, index=True)
    is_child_certificate = Column(Boolean, nullable=False, default=False)
    certificate_file_path = Column(String(500), nullable=True)
    remarks = Column(Text, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint(
            "certificate_number",
            "vendor_pan",
            "vendor_code",
            "company_code",
            "deductor_tan",
            "wtax_type",
            "wtx_code",
            "applicable_tds_section",
            "valid_from",
            "valid_to",
            "approved_tds_rate",
            name="uq_ldc_certificate_scope",
        ),
        Index(
            "ix_ldc_lookup_scope",
            "vendor_pan",
            "company_code",
            "deductor_tan",
            "wtax_type",
            "wtx_code",
            "applicable_tds_section",
            "valid_from",
            "valid_to",
            "approved_tds_rate",
            "status",
        ),
    )


class LDCUploadIssueRow(Base):
    __tablename__ = "ldc_upload_issue_rows"

    id = Column(Integer, primary_key=True, index=True)
    row_number = Column(Integer, nullable=False, index=True)
    certificate_number = Column(String(100), nullable=True, index=True)
    certificate_type = Column(String(20), nullable=True)
    vendor_pan = Column(String(20), nullable=True, index=True)
    vendor_code = Column(String(50), nullable=True, index=True)
    vendor_name = Column(String(255), nullable=True)

    company_code = Column(String(10), nullable=True, index=True)
    deductor_tan = Column(String(20), nullable=True, index=True)
    wtax_type = Column(String(20), nullable=True)
    wtx_code = Column(String(20), nullable=True)
    applicable_tds_section = Column(String(50), nullable=True)
    approved_tds_rate = Column(Numeric(7, 4), nullable=True)

    valid_from = Column(Date, nullable=True)
    valid_to = Column(Date, nullable=True)
    status = Column(String(20), nullable=True)
    is_verified = Column(Boolean, nullable=True)
    saved_to_master = Column(Boolean, nullable=False, default=False, index=True)
    issues = Column(Text, nullable=False)

    created_at = Column(DateTime(timezone=True), server_default=func.now())


# ============================================================
# PAN VERIFICATION TABLE
# One row per PAN — the latest Government PAN check result. The
# rule engine reads this before analysis, so an INVALID or
# INOPERATIVE PAN is treated like a missing PAN under Section 206AA.
# ============================================================

class PanVerification(Base):
    __tablename__ = "pan_verifications"

    id = Column(Integer, primary_key=True, index=True)
    pan = Column(String(10), unique=True, nullable=False, index=True)

    status = Column(String(20), nullable=False)
    # VERIFIED       — PAN exists and is operative
    # INVALID        — Government API says the PAN does not exist
    # INOPERATIVE    — PAN exists but is inoperative (e.g. not linked with Aadhaar)
    # INVALID_FORMAT — fails the AAAAA9999A structure check, never sent to the API
    # NOT_VERIFIED   — Government API not configured yet, so only format was checked
    # ERROR          — the API call failed; retry later

    source = Column(String(20), nullable=False)
    # "api" | "manual" | "format_check"

    name_on_record = Column(String(255), nullable=True)
    # Name registered against the PAN — reserved for the later name-match check.

    message = Column(Text, nullable=True)
    checked_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    checked_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


# ============================================================
# RULE RUNS + TRACKED ISSUES
# Each rule-engine run (a file upload today, a daily API pull later) is
# recorded in rule_runs. Every issue it finds is kept in tracked_issues
# under a stable key, so the next run can tell new issues from recurring
# ones and mark earlier issues resolved once a correction is posted.
# ============================================================

class RuleRun(Base):
    __tablename__ = "rule_runs"

    id = Column(Integer, primary_key=True, index=True)
    source = Column(String(20), nullable=False, default="upload")
    # "upload" (manual file) | "api" (scheduled SAP/GCP pull, later)
    file_name = Column(Text, nullable=True)
    company_codes = Column(String(255), nullable=True)
    # comma-separated company codes present in the run
    period_from = Column(Date, nullable=True)
    period_to = Column(Date, nullable=True)
    transactions = Column(Integer, nullable=False, default=0)
    issues_found = Column(Integer, nullable=False, default=0)
    new_issues = Column(Integer, nullable=False, default=0)
    recurring_issues = Column(Integer, nullable=False, default=0)
    reopened_issues = Column(Integer, nullable=False, default=0)
    resolved_issues = Column(Integer, nullable=False, default=0)
    partially_corrected = Column(Integer, nullable=False, default=0)
    run_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


class TrackedIssue(Base):
    __tablename__ = "tracked_issues"

    id = Column(Integer, primary_key=True, index=True)
    issue_key = Column(String(64), unique=True, nullable=False, index=True)
    # sha1 of company code | fiscal year | doc no | line item | wtax type | wtax code | category

    company_code = Column(String(10), nullable=False, default="", index=True)
    fiscal_year = Column(String(10), nullable=False, default="")
    doc_no = Column(String(50), nullable=False, index=True)
    line_item = Column(String(20), nullable=False, default="")
    doc_type = Column(String(10), nullable=True)
    category = Column(String(150), nullable=False)
    issue_type = Column(String(60), nullable=True)
    # Business sheet (short / excess / not_deducted / ldc / advance_* / ...), see services/report_category.py.
    report_category = Column(String(30), nullable=True, index=True)
    severity = Column(String(10), nullable=True)
    vendor_code = Column(String(50), nullable=True, index=True)
    vendor_name = Column(String(255), nullable=True)
    vendor_pan = Column(String(20), nullable=True)
    section = Column(String(50), nullable=True)
    posting_date = Column(Date, nullable=True)
    base_amount = Column(Numeric(18, 2), nullable=True)
    tds_amount = Column(Numeric(18, 2), nullable=True)
    applied_rate = Column(Numeric(9, 4), nullable=True)
    expected_rate = Column(Numeric(9, 4), nullable=True)
    tax_impact = Column(Numeric(18, 2), nullable=True)
    # Original document's amount and side (S/H): a later credit memo or reversal
    # on the other side is measured against these.
    document_amount = Column(Numeric(18, 2), nullable=True)
    debit_credit = Column(String(1), nullable=True)
    profit_center = Column(String(50), nullable=True)
    description = Column(Text, nullable=True)

    status = Column(String(20), nullable=False, default="open", index=True)
    # open | resolved
    resolution_type = Column(String(30), nullable=True)
    # REVERSED          — the original document was reversed (STBLG link)
    # CORRECTION_POSTED — later document(s) referencing it bring TDS to the expected amount
    # NO_LONGER_FLAGGED — the document was re-checked and the rule no longer raises it
    # MANUAL            — a user matched SAP rows / resolved it by hand
    resolution_note = Column(Text, nullable=True)
    correction_docs = Column(Text, nullable=True)
    # JSON list of {docNo, docType, postingDate, tdsAmount, link}
    corrected_tds = Column(Numeric(18, 2), nullable=True)
    remaining_shortfall = Column(Numeric(18, 2), nullable=True)
    resolved_at = Column(DateTime(timezone=True), nullable=True)
    resolved_run_id = Column(Integer, ForeignKey("rule_runs.id"), nullable=True)
    resolved_by = Column(Integer, ForeignKey("users.id"), nullable=True)

    first_seen_run_id = Column(Integer, ForeignKey("rule_runs.id"), nullable=True)
    last_seen_run_id = Column(Integer, ForeignKey("rule_runs.id"), nullable=True)
    first_seen_at = Column(DateTime(timezone=True), server_default=func.now())
    last_seen_at = Column(DateTime(timezone=True), server_default=func.now())
    times_seen = Column(Integer, nullable=False, default=1)
    reopened_count = Column(Integer, nullable=False, default=0)

    __table_args__ = (
        Index("ix_tracked_issues_status_company", "status", "company_code"),
        Index("ix_tracked_issues_company_doc", "company_code", "doc_no"),
    )


class LedgerLine(Base):
    """One SAP line item kept across runs, so the Document / GL Ledger can join
    an invoice from one day with its payment or clearing from a later day.

    Identity is company + fiscal year + document + line item: a line sent again
    (e.g. now carrying its clearing document) updates the saved one.
    """
    __tablename__ = "ledger_lines"

    id = Column(Integer, primary_key=True)
    company_code = Column(String(10), nullable=False, default="")
    fiscal_year = Column(String(10), nullable=False, default="")
    doc_no = Column(String(50), nullable=False)
    line_item = Column(String(20), nullable=False, default="")
    # One SAP line can carry several withholding taxes (e.g. 194Q and 194C on the
    # same line), each with its own base, TDS and rate; each is saved as its own row.
    withholding_tax_type = Column(String(10), nullable=False, default="")
    withholding_tax_code = Column(String(10), nullable=False, default="")
    # First withholding row of its SAP line: only this one counts the line's
    # amount in group totals, so a second withholding never doubles the invoice.
    is_primary_entry = Column(Boolean, nullable=False, default=True)

    group_key = Column(String(200), nullable=False, index=True)
    clearing_document = Column(String(50), nullable=True)
    clearing_fiscal_year = Column(String(10), nullable=True)
    # Clearing taken from a later line that references this one (REBZG) when
    # SAP did not send this line again with its own clearing document.
    inferred_clearing_document = Column(String(50), nullable=True)
    inferred_clearing_fiscal_year = Column(String(10), nullable=True)
    reference_document = Column(String(50), nullable=True)
    assignment_number = Column(String(100), nullable=True)

    vendor_code = Column(String(50), nullable=True)
    vendor_name = Column(String(255), nullable=True)
    vendor_pan = Column(String(20), nullable=True)
    doc_type = Column(String(10), nullable=True)
    event_type = Column(String(30), nullable=True)
    posting_date = Column(Date, nullable=True, index=True)
    gl_account = Column(String(30), nullable=True)
    profit_center = Column(String(50), nullable=True)
    section = Column(String(100), nullable=True)
    section_label = Column(String(150), nullable=True)
    amount = Column(Numeric(18, 2), nullable=False, default=0)
    base_amount = Column(Numeric(18, 2), nullable=True)
    tds_amount = Column(Numeric(18, 2), nullable=False, default=0)
    sap_rate = Column(Numeric(9, 4), nullable=True)
    ldc_certificate = Column(String(100), nullable=True)
    ldc_rate = Column(Numeric(9, 4), nullable=True)
    ldc_expected_rate = Column(Numeric(9, 4), nullable=True)
    rate_check_na = Column(Boolean, nullable=False, default=False)
    self_clearing = Column(Boolean, nullable=False, default=False)
    has_open_issue = Column(Boolean, nullable=False, default=False)
    event = Column(Text, nullable=False)  # JSON: the line as the ledger UI shows it
    # Reports → TDS Category Report: the line's validation row as analysed
    # (JSON, before any later resolution) and its business category.
    report_category = Column(String(30), nullable=True, index=True)
    report = Column(Text, nullable=True)

    first_run_id = Column(Integer, ForeignKey("rule_runs.id"), nullable=True)
    last_run_id = Column(Integer, ForeignKey("rule_runs.id"), nullable=True)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint(
            "company_code", "fiscal_year", "doc_no", "line_item", "withholding_tax_type", "withholding_tax_code",
            name="uq_ledger_lines_identity",
        ),
        Index("ix_ledger_lines_company_doc", "company_code", "doc_no"),
        Index("ix_ledger_lines_company_reference", "company_code", "reference_document"),
    )


class LedgerGroup(Base):
    """Document Ledger group (clearing / reference / assignment / document) over saved lines."""
    __tablename__ = "ledger_groups"

    id = Column(Integer, primary_key=True)
    group_key = Column(String(200), nullable=False, unique=True)
    company_code = Column(String(10), nullable=False, default="", index=True)
    fiscal_year = Column(String(10), nullable=False, default="")
    anchor_doc = Column(String(100), nullable=False)
    group_type = Column(String(30), nullable=False)
    open_item = Column(Boolean, nullable=False, default=False)
    clearing_document = Column(String(50), nullable=True)
    assignment_number = Column(String(100), nullable=True)
    vendor_name = Column(String(255), nullable=True)
    vendor_code = Column(String(50), nullable=True)
    vendor_pan = Column(String(20), nullable=True)
    section = Column(String(100), nullable=True)
    invoice_amount = Column(Numeric(18, 2), nullable=False, default=0)
    advance_amount = Column(Numeric(18, 2), nullable=False, default=0)
    payment_amount = Column(Numeric(18, 2), nullable=False, default=0)
    base_amount = Column(Numeric(18, 2), nullable=False, default=0)
    adjustment_amount = Column(Numeric(18, 2), nullable=False, default=0)
    debit_amount = Column(Numeric(18, 2), nullable=False, default=0)
    credit_amount = Column(Numeric(18, 2), nullable=False, default=0)
    net_amount = Column(Numeric(18, 2), nullable=False, default=0)
    open_amount = Column(Numeric(18, 2), nullable=False, default=0)
    tds_amount = Column(Numeric(18, 2), nullable=False, default=0)
    event_count = Column(Integer, nullable=False, default=0)
    # Lines of documents other than the anchor (clearing) document. A clearing
    # group with none holds only the clearing entry: the documents it settles
    # are not in the data, so it is CLEARING_ONLY, not balanced.
    linked_count = Column(Integer, nullable=False, default=0)
    issue_count = Column(Integer, nullable=False, default=0)
    status = Column(String(20), nullable=False, default="OPEN", index=True)
    min_posting_date = Column(Date, nullable=True)
    max_posting_date = Column(Date, nullable=True)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


# ============================================================
# MANUAL CORRECTION REGISTER
# A user resolves an issue by matching SAP rows that correct it
# (Match SAP Rows). Each match is one correction group with its rows.
# Kept here, not in the browser, so every user sees the same register.
# ============================================================

class CorrectionGroup(Base):
    __tablename__ = "correction_groups"

    id = Column(Integer, primary_key=True, index=True)
    group_code = Column(String(20), unique=True, nullable=True, index=True)
    # "CG-00001", set from id after insert

    # The issue being corrected: company + fiscal year + document + line item.
    issue_key = Column(String(64), nullable=True, index=True)  # tracked_issues.issue_key
    company_code = Column(String(10), nullable=False, default="", index=True)
    fiscal_year = Column(String(10), nullable=False, default="")
    original_doc_no = Column(String(50), nullable=False, index=True)
    original_line_item = Column(String(20), nullable=False, default="")
    category = Column(String(150), nullable=True)
    vendor_code = Column(String(50), nullable=True)
    vendor_name = Column(String(255), nullable=True)
    vendor_pan = Column(String(20), nullable=True)
    section = Column(String(50), nullable=True)
    base_amount = Column(Numeric(18, 2), nullable=True)
    applied_rate = Column(Numeric(9, 4), nullable=True)
    expected_rate = Column(Numeric(9, 4), nullable=True)
    applied_tds = Column(Numeric(18, 2), nullable=False, default=0)
    expected_tds = Column(Numeric(18, 2), nullable=False, default=0)

    method = Column(String(30), nullable=False)
    # DIFFERENCE_ONLY | FULL_REVERSAL
    status = Column(String(20), nullable=False, default="matched_in_sap", index=True)
    # matched_in_sap (awaiting approval) | approved | rejected | undone
    remarks = Column(Text, nullable=True)

    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    status_changed_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    status_changed_at = Column(DateTime(timezone=True), nullable=True)
    status_note = Column(Text, nullable=True)

    # The tracked issue's resolution fields before this group resolved it (JSON),
    # restored when the group is undone or rejected.
    previous_issue_state = Column(Text, nullable=True)
    # Group id from the old browser-only register, so an import never runs twice.
    legacy_group_id = Column(String(30), nullable=True)

    entries = relationship(
        "CorrectionEntry", back_populates="group",
        cascade="all, delete-orphan", order_by="CorrectionEntry.position",
    )


class CorrectionEntry(Base):
    __tablename__ = "correction_entries"

    id = Column(Integer, primary_key=True, index=True)
    group_id = Column(Integer, ForeignKey("correction_groups.id", ondelete="CASCADE"), nullable=False, index=True)
    position = Column(Integer, nullable=False, default=0)
    role = Column(String(30), nullable=False)
    # REVERSAL (takes TDS back) | FRESH_DEDUCTION | ADDITIONAL_DEDUCTION (both add TDS)

    company_code = Column(String(10), nullable=False, default="")
    fiscal_year = Column(String(10), nullable=False, default="")
    doc_no = Column(String(50), nullable=False, index=True)
    line_item = Column(String(20), nullable=False, default="")
    doc_type = Column(String(10), nullable=True)
    posting_date = Column(Date, nullable=True)
    vendor_code = Column(String(50), nullable=True)
    vendor_name = Column(String(255), nullable=True)
    section = Column(String(50), nullable=True)
    base_amount = Column(Numeric(18, 2), nullable=True)
    applied_rate = Column(Numeric(9, 4), nullable=True)
    tds_amount = Column(Numeric(18, 2), nullable=False, default=0)
    # TDS on the SAP row as uploaded (always positive); the role decides its sign.

    group = relationship("CorrectionGroup", back_populates="entries")
