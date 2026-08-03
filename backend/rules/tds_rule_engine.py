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


# ============================================================
# ISSUE RESULT — what every check function returns
# ============================================================

class TDSIssue:
    """
    Represents the outcome of running a transaction through the
    rule engine. category matches Mahindra's own 8 classifications.
    """
    def __init__(self, category: str, message: str, severity: str = "medium", issue_code: Optional[str] = None):
        self.category = category
        self.message = message
        self.severity = severity  # "high", "medium", "low"
        self.issue_code = issue_code or category.upper().replace(" ", "_")

    def __repr__(self):
        return f"<TDSIssue category={self.category} severity={self.severity}>"

    def to_dict(self):
        return {"issue_code": self.issue_code,"category": self.category, "message": self.message, "severity": self.severity}


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
        )

    if txn.tds_deducted_rate < required_rate:
        return TDSIssue(
            category="PAN Missing/Invalid — Short TDS Deducted",
            message=f"Vendor PAN is {reason}. Section {rule_applied} requires {required_rate}% TDS, but only {txn.tds_deducted_rate}% was deducted.",
            severity="high",
        )

    return TDSIssue(
        category="PAN Missing/Invalid — Correctly Handled",
        message=f"Vendor PAN is {reason}, and the required {required_rate}% TDS ({rule_applied}) was correctly applied.",
        severity="low",
    )


def _is_pan_operative(pan: str) -> Optional[bool]:
    """
    PLACEHOLDER for future Government PAN verification API integration.
    Returns None until real API access is available — meaning this
    check is currently skipped, not failed.
    """
    return None



