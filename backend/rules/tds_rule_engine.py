import yaml
from pathlib import Path
from typing import Optional
from datetime import date
import re
from rules.transaction_model import Transaction
from collections import defaultdict

# ============================================================
# Load tds_sections.yaml once when this module is imported.
# This is our "source of truth" for applicable rates/thresholds
# until Mahindra sends real TDS Applicable data per transaction.
# ============================================================

NON_RESIDENT_SECTIONS = {"195", "196A", "196B", "196C", "196D"}
CONFIG_PATH = Path(__file__).parent.parent / "config" / "tds_sections.yaml"
PAN_FORMAT_REGEX = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")

with open(CONFIG_PATH, "r") as f:
    TDS_CONFIG = yaml.safe_load(f)

SECTIONS = TDS_CONFIG["sections"]
GL_NOT_APPLICABLE = TDS_CONFIG["gl_tds_not_applicable"]
CROSS_RULES = TDS_CONFIG["cross_section_rules"]
MISSING_DEDUCTION_COVERAGE_THRESHOLD = TDS_CONFIG.get("missing_deduction_check", {}).get(
    "gl_coverage_medium_threshold", 0.8
)
TDS_AMOUNT_ROUNDING_TOLERANCE = 1.0
PAYMENT_TYPE_TO_SECTION = {
    str(section_config.get("payment_type", "")).strip().lower(): section_code
    for section_code, section_config in SECTIONS.items()
    if section_config.get("payment_type")
}
PAYMENT_TYPE_TEXT_PATTERNS = (
    ("purchase", (r"\bpurc(?:hase)?\b.*\bgood", r"\bgoods?\b")),
    ("commission", (r"\bcomm(?:ission)?\b",)),
    ("brokerage", (r"\bbrokerage\b",)),
    ("contract", (r"\bcontract(?:or)?\b", r"\bind\s*/\s*huf\b.*\b1(?:\.0)?\s*%")),
    ("professional", (r"\bprofessional\b",)),
    ("technical", (r"\btechnical\b",)),
    ("rent", (r"\brent\b",)),
    ("interest", (r"\binterest\b",)),
    ("dividend", (r"\bdividend\b",)),
    ("ecommerce", (r"\be[- ]?commerce\b",)),
)


# ============================================================
# ISSUE RESULT — what every check function returns
# ============================================================

class TDSIssue:
    """
    Represents the outcome of running a transaction through the
    rule engine. category matches Mahindra's own 8 classifications.
    """
    def __init__(
        self,
        category: str,
        message: str,
        severity: str = "medium",
        issue_code: Optional[str] = None,
        expected_rate: Optional[float] = None,
        expected_section: Optional[str] = None,
    ):
        self.category = category
        self.message = message
        self.severity = severity  # "high", "medium", "low"
        self.issue_code = issue_code or category.upper().replace(" ", "_")
        self.expected_rate = expected_rate
        self.expected_section = expected_section

    def __repr__(self):
        return f"<TDSIssue category={self.category} severity={self.severity}>"

    def to_dict(self):
        return {
            "issue_code": self.issue_code,
            "category": self.category,
            "message": self.message,
            "severity": self.severity,
            "expected_rate": self.expected_rate,
            "expected_section": self.expected_section,
        }


# ============================================================
# NEW-LAW CLAUSE DECODER (Mahindra's real SAP export format)
#
# Mahindra's live SAP export represents TDS_Section as a rich
# descriptive string, e.g. "Ind/HUF - 1%-New Sec-393(1)6(i)"
# instead of a plain old-style code like "194C". This decodes
# that string into (old_section, rate) so the rest of the rule
# engine — which is built entirely around old section codes
# (194C, 194J, etc.) — needs NO changes at all.
#
# Section 393(1) is a resident-payment table. This map preserves the
# corresponding legacy section solely as the rule-engine key; filings after
# 1-Apr-2026 must continue to use the Section 393 table reference.
# ============================================================

CLAUSE_TO_SECTION = {
    "1(i)": "194D",          # Insurance commission
    "1(ii)": "194H",         # Commission / brokerage
    "2(i)": "194IB",         # Rent — Individual/HUF not otherwise specified
    "2(ii)": "194I",         # Rent — specified payer
    "3(i)": "194IA",         # Transfer of immovable property
    "3(ii)": "194IC",        # Specified development agreement
    "3(iii)": "194LA",       # Compulsory acquisition compensation
    "4(i)": "194K",          # Mutual-fund / specified-unit income
    "4(ii)": "194LBA",       # Business-trust unit income
    "4(iii)": "194LBB",      # Investment-fund unit income
    "4(iv)": "194LBC",       # Securitisation-trust income
    "5(i)": "193",           # Interest on securities
    "5(ii)": "194A",         # Interest other than securities — bank/co-op/post office
    "5(iii)": "194A",        # Interest other than securities — other payer
    "6(i)": "194C",          # Contractor payments
    "6(ii)": "194M",         # Certain payments by Individual/HUF
    "6(iii)(a)": "194J",     # Technical services
    "6(iii)(b)": "194J",     # Professional services
    "6(iii)(c)": "194J",     # Director remuneration/fees/commission
    "6(iii)(d)": "194J",     # Royalty
    "6(iii)(e)": "194J",     # Specified payment under section 26(2)(h)
    "7": "194",              # Dividend
    "8(i)": "194DA",         # Life-insurance-policy payment
    "8(ii)": "194Q",         # Purchase of goods
    "8(iii)": "194P",        # Specified senior citizen — out of AP scope
    "8(iv)": "194R",         # Benefit or perquisite
    "8(v)": "194O",          # E-commerce operator payment
    "8(vi)": "194S",         # Virtual digital asset transfer
}

_CLAUSE_REGEX = re.compile(
    r"393\s*\(\s*1\s*\)\s*(\d+(?:\s*\(\s*[a-z]+\s*\)?){0,2})",
    re.IGNORECASE,
)
_RATE_REGEX = re.compile(r"(\d+(?:\.\d+)?)\s*%")
_LEGACY_SECTION_REGEX = re.compile(r"\b(19\d[A-Z]{0,3})\b", re.IGNORECASE)


def _normalise_clause(raw_clause: str) -> str:
    """Canonicalise SAP clause text, including exports missing a final ')'."""
    parts = re.findall(r"\d+|[a-z]+", raw_clause.lower())
    if not parts:
        return ""
    return parts[0] + "".join(f"({part})" for part in parts[1:])


def extract_new_section_reference(raw_text: str) -> Optional[str]:
    """Return the exact Section 393(1) table reference present in SAP text."""
    if not raw_text:
        return None
    clause_match = _CLAUSE_REGEX.search(raw_text)
    if not clause_match:
        return None
    clause = _normalise_clause(clause_match.group(1))
    return f"393(1){clause}" if clause else None


def decode_tds_section_string(raw_text: str) -> tuple:
    """
    Decodes Mahindra's descriptive TDS_Section string (e.g.
    'Ind/HUF - 1%-New Sec-393(1)6(i)') into (old_section, rate).
    Returns (None, None) if the string can't be parsed.
    """
    if not raw_text:
        return None, None

    clause_match = _CLAUSE_REGEX.search(raw_text)
    rate_match = _RATE_REGEX.search(raw_text)

    old_section = None
    if clause_match:
        clause = _normalise_clause(clause_match.group(1))
        old_section = CLAUSE_TO_SECTION.get(clause)
        if clause == "2(i)" and re.search(r"\b(plt|plant|mach|eqpt|equip)", raw_text, re.IGNORECASE):
            old_section = "194I"

    # Some SAP descriptions include the familiar section number rather than a
    # Section 393 table clause (notably interest rows). Prefer that explicit
    # identifier when the table reference is absent or unrecognised.
    if old_section is None:
        legacy_match = _LEGACY_SECTION_REGEX.search(raw_text)
        if legacy_match:
            old_section = legacy_match.group(1).upper()

    # Interest rows in this SAP export can be labelled only by payment nature,
    # with neither a Section 393 clause nor a legacy section identifier.
    if old_section is None and re.search(r"\binterest\b", raw_text, re.IGNORECASE):
        old_section = "193" if re.search(r"\bsecurit", raw_text, re.IGNORECASE) else "194A"

    rate = float(rate_match.group(1)) if rate_match else None

    return old_section, rate


def infer_payment_type_from_tds_text(raw_text: str) -> Optional[str]:
    """Infer payment type from descriptive TDSSection text when no separate field exists."""
    if not raw_text:
        return None

    for payment_type, patterns in PAYMENT_TYPE_TEXT_PATTERNS:
        if any(re.search(pattern, raw_text, re.IGNORECASE) for pattern in patterns):
            return payment_type

    return None


# ============================================================
# CHECK 1 — TDS Not Applicable (GL-based exclusions)
# ============================================================

def _is_gl_excluded(gl_account: Optional[str]) -> Optional[str]:
    """
    Checks if this GL account is in our known 'TDS not applicable' list.
    Returns the exclusion reason if excluded, None otherwise.
    """
    if not gl_account:
        return None
    for group_name, group_data in GL_NOT_APPLICABLE.items():
        accounts = group_data.get("accounts", [])
        if gl_account in accounts:
            return group_data.get("reason", "GL account excluded from TDS")
    return None


def check_tds_not_applicable(txn: Transaction) -> Optional[TDSIssue]:
    """
    Category: TDS Not Applicable
    Returns an issue-free confirmation if this transaction correctly
    has no TDS applied, and it's genuinely excluded. Returns None if
    this check doesn't apply (i.e. TDS-relevant transaction).
    """
    gl_reason = _is_gl_excluded(txn.gl_account)

    if gl_reason:
        if txn.tds_deducted_amount and txn.tds_deducted_amount > 0:
            return TDSIssue(
                category="TDS Not Applicable — Violation",
                message=f"GL account {txn.gl_account} is excluded ({gl_reason}), but TDS of {txn.tds_deducted_amount} was deducted anyway.",
                severity="high",
            )
        return TDSIssue(
            category="TDS Not Applicable",
            message=f"Correctly not applicable — {gl_reason}",
            severity="low",
        )

    return None


def _is_valid_pan_format(pan: Optional[str]) -> bool:
    """
    Checks PAN follows the standard structure: 5 letters, 4 digits, 1 letter.
    This is a FORMAT check only — confirms the PAN is well-formed, not
    that it's genuinely active/operative with the Income Tax Department.
    """
    if not pan:
        return False
    return bool(PAN_FORMAT_REGEX.match(pan.strip().upper()))


def check_pan_validity(txn: Transaction) -> Optional[TDSIssue]:
    """
    Category: PAN Validation (Section 206AA), combined with Section 206AB
    (non-filer) when both conditions apply on the same transaction.

    If PAN is missing or malformed, Section 206AA requires the higher
    20% rate (5% cap instead, specifically for Section 194Q). If the
    vendor is ALSO a specified non-filer (Section 206AB), the law
    requires whichever of the two computed rates is HIGHER — not
    simply 206AA's 20%.

    FIX (previously a gap): this used to stop at 206AA's rate and
    never consider 206AB when PAN was also missing, because
    check_206ab_non_filer is a later override that never runs once
    this one returns. In practice 206AA's 20% is usually already the
    higher figure, since most sections have low statutory rates —
    but for Section 195 (non-resident payments), where statutory
    rates can run well above 10%, 2x the section rate under 206AB can
    exceed 20%. So both candidate rates are now computed here and the
    higher one is applied whenever PAN is missing/invalid.

    NOTE: This checks PAN PRESENCE and FORMAT only, using SAP data.
    It does NOT confirm the PAN is genuinely active/operative with the
    Income Tax Department — that requires the Government PAN
    verification API, which is not yet available (pending Mahindra).
    Once available, plug the real check into _is_pan_operative() below.
    """
    if _is_valid_pan_format(txn.vendor_pan):
        return None  # PAN looks fine — 206AA doesn't apply here.
        # 206AB alone (PAN present, vendor is a non-filer) is handled
        # separately by check_206ab_non_filer further down the chain.

    # PAN missing or malformed — 206AA requires the higher rate
    section_206aa = CROSS_RULES.get("section_206AA", {})
    section_206aa_rate = section_206aa.get("rate", 20.0)

    # Section 194Q has a special 5% cap instead of 20%
    if txn.tds_deducted_section and txn.tds_deducted_section.strip().upper() == "194Q":
        section_206aa_rate = section_206aa.get("exception_194Q", 5.0)

    required_rate = section_206aa_rate
    rule_applied = "206AA"

    # Vendor is ALSO a specified non-filer — 206AB may require an even
    # higher rate (max of 2x the section's statutory rate, or 5%).
    # Take whichever of the two rules' rates is higher; do not stop at 206AA.
    if txn.is_non_filer:
        section_rate = _get_applicable_rate(txn)
        if section_rate is not None:
            section_206ab_rate = max(section_rate * 2, 5.0)
            if section_206ab_rate > required_rate:
                required_rate = section_206ab_rate
                rule_applied = "206AA + 206AB (higher of the two applies)"

    reason = "missing" if not txn.vendor_pan else "invalid format"

    if txn.tds_deducted_rate is None:
        return TDSIssue(
            category="PAN Missing/Invalid — TDS Not Deducted",
            message=f"Vendor PAN is {reason}. Section {rule_applied} requires {required_rate}% TDS, but nothing was deducted.",
            severity="high",
            expected_rate=required_rate,
        )

    if txn.tds_deducted_rate < required_rate:
        return TDSIssue(
            category="PAN Missing/Invalid — Short TDS Deducted",
            message=f"Vendor PAN is {reason}. Section {rule_applied} requires {required_rate}% TDS, but only {txn.tds_deducted_rate}% was deducted.",
            severity="high",
            expected_rate=required_rate,
        )

    return TDSIssue(
        category="PAN Missing/Invalid — Correctly Handled",
        message=f"Vendor PAN is {reason}, and the required {required_rate}% TDS ({rule_applied}) was correctly applied.",
        severity="low",
        expected_rate=required_rate,
    )


def _is_pan_operative(pan: str) -> Optional[bool]:
    """
    PLACEHOLDER for future Government PAN verification API integration.
    Returns None until real API access is available — meaning this
    check is currently skipped, not failed.
    """
    return None



def _get_statutory_rate(txn: Transaction) -> Optional[float]:
    """
    Determines the normal statutory TDS rate before Form 197/LDC relief.
    Priority: use Mahindra's own "Applicable Rate" if provided,
    otherwise calculate from our own tds_sections.yaml config.
    """
    if txn.tds_applicable_rate is not None:
        return txn.tds_applicable_rate

    if not txn.tds_deducted_section:
        return None

    section_key = txn.tds_deducted_section.strip().upper()
    section_config = SECTIONS.get(section_key)
    if not section_config:
        return None

    rate_config = section_config.get("rate", {})

    if "default" in rate_config:
        return rate_config["default"]

    if "individual_huf" in rate_config and "others" in rate_config:
        if txn.vendor_category in {"Individual", "HUF"}:
            return rate_config["individual_huf"]
        else:
            return rate_config["others"]

    return None


def _get_applicable_rate(txn: Transaction) -> Optional[float]:
    """
    Determines what the TDS rate SHOULD be after LDC relief, if any.
    """
    statutory_rate = _get_statutory_rate(txn)
    if txn.ldc_approved_rate is not None:
        return txn.ldc_approved_rate
    if txn.ldc_exemption_percent is not None and statutory_rate is not None:
        return statutory_rate * (1 - txn.ldc_exemption_percent / 100)
    return statutory_rate


# 194J has two legitimate rates (10% professional, 2% technical) but no
# independent way (yet) to know which one a given transaction IS without
# GL/nature-of-service data. To avoid false positives like Mahindra's own
# "TechServFees@2%" example, accept EITHER recognized rate as correct for
# 194J, and only flag if the deducted rate matches NEITHER.
SECTION_194J_VALID_RATES = {2.0, 10.0}


def check_short_excess_tds(txn: Transaction) -> Optional[TDSIssue]:
    """
    Categories: Short TDS Deducted / Excess TDS Deducted
    """
    if txn.tds_deducted_rate is None:
        return None

    deducted_rate = txn.tds_deducted_rate
    section = (txn.tds_deducted_section or "").strip().upper()

    # 194J special case — two valid rates, no false positive if either matches
    if section == "194J":
        if deducted_rate in SECTION_194J_VALID_RATES:
            return None
        return TDSIssue(
            category="Short/Excess TDS Deducted",
            message=f"TDS deducted at {deducted_rate}% under Sectionrat 194J, but valid rates are 2% (technical) or 10% (professional).",
            severity="high",
        )

    applicable_rate = _get_applicable_rate(txn)
    if applicable_rate is None:
        return None

    if deducted_rate < applicable_rate:
        return TDSIssue(
            category="Wrong TDS Rate",
            message=f"TDS deducted at {deducted_rate}%, but correct rate is {applicable_rate}% for section {section}.",
            severity="high",
            expected_rate=applicable_rate,
        )
    elif deducted_rate > applicable_rate:
        return TDSIssue(
            category="Wrong TDS Rate",
            message=f"TDS deducted at {deducted_rate}%, but correct rate is {applicable_rate}% for section {section}.",
            severity="high",
            expected_rate=applicable_rate,
        )

    return None

def check_amount_consistency(txn: Transaction) -> Optional[TDSIssue]:
    """
    Category: Short/Excess TDS Deducted (amount-derived)
    Independently verifies the deducted amount actually matches the
    stated rate applied to the base amount. Catches cases where the
    rate LABEL looks correct but the real math doesn't add up —
    e.g. rate says '1%' but deducted amount works out to 0.85%.

    Tolerance of ₹2 allows for standard rounding differences.
    """
    if txn.tds_deducted_amount is None or txn.tds_deducted_rate is None:
        return None  # need both to cross-check

    if not txn.basic_amount or txn.basic_amount == 0:
        return None  # can't compute a meaningful rate without a base

    section = (txn.tds_deducted_section or "").strip().upper()
    applicable_rate = _get_applicable_rate(txn)
    valid_194j_rate = section == "194J" and txn.tds_deducted_rate in SECTION_194J_VALID_RATES
    if applicable_rate is not None and txn.tds_deducted_rate != applicable_rate and not valid_194j_rate:
        return None  # wrong-rate issue already carries the correct amount context

    expected_amount = txn.basic_amount * (txn.tds_deducted_rate / 100)
    actual_amount = txn.tds_deducted_amount

    diff = abs(expected_amount - actual_amount)
    if diff <= 2:
        return None  # within rounding tolerance — fine

    implied_rate = (actual_amount / txn.basic_amount) * 100

    return TDSIssue(
        category="Short/Excess TDS Deducted — Amount Mismatch",
        message=(
            f"Stated rate is {txn.tds_deducted_rate}%, which should give "
            f"₹{expected_amount:,.2f} on a base of ₹{txn.basic_amount:,.2f}, "
            f"but ₹{actual_amount:,.2f} was actually deducted "
            f"(implied rate: {implied_rate:.4f}%)."
        ),
        severity="high",
    )


def check_excess_tds_exceeds_invoice(txn: Transaction) -> Optional[TDSIssue]:
    """
    Category: Excess TDS Deducted (structural sanity check)
    Ported from POC validate_excess_tds. TDS deducted can never
    legitimately exceed the full invoice/bill amount — if it does,
    something is structurally wrong with the entry (wrong base
    amount, decimal-place error, rate applied twice, etc.),
    regardless of whether the stated RATE itself looks correct.

    Deliberately compared against bill_amount (the full gross invoice
    value), NOT basic_amount (the GST-excluded TDS base). TDS
    exceeding the taxable base alone is a normal excess-TDS scenario,
    already caught by check_short_excess_tds / check_amount_consistency.
    Only exceeding the FULL invoice value is this specific,
    structurally-impossible red flag.
    """
    if txn.tds_deducted_amount is None or not txn.bill_amount:
        return None  # need both to compare

    invoice_amount = abs(float(txn.bill_amount))
    deducted_amount = abs(float(txn.tds_deducted_amount))
    if deducted_amount <= invoice_amount:
        return None  # within bounds — fine

    return TDSIssue(
        category="Excess TDS Deducted — Exceeds Invoice Amount",
        message=(
            f"TDS deducted (₹{deducted_amount:,.2f}) exceeds the "
            f"full invoice/bill amount (₹{invoice_amount:,.2f}). This is "
            f"not structurally possible and indicates a data or entry error."
        ),
        severity="high",
    )


def check_wrong_section_by_hsn(txn: Transaction) -> Optional[TDSIssue]:
    """
    Category: Excess/Short TDS Deducted (wrong section applied)

    RULE STATED BY MAHINDRA (from example remarks): HSN/SAC code
    starting with '9' indicates Services (194J applies), otherwise
    Goods (194Q applies).

    ⚠️ UNRESOLVED CONTRADICTION: One of Mahindra's own examples
    (HSN 995479, doc 2510817059) labels 194Q as correct and 194J as
    wrong for an HSN code that starts with 9 — which contradicts this
    stated rule. Flagged back to Mahindra for clarification. Until
    confirmed, this check may produce incorrect results for HSN codes
    starting with 9 specifically.
    """
    if not txn.hsn_sac_code or not txn.tds_deducted_section:
        return None

    hsn = txn.hsn_sac_code.strip()
    deducted_section = txn.tds_deducted_section.strip().upper()

    is_service = hsn.startswith("9")
    correct_section = "194J" if is_service else "194Q"

    if deducted_section not in ("194J", "194Q"):
        return None

    if deducted_section != correct_section:
        return TDSIssue(
            category="Wrong Section Applied",
            message=(
                f"HSN/SAC code {hsn} indicates "
                f"{'Services' if is_service else 'Goods'} "
                f"(should be Section {correct_section}), "
                f"but Section {deducted_section} was applied instead. "
                f"[Rule unconfirmed for HSN starting with 9 — see docstring]"
            ),
            severity="high",
        )

    return None


def check_wrong_section_by_payment_type(txn: Transaction) -> Optional[TDSIssue]:
    """General section validation from explicit or inferred payment type."""
    if not txn.transaction_kind:
        return None

    payment_type = txn.transaction_kind.strip().lower().replace(" ", "_").replace("-", "_")
    expected_section = PAYMENT_TYPE_TO_SECTION.get(payment_type)
    if not expected_section:
        return None

    actual_section = (txn.tds_deducted_section or txn.tds_legacy_section or "").strip().upper()
    if actual_section == expected_section:
        return None

    actual_label = actual_section or "section not recognised"
    return TDSIssue(
        category="Wrong Section Applied",
        message=(
            f"Payment type '{txn.transaction_kind}' requires section "
            f"{expected_section}, but {actual_label} was applied."
        ),
        severity="high",
        expected_section=expected_section,
    )


def check_lower_deduction_cert(txn: Transaction) -> Optional[TDSIssue]:
    """
    Category: TDS Deducted as per LDC
    Ported from POC validate_lower_deduction_cert. Form 197 (LDC) allows
    a certified lower/nil rate. Also checks certificate validity window
    (Exempt From / Exempt To) — confirmed available via SAP Business
    Partner Withholding Tax screen.
    """
    if txn.ldc_exemption_percent is None and txn.ldc_approved_rate is None:
        return None  # no LDC on this vendor — skip, other checks apply

    # Check certificate is valid on the posting date
    if txn.ldc_exempt_from and txn.posting_date < txn.ldc_exempt_from:
        return TDSIssue(
            category="LDC Not Yet Valid",
            message=f"LDC certificate {txn.ldc_exemption_number} is not valid until {txn.ldc_exempt_from}, but transaction posted on {txn.posting_date}.",
            severity="high",
        )

    if txn.ldc_exempt_to and txn.posting_date > txn.ldc_exempt_to:
        return TDSIssue(
            category="LDC Expired",
            message=f"LDC certificate {txn.ldc_exemption_number} expired on {txn.ldc_exempt_to}, but transaction posted on {txn.posting_date}. Normal TDS rules should apply.",
            severity="high",
        )

    if txn.basic_amount is None:
        return None  # certificate validity can be checked above; amount cannot
    if txn.ldc_approved_rate is not None:
        cert_rate = txn.ldc_approved_rate
        rate_text = f"approved LDC rate {cert_rate}%"
    else:
        applicable_rate = _get_statutory_rate(txn) or 0.0
        cert_rate = applicable_rate * (1 - txn.ldc_exemption_percent / 100)
        rate_text = f"{txn.ldc_exemption_percent}% exemption"
    expected_tds = txn.basic_amount * (cert_rate / 100)
    actual_tds = txn.tds_deducted_amount or 0.0

    if abs(expected_tds - actual_tds) > 1:
        return TDSIssue(
            category="TDS Deducted as per LDC — Mismatch",
            message=f"LDC certificate {txn.ldc_exemption_number} allows {rate_text}. Expected TDS ~₹{expected_tds:.2f}, but ₹{actual_tds:.2f} was deducted.",
            severity="high",
            expected_rate=cert_rate,
        )

    return TDSIssue(
        category="TDS Deducted as per LDC",
        message=f"Correctly applied LDC certificate {txn.ldc_exemption_number} ({rate_text}).",
        severity="low",
        expected_rate=cert_rate,
    )



def check_timing(txn: Transaction) -> Optional[TDSIssue]:
    """
    Categories: 100% TDS on Advance / Partial TDS on Advance (missed cases)
    Ported from POC validate_timing. TDS must be deducted at credit or
    payment, whichever is earlier. Checks two scenarios: advance payments
    (TDS due at payment time) and year-end provision entries (TDS due
    at credit time).
    """
    applicable_rate = _get_applicable_rate(txn)
    if applicable_rate is None:
        return None  # can't determine applicability — skip

    deducted = txn.tds_deducted_amount or 0.0

    if txn.is_advance_payment and deducted == 0:
        return TDSIssue(
            category="TDS Not Deducted — Advance Payment",
            message="TDS not deducted on advance payment. TDS is due at the time of payment (whichever is earlier: credit or payment).",
            severity="high",
        )

    if txn.is_provision_entry and deducted == 0:
        return TDSIssue(
            category="TDS Not Deducted — Provision Entry",
            message="TDS not deducted on year-end provision entry. TDS is due at the time of credit to the payee's account.",
            severity="high",
        )

    return None


def check_206ab_non_filer(txn: Transaction) -> Optional[TDSIssue]:
    """
    Category: Short TDS Deducted (non-filer case)
    Ported from POC validate_206ab. If vendor is a non-filer (hasn't
    filed ITR for preceding 2 years), TDS must be at the higher of
    2x the section rate or 5%.

    This function only runs when PAN IS present and valid — it is a
    later override in the chain, so check_pan_validity() already
    returns first (and never falls through to here) whenever PAN is
    missing/invalid. To make sure a non-filer vendor with a missing
    PAN still gets the correct (higher) rate, check_pan_validity()
    itself now also computes the 206AB rate in that case and applies
    whichever of 206AA/206AB is higher — see its docstring.
    """
    if not txn.is_non_filer:
        return None

    section_rate = _get_applicable_rate(txn)
    if section_rate is None:
        return None

    # rate value in YAML is descriptive text, so use POC's confirmed 5% floor
    required_rate = max(section_rate * 2, 5.0)

    deducted = txn.tds_deducted_rate or 0.0

    if deducted < required_rate:
        return TDSIssue(
            category="Short TDS Deducted — Non-Filer (206AB)",
            message=f"Vendor is a non-filer (Section 206AB) — TDS must be {required_rate}% (higher of 2x section rate or 5%), but only {deducted}% was deducted.",
            severity="high",
        )

    return None


def check_form_15g_15h(txn: Transaction) -> Optional[TDSIssue]:
    """
    Category: TDS Not Applicable (Form 15G/15H exemption)
    Ported from POC validate_form_15g_15h. If a valid Form 15G/15H is
    on file, TDS should be nil — deducting TDS anyway is the error.
    """
    if not txn.has_form_15g_15h:
        return None

    deducted = txn.tds_deducted_amount or 0.0

    if deducted > 0:
        return TDSIssue(
            category="TDS Not Applicable — Violation (Form 15G/15H)",
            message=f"Form 15G/15H is on file — TDS deduction is not required, but ₹{deducted} was deducted anyway.",
            severity="medium",
        )

    return TDSIssue(
        category="TDS Not Applicable",
        message="Correctly not applicable — valid Form 15G/15H on file.",
        severity="low",
    )


def is_transporter_exempt(txn: Transaction) -> bool:
    """
    Returns True when the 194C transporter exemption applies.
    Conditions: section is 194C AND vendor is a registered transporter
    AND PAN is available. If PAN is missing, 206AA (20%) governs
    regardless — handled by check_pan_validity separately.
    """
    return (
        txn.tds_deducted_section == "194C"
        and bool(txn.is_transporter)
        and _is_valid_pan_format(txn.vendor_pan)
    )


def check_transporter_exemption(txn: Transaction) -> Optional[TDSIssue]:
    """
    Category: TDS Not Applicable (Transporter Exemption, 194C)
    """
    if not is_transporter_exempt(txn):
        return None

    deducted = txn.tds_deducted_amount or 0.0

    if deducted > 0:
        return TDSIssue(
            category="TDS Not Applicable — Violation (Transporter Exemption)",
            message=f"Vendor is a registered transporter with valid PAN — Section 194C exemption applies, but ₹{deducted} TDS was deducted anyway.",
            severity="medium",
        )

    return TDSIssue(
        category="TDS Not Applicable",
        message="Correctly not applicable — registered transporter exemption (194C) with valid PAN.",
        severity="low",
    )



def check_residential_status(txn: Transaction) -> Optional[TDSIssue]:
    """
    Category: Wrong Section Applied (Residential Status mismatch)
    Ported from POC validate_residential_status. Non-resident vendors
    must be processed under Section 195 (or 196A-D). Resident vendors
    must NOT be processed under non-resident sections.
    """
    if not txn.residential_status or not txn.tds_deducted_section:
        return None

    res_norm = (
        txn.residential_status.lower()
        .replace("-", "").replace("_", "").replace(" ", "")
    )
    section = txn.tds_deducted_section.strip().upper()

    if res_norm == "nonresident" and section not in NON_RESIDENT_SECTIONS:
        return TDSIssue(
            category="Wrong Section Applied — Non-Resident",
            message=f"Vendor is a non-resident — Section 195 (or applicable 196x) should apply, but Section {section} was used.",
            severity="high",
        )

    if res_norm == "resident" and section in NON_RESIDENT_SECTIONS:
        return TDSIssue(
            category="Wrong Section Applied — Resident",
            message=f"Vendor is a resident — Section {section} applies to non-residents only.",
            severity="high",
        )

    return None



def _is_supporting_adjustment_without_tds(txn: Transaction) -> bool:
    """Adjustment rows support a document case, but should not create standalone TDS issues."""
    doc_type = (txn.doc_type or "").strip().upper()
    has_tds_signal = bool(txn.tds_deducted_section or txn.tds_deducted_rate or txn.tds_deducted_amount)
    return doc_type == "AB" and not has_tds_signal


def _is_payment_without_advance_obligation(txn: Transaction) -> bool:
    """Plain KZ payment rows support clearing, but TDS-bearing KZ rows still get validated."""
    doc_type = (txn.doc_type or "").strip().upper()
    has_tds_signal = bool(txn.tds_deducted_section or txn.tds_deducted_rate or txn.tds_deducted_amount)
    return doc_type == "KZ" and not txn.is_advance_payment and not has_tds_signal


def run_all_checks(txn: Transaction) -> list[TDSIssue]:
    """
    Runs transaction-level TDS checks in priority order.

    The order matters. Some rules are override rules and must stop
    standard validation to avoid duplicate/noisy issues.
    """
    issues = []

    if _is_supporting_adjustment_without_tds(txn):
        return issues

    # 1. Applicability override.
    gl_issue = check_tds_not_applicable(txn)
    if gl_issue is not None:
        issues.append(gl_issue)
        return issues

    # 2. PAN/206AA override.
    pan_issue = check_pan_validity(txn)
    if pan_issue is not None:
        issues.append(pan_issue)
        return issues

    # 3. Form 15G/15H nil deduction override.
    form_issue = check_form_15g_15h(txn)
    if form_issue is not None:
        issues.append(form_issue)
        return issues

    # 4. Transporter exemption override.
    transporter_issue = check_transporter_exemption(txn)
    if transporter_issue is not None:
        issues.append(transporter_issue)
        return issues

    # 5. Section/nature checks must pass before a lower-rate certificate
    # can be applied. An LDC does not correct a wrong statutory section.
    wrong_payment_section_issue = check_wrong_section_by_payment_type(txn)
    if wrong_payment_section_issue is not None:
        issues.append(wrong_payment_section_issue)
        return issues

    residential_issue = check_residential_status(txn)
    if residential_issue is not None:
        issues.append(residential_issue)
        return issues

    hsn_section_issue = check_wrong_section_by_hsn(txn)
    if hsn_section_issue is not None:
        issues.append(hsn_section_issue)
        return issues

    # 6. Form 197/LDC override.
    ldc_issue = check_lower_deduction_cert(txn)
    if ldc_issue is not None:
        issues.append(ldc_issue)
        return issues

    # 7. Non-filer higher-rate override.
    non_filer_issue = check_206ab_non_filer(txn)
    if non_filer_issue is not None:
        issues.append(non_filer_issue)
        return issues

    # 8. Normal transaction checks.
    normal_checks = [
        check_timing,
        check_short_excess_tds,
        check_amount_consistency,
        check_excess_tds_exceeds_invoice,
    ]

    for check_fn in normal_checks:
        result = check_fn(txn)
        if result is not None:
            issues.append(result)

    return issues



def _money(value: float | None) -> float:
    return round(float(value or 0.0), 2)


def _txn_base(txn: Transaction) -> float:
    return abs(float(txn.basic_amount if txn.basic_amount is not None else txn.bill_amount or 0.0))


def _advance_invoice_direct_match(advance: Transaction, invoice: Transaction) -> bool:
    if not advance.invoice_reference_document:
        return False
    if str(advance.invoice_reference_document).strip().lstrip("0") != str(invoice.doc_number or "").strip().lstrip("0"):
        return False
    if advance.invoice_reference_fiscal_year and invoice.fiscal_year:
        return str(advance.invoice_reference_fiscal_year).strip() == str(invoice.fiscal_year).strip()
    return True


def _advance_invoice_clearing_match(advance: Transaction, invoice: Transaction) -> bool:
    if not advance.clearing_document or not invoice.clearing_document:
        return False
    if str(advance.clearing_document).strip() != str(invoice.clearing_document).strip():
        return False
    if advance.clearing_fiscal_year and invoice.clearing_fiscal_year:
        return str(advance.clearing_fiscal_year).strip() == str(invoice.clearing_fiscal_year).strip()
    return True


def _advance_invoice_assignment_match(advance: Transaction, invoice: Transaction) -> bool:
    advance_assignment = _normalised_doc_key(advance.assignment_number)
    invoice_assignment = _normalised_doc_key(invoice.assignment_number)
    invoice_doc = _normalised_doc_key(invoice.doc_number)
    if not advance_assignment:
        return False
    return advance_assignment in {invoice_assignment, invoice_doc}


def _same_vendor_company(advance: Transaction, invoice: Transaction) -> bool:
    if (advance.company_code or "").strip() != (invoice.company_code or "").strip():
        return False
    if advance.vendor_pan and invoice.vendor_pan:
        return advance.vendor_pan.strip().upper() == invoice.vendor_pan.strip().upper()
    return (advance.vendor_code or "").strip() == (invoice.vendor_code or "").strip()


def _normalised_doc_key(value: str | None) -> str:
    return str(value or "").strip().lstrip("0")


def _vendor_match_key(txn: Transaction) -> str:
    if txn.vendor_pan:
        return f"PAN:{txn.vendor_pan.strip().upper()}"
    return f"VENDOR:{(txn.vendor_code or '').strip()}"


def check_advance_payment_lifecycle(transactions: list[Transaction]) -> list[tuple[Transaction, TDSIssue]]:
    """Validate full/partial vendor advances against linked invoice balances.

    Link order: REBZG/REBZJ/REBZZ first, then Assignment_Number/ZUONR.
    Clearing documents can include ordinary invoice/payment lines, so they
    are used for ledger grouping only, not for raising advance lifecycle issues.
    For partial advances, required TDS is checked in two pieces:
      1. advance amount at payment time
      2. remaining invoice base at invoice time
    """
    issues: list[tuple[Transaction, TDSIssue]] = []
    advances = [txn for txn in transactions if txn.is_advance_payment]
    invoices = [
        txn for txn in transactions
        if not txn.is_advance_payment and (txn.doc_type or "").strip().upper() in {"RE", "KR"}
    ]
    direct_index: dict[tuple[str, str, str], list[Transaction]] = defaultdict(list)
    assignment_index: dict[tuple[str, str, str], list[Transaction]] = defaultdict(list)

    for advance in advances:
        company = (advance.company_code or "").strip()
        vendor = _vendor_match_key(advance)
        reference_doc = _normalised_doc_key(advance.invoice_reference_document)
        if reference_doc:
            direct_index[(company, vendor, reference_doc)].append(advance)
        assignment = _normalised_doc_key(advance.assignment_number)
        if assignment:
            assignment_index[(company, vendor, assignment)].append(advance)

    for invoice in invoices:
        company = (invoice.company_code or "").strip()
        vendor = _vendor_match_key(invoice)
        candidates: list[Transaction] = []
        invoice_doc = _normalised_doc_key(invoice.doc_number)
        if invoice_doc:
            candidates.extend(direct_index.get((company, vendor, invoice_doc), []))
        assignment = _normalised_doc_key(invoice.assignment_number)
        if assignment:
            candidates.extend(assignment_index.get((company, vendor, assignment), []))
        if invoice_doc:
            candidates.extend(assignment_index.get((company, vendor, invoice_doc), []))

        seen: set[int] = set()
        linked_advances = []
        for advance in candidates:
            if id(advance) in seen:
                continue
            seen.add(id(advance))
            if _same_vendor_company(advance, invoice) and (
                _advance_invoice_direct_match(advance, invoice)
                or _advance_invoice_assignment_match(advance, invoice)
            ):
                linked_advances.append(advance)
        if not linked_advances:
            continue

        section_rate = _get_applicable_rate(invoice)
        if section_rate is None:
            section_rate = _get_applicable_rate(linked_advances[0])
        if section_rate is None:
            continue

        invoice_base = _txn_base(invoice)
        advance_base = min(sum(_txn_base(advance) for advance in linked_advances), invoice_base)
        remaining_base = max(invoice_base - advance_base, 0.0)
        expected_advance_tds = _money(advance_base * section_rate / 100)
        expected_invoice_tds = _money(remaining_base * section_rate / 100)
        actual_advance_tds = _money(sum(abs(advance.tds_deducted_amount or 0.0) for advance in linked_advances))
        actual_invoice_tds = _money(abs(invoice.tds_deducted_amount or 0.0))
        actual_total_tds = _money(actual_advance_tds + actual_invoice_tds)
        expected_total_tds = _money(expected_advance_tds + expected_invoice_tds)

        if expected_advance_tds > 0 and actual_advance_tds == 0:
            issues.append((
                linked_advances[0],
                TDSIssue(
                    category="TDS Not Deducted — Advance Payment",
                    message=(
                        f"Advance payment linked to invoice {invoice.doc_number} required TDS "
                        f"of ₹{expected_advance_tds:,.2f} on advance base ₹{advance_base:,.2f}, "
                        "but no TDS was deducted on the advance."
                    ),
                    severity="high",
                    expected_rate=section_rate,
                ),
            ))

        if (
            actual_advance_tds > TDS_AMOUNT_ROUNDING_TOLERANCE
            and actual_invoice_tds > expected_invoice_tds + TDS_AMOUNT_ROUNDING_TOLERANCE
        ):
            issues.append((
                invoice,
                TDSIssue(
                    category="Excess TDS Deducted — Advance Adjusted Invoice",
                    message=(
                        f"Advance TDS of ₹{actual_advance_tds:,.2f} is already available. "
                        f"Invoice balance base is ₹{remaining_base:,.2f}, so expected invoice TDS is "
                        f"₹{expected_invoice_tds:,.2f}, but ₹{actual_invoice_tds:,.2f} was deducted."
                    ),
                    severity="medium",
                    expected_rate=section_rate,
                ),
            ))
        elif actual_total_tds + TDS_AMOUNT_ROUNDING_TOLERANCE < expected_total_tds:
            issues.append((
                invoice,
                TDSIssue(
                    category="Short TDS Deducted — Advance Adjusted Invoice",
                    message=(
                        f"Linked advance/invoice chain expected total TDS ₹{expected_total_tds:,.2f} "
                        f"(advance ₹{expected_advance_tds:,.2f} + invoice balance ₹{expected_invoice_tds:,.2f}), "
                        f"but only ₹{actual_total_tds:,.2f} was deducted."
                    ),
                    severity="high",
                    expected_rate=section_rate,
                ),
            ))

    return issues

def _get_financial_year(d: date) -> str:
    """
    Indian FY runs April to March. Returns e.g. '2025-26' for any
    date between 1-Apr-2025 and 31-Mar-2026.
    """
    if d.month >= 4:
        return f"{d.year}-{str(d.year + 1)[-2:]}"
    else:
        return f"{d.year - 1}-{str(d.year)[-2:]}"


def check_threshold_breach(transactions: list[Transaction]) -> list[tuple[Transaction, TDSIssue]]:
    """
    Categories: TDS Not Deducted / Short Deducted / TDS Not Applicable (threshold-based)
    Ported from POC validate_threshold + validate_50l_threshold.

    Groups transactions by vendor PAN + section + financial year,
    tracks cumulative payment amount, and flags two scenarios:
      a) Threshold crossed but NO TDS was deducted at all.
      b) Threshold crossed but the TDS deducted falls short of what's
         required on the full cumulative amount (partial compliance).

    Confirmed rule: once threshold is crossed, TDS applies to the
    FULL cumulative amount, not just the excess.
    """
    issues: list[tuple[Transaction, TDSIssue]] = []

    groups: dict[tuple, list[Transaction]] = defaultdict(list)
    for txn in transactions:
        if not txn.vendor_pan or not txn.tds_deducted_section or not txn.posting_date:
            continue
        fy = _get_financial_year(txn.posting_date)
        key = (txn.vendor_pan.upper(), txn.tds_deducted_section.strip().upper(), fy)
        groups[key].append(txn)

    for (pan, section, fy), group_txns in groups.items():
        section_config = SECTIONS.get(section)
        if not section_config:
            continue

        threshold_config = section_config.get("threshold")
        if threshold_config is None:
            continue

        if isinstance(threshold_config, dict):
            aggregate_threshold = (
                threshold_config.get("aggregate_fy")
                or threshold_config.get("others")
                or threshold_config.get("bank_post_office")
            )
        else:
            aggregate_threshold = threshold_config

        if not aggregate_threshold:
            continue

        # A missing base is never treated as zero (false threshold call).
        # But ONE transaction missing its base must not blank the WHOLE
        # group — use whatever base amounts ARE known, and note if some
        # were excluded.
        known_base_txns = [t for t in group_txns if t.basic_amount is not None]
        unknown_base_count = len(group_txns) - len(known_base_txns)
        if not known_base_txns:
            continue  # no usable base at all — cannot evaluate this group

        cumulative_basic_amount = sum(t.basic_amount for t in known_base_txns)
        cumulative_tds_deducted = sum(t.tds_deducted_amount or 0.0 for t in group_txns)

        incomplete_note = (
            f" (NOTE: {unknown_base_count} of {len(group_txns)} transaction(s) had no "
            f"base amount and were excluded from this total — actual cumulative may be higher.)"
            if unknown_base_count else ""
        )

        threshold_crossed = cumulative_basic_amount >= aggregate_threshold

        if threshold_crossed:
            has_row_level_shortfall = any(
                check_short_excess_tds(t) is not None or check_amount_consistency(t) is not None
                for t in group_txns
            )
            if has_row_level_shortfall:
                continue

            # Check MAGNITUDE, not just zero-vs-nonzero.
            statutory_rate = _get_applicable_rate(group_txns[0])
            if statutory_rate is not None:
                required_tds = cumulative_basic_amount * statutory_rate / 100.0
                tolerance = max(2.0, 2.0 * len(group_txns))  # ~₹2/txn rounding allowance
                shortfall = required_tds - cumulative_tds_deducted

                if shortfall > tolerance:
                    if cumulative_tds_deducted == 0:
                        category = "TDS Not Deducted — Threshold Crossed"
                        detail = f"but no TDS was deducted across {len(group_txns)} transaction(s)."
                    else:
                        category = "TDS Short Deducted — Threshold Crossed"
                        detail = (
                            f"requiring approx. ₹{required_tds:,.2f} TDS in total, but "
                            f"only ₹{cumulative_tds_deducted:,.2f} was deducted across "
                            f"{len(group_txns)} transaction(s)."
                        )
                    issues.append((group_txns[0], TDSIssue(
                        category=category,
                        message=(
                            f"Vendor PAN {pan}, Section {section}, FY {fy}: cumulative "
                            f"payments ₹{cumulative_basic_amount:,.2f} crossed the threshold "
                            f"of ₹{aggregate_threshold:,.2f}, {detail}{incomplete_note}"
                        ),
                        severity="high",
                    )))
            elif cumulative_tds_deducted == 0:
                # No statutory rate available for this section (e.g. a
                # DTAA-based rate like 195) — fall back to the zero-check
                # rather than skipping the group entirely.
                issues.append((group_txns[0], TDSIssue(
                    category="TDS Not Deducted — Threshold Crossed",
                    message=(
                        f"Vendor PAN {pan}, Section {section}, FY {fy}: cumulative "
                        f"payments ₹{cumulative_basic_amount:,.2f} crossed the threshold "
                        f"of ₹{aggregate_threshold:,.2f}, but no TDS was deducted across "
                        f"{len(group_txns)} transaction(s).{incomplete_note}"
                    ),
                    severity="high",
                )))

    return issues


# ============================================================
# CHECK 9 — Missing TDS Deduction (GL Cross-Reference)
# ============================================================

def check_missing_deduction(transactions: list[Transaction]) -> list[tuple[Transaction, TDSIssue]]:
    """
    Category: Possible Missed TDS Deduction

    Batch-level check (same pattern as check_threshold_breach) — needs
    to see all transactions first, to learn each GL account's normal
    TDS behavior, before it can judge whether a blank-TDS row on that
    same GL is suspicious.

    We do not have a reliable, complete GL exclusion list yet
    (config/gl_accounts.yaml is empty; the description-text list in
    tds_sections.yaml doesn't match on gl_account — see check_tds_not_applicable).
    Until Mahindra provides one, we use each GL account's own observed
    behavior within THIS batch as the reference point: if most
    transactions on a GL do have TDS deducted, a blank one on that same
    GL is worth a human's attention. If a GL never has TDS on it
    anywhere in the batch, we don't have enough evidence to say
    anything, so we deliberately stay silent rather than guess.

    Returns (transaction, issue) pairs so each flagged row is attached
    to its own real transaction — not a shared/first transaction.
    """
    results: list[tuple[Transaction, TDSIssue]] = []

    # ---- Step 1: learn each (company_code, gl_account)'s TDS behavior ----
    gl_stats: dict[tuple, dict] = defaultdict(lambda: {
        "with_tds": 0, "total": 0, "sample_section": None, "sample_rate": None
    })

    for txn in transactions:
        if _is_supporting_adjustment_without_tds(txn) or _is_payment_without_advance_obligation(txn):
            continue
        if not txn.gl_account:
            continue
        key = (txn.company_code, txn.gl_account)
        stats = gl_stats[key]
        stats["total"] += 1
        if txn.tds_deducted_section and txn.tds_deducted_rate:
            stats["with_tds"] += 1
            if stats["sample_section"] is None:  # keep one real example for the message
                stats["sample_section"] = txn.tds_deducted_section
                stats["sample_rate"] = txn.tds_deducted_rate

    # ---- Step 2: evaluate each blank-TDS transaction against its GL's stats ----
    for txn in transactions:
        if _is_supporting_adjustment_without_tds(txn) or _is_payment_without_advance_obligation(txn):
            continue
        if txn.tds_deducted_section or txn.tds_deducted_rate:
            continue  # already has TDS data — not this check's concern

        if not txn.gl_account:
            continue  # can't cross-reference without a GL account

        if _is_gl_excluded(txn.gl_account):
            continue  # genuinely excluded — check_tds_not_applicable already confirms this correctly

        key = (txn.company_code, txn.gl_account)
        stats = gl_stats[key]
        if stats["total"] <= 1 or stats["with_tds"] == 0:
            continue  # no corroborating evidence this GL is ever TDS-relevant — stay silent

        coverage = stats["with_tds"] / stats["total"]
        basic_amount = txn.basic_amount if txn.basic_amount is not None else txn.bill_amount
        severity = "medium" if coverage >= MISSING_DEDUCTION_COVERAGE_THRESHOLD else "low"

        results.append((txn, TDSIssue(
            category="Possible Missed TDS Deduction",
            message=(
                f"GL {txn.gl_account} ({txn.gl_description or 'no description'}) shows TDS "
                f"deducted at {stats['sample_rate']}% under {stats['sample_section']} on "
                f"{stats['with_tds']} of {stats['total']} transactions in this batch, but not "
                f"on this one (doc {txn.doc_number}, basic amount {basic_amount}). This may be "
                f"a missed deduction, or the vendor's cumulative payments may not have crossed "
                f"the applicable threshold yet — recommend manual review."
            ),
            severity=severity,
            expected_rate=stats["sample_rate"],
        )))

    return results