def _get_applicable_rate(txn: Transaction) -> Optional[float]:
    """
    Determines what the TDS rate SHOULD be for this transaction.
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
            message=f"TDS deducted at {deducted_rate}% under Section 194J, but valid rates are 2% (technical) or 10% (professional).",
            severity="high",
        )

    applicable_rate = _get_applicable_rate(txn)
    if applicable_rate is None:
        return None

    if deducted_rate < applicable_rate:
        return TDSIssue(
            category="Short TDS Deducted",
            message=f"TDS deducted at {deducted_rate}%, but correct rate is {applicable_rate}% for section {section}.",
            severity="high",
        )
    elif deducted_rate > applicable_rate:
        return TDSIssue(
            category="Excess TDS Deducted",
            message=f"TDS deducted at {deducted_rate}%, but correct rate is {applicable_rate}% for section {section}.",
            severity="medium",
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

    if txn.tds_deducted_amount <= txn.bill_amount:
        return None  # within bounds — fine

    return TDSIssue(
        category="Excess TDS Deducted — Exceeds Invoice Amount",
        message=(
            f"TDS deducted (₹{txn.tds_deducted_amount:,.2f}) exceeds the "
            f"full invoice/bill amount (₹{txn.bill_amount:,.2f}). This is "
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


def check_lower_deduction_cert(txn: Transaction) -> Optional[TDSIssue]:
    """
    Category: TDS Deducted as per LDC
    Ported from POC validate_lower_deduction_cert. Form 197 (LDC) allows
    a certified lower/nil rate. Also checks certificate validity window
    (Exempt From / Exempt To) — confirmed available via SAP Business
    Partner Withholding Tax screen.
    """
    if txn.ldc_exemption_percent is None:
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

    applicable_rate = _get_applicable_rate(txn) or 0.0
    if txn.basic_amount is None:
        return None  # certificate validity can be checked above; amount cannot
    cert_rate = applicable_rate * (1 - txn.ldc_exemption_percent / 100)
    expected_tds = txn.basic_amount * (cert_rate / 100)
    actual_tds = txn.tds_deducted_amount or 0.0

    if abs(expected_tds - actual_tds) > 1:
        return TDSIssue(
            category="TDS Deducted as per LDC — Mismatch",
            message=f"LDC certificate {txn.ldc_exemption_number} allows {txn.ldc_exemption_percent}% exemption. Expected TDS ~₹{expected_tds:.2f}, but ₹{actual_tds:.2f} was deducted.",
            severity="high",
        )

    return TDSIssue(
        category="TDS Deducted as per LDC",
        message=f"Correctly applied LDC certificate {txn.ldc_exemption_number} ({txn.ldc_exemption_percent}% exemption).",
        severity="low",
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



def run_all_checks(txn: Transaction) -> list[TDSIssue]:
    """
    Runs transaction-level TDS checks in priority order.

    The order matters. Some rules are override rules and must stop
    standard validation to avoid duplicate/noisy issues.
    """
    issues = []

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

    # 5. Form 197/LDC override.
    ldc_issue = check_lower_deduction_cert(txn)
    if ldc_issue is not None:
        issues.append(ldc_issue)
        return issues

    # 6. Non-filer higher-rate override.
    non_filer_issue = check_206ab_non_filer(txn)
    if non_filer_issue is not None:
        issues.append(non_filer_issue)
        return issues

    # 7. Normal transaction checks.
    normal_checks = [
        check_residential_status,
        check_wrong_section_by_hsn,
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


def _get_financial_year(d: date) -> str:
    """
    Indian FY runs April to March. Returns e.g. '2025-26' for any
    date between 1-Apr-2025 and 31-Mar-2026.
    """
    if d.month >= 4:
        return f"{d.year}-{str(d.year + 1)[-2:]}"
    else:
        return f"{d.year - 1}-{str(d.year)[-2:]}"


def check_threshold_breach(transactions: list[Transaction]) -> list[TDSIssue]:
    """
    Categories: TDS Not Deducted / Short Deducted / TDS Not Applicable (threshold-based)
    Ported from POC validate_threshold + validate_50l_threshold.

    Groups transactions by vendor PAN + section + financial year,
    tracks cumulative payment amount, and flags three scenarios:
      a) Threshold crossed but NO TDS was deducted at all.
      b) Threshold crossed but the TDS deducted falls short of what's
         required on the full cumulative amount (partial compliance).
      c) TDS was deducted even though the aggregate hasn't crossed
         the threshold yet (premature deduction).

    Confirmed rule: once threshold is crossed, TDS applies to the
    FULL cumulative amount, not just the excess.
    """
    issues: list[TDSIssue] = []

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
                    issues.append(TDSIssue(
                        category=category,
                        message=(
                            f"Vendor PAN {pan}, Section {section}, FY {fy}: cumulative "
                            f"payments ₹{cumulative_basic_amount:,.2f} crossed the threshold "
                            f"of ₹{aggregate_threshold:,.2f}, {detail}{incomplete_note}"
                        ),
                        severity="high",
                    ))
            elif cumulative_tds_deducted == 0:
                # No statutory rate available for this section (e.g. a
                # DTAA-based rate like 195) — fall back to the zero-check
                # rather than skipping the group entirely.
                issues.append(TDSIssue(
                    category="TDS Not Deducted — Threshold Crossed",
                    message=(
                        f"Vendor PAN {pan}, Section {section}, FY {fy}: cumulative "
                        f"payments ₹{cumulative_basic_amount:,.2f} crossed the threshold "
                        f"of ₹{aggregate_threshold:,.2f}, but no TDS was deducted across "
                        f"{len(group_txns)} transaction(s).{incomplete_note}"
                    ),
                    severity="high",
                ))
        elif cumulative_tds_deducted > 0:
            issues.append(TDSIssue(
                category="TDS Not Applicable — Premature Deduction",
                message=(
                    f"Vendor PAN {pan}, Section {section}, FY {fy}: cumulative "
                    f"payments ₹{cumulative_basic_amount:,.2f} have NOT crossed the "
                    f"threshold of ₹{aggregate_threshold:,.2f}, but TDS of "
                    f"₹{cumulative_tds_deducted:,.2f} was deducted anyway.{incomplete_note}"
                ),
                severity="medium",
            ))

    return issues