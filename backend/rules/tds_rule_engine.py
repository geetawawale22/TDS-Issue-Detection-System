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
    def __init__(self, category: str, message: str, severity: str = "medium"):
        self.category = category
        self.message = message
        self.severity = severity  # "high", "medium", "low"

    def __repr__(self):
        return f"<TDSIssue category={self.category} severity={self.severity}>"

    def to_dict(self):
        return {"category": self.category, "message": self.message, "severity": self.severity}


# ============================================================
# CHECK 1 — TDS Not Applicable (GL-based exclusions)
# ============================================================

def _is_gl_excluded(gl_account: str) -> Optional[str]:
    """
    Checks if this GL account is in our known 'TDS not applicable' list.
    Returns the exclusion reason if excluded, None otherwise.
    """
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
    Category: PAN Validation (Section 206AA)
    If PAN is missing or malformed, the higher 20% rate must apply
    (5% cap instead, specifically for Section 194Q).

    NOTE: This checks PAN PRESENCE and FORMAT only, using SAP data.
    It does NOT confirm the PAN is genuinely active/operative with the
    Income Tax Department — that requires the Government PAN
    verification API, which is not yet available (pending Mahindra).
    Once available, plug the real check into _is_pan_operative() below.
    """
    if _is_valid_pan_format(txn.vendor_pan):
        return None  # PAN looks fine — 206AA doesn't apply, continue other checks

    # PAN missing or malformed — 206AA requires the higher rate
    section_206aa = CROSS_RULES.get("section_206AA", {})
    required_rate = section_206aa.get("rate", 20.0)

    # Section 194Q has a special 5% cap instead of 20%
    if txn.tds_deducted_section and txn.tds_deducted_section.strip().upper() == "194Q":
        required_rate = section_206aa.get("exception_194Q", 5.0)

    reason = "missing" if not txn.vendor_pan else "invalid format"

    if txn.tds_deducted_rate is None:
        return TDSIssue(
            category="PAN Missing/Invalid — TDS Not Deducted",
            message=f"Vendor PAN is {reason}. Section 206AA requires {required_rate}% TDS, but nothing was deducted.",
            severity="high",
        )

    if txn.tds_deducted_rate < required_rate:
        return TDSIssue(
            category="PAN Missing/Invalid — Short TDS Deducted",
            message=f"Vendor PAN is {reason}. Section 206AA requires {required_rate}% TDS, but only {txn.tds_deducted_rate}% was deducted.",
            severity="high",
        )

    return TDSIssue(
        category="PAN Missing/Invalid — Correctly Handled",
        message=f"Vendor PAN is {reason}, and the required {required_rate}% TDS was correctly applied.",
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
    # Priority 1: Mahindra's own confirmed applicable rate, once available
    if txn.tds_applicable_rate is not None:
        return txn.tds_applicable_rate

    # Priority 2: calculate from our config, using the DEDUCTED section
    # as the reference point (we're checking if the RATE for that
    # section was applied correctly — not re-deriving the section itself)
    if not txn.tds_deducted_section:
        return None

    section_key = txn.tds_deducted_section.strip().upper()
    section_config = SECTIONS.get(section_key)
    if not section_config:
        return None  # unknown/out-of-scope section — can't calculate

    rate_config = section_config.get("rate", {})

    # Handle sections with a simple flat rate
    if "default" in rate_config:
        return rate_config["default"]

    # Handle 194C-style individual_huf vs others split
    if "individual_huf" in rate_config and "others" in rate_config:
        if txn.vendor_category == "Individual":
            return rate_config["individual_huf"]
        else:
            return rate_config["others"]

    return None  # rate structure not resolvable with current info


def check_short_excess_tds(txn: Transaction) -> Optional[TDSIssue]:
    """
    Categories: Short TDS Deducted / Excess TDS Deducted
    Compares the actual deducted rate against the applicable rate
    for the SAME section (i.e. section itself was correct, only
    the rate was wrong).
    """
    if txn.tds_deducted_rate is None:
        return None  # nothing was deducted at all — different check handles this

    applicable_rate = _get_applicable_rate(txn)
    if applicable_rate is None:
        return None  # can't determine what rate should apply — skip

    deducted_rate = txn.tds_deducted_rate

    if deducted_rate < applicable_rate:
        return TDSIssue(
            category="Short TDS Deducted",
            message=f"TDS deducted at {deducted_rate}%, but correct rate is {applicable_rate}% for section {txn.tds_deducted_section}.",
            severity="high",
        )
    elif deducted_rate > applicable_rate:
        return TDSIssue(
            category="Excess TDS Deducted",
            message=f"TDS deducted at {deducted_rate}%, but correct rate is {applicable_rate}% for section {txn.tds_deducted_section}.",
            severity="medium",
        )

    return None  # rate matches — no issue


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
    2x the section rate or 5%. Only applies when PAN IS available —
    if PAN is missing, 206AA (20%) governs instead, handled separately.
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
    Runs a single Transaction through every check in the rule engine.
    Returns a list of all TDSIssue results found (a transaction can
    have more than one issue). Empty list means fully clean.
    """
    checks = [
        check_tds_not_applicable,
        check_pan_validity,
        check_short_excess_tds,
        check_wrong_section_by_hsn,
        check_lower_deduction_cert,
        check_timing,
        check_206ab_non_filer,
        check_form_15g_15h,
        check_transporter_exemption,
        check_residential_status,
    ]

    issues = []
    for check_fn in checks:
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
    Categories: TDS Not Deducted / TDS Not Applicable (threshold-based)
    Ported from POC validate_threshold + validate_50l_threshold.

    Groups transactions by vendor PAN + section + financial year,
    tracks cumulative payment amount, and flags two scenarios:
      a) Aggregate crossed the threshold but TDS still wasn't applied
         on the full cumulative amount.
      b) TDS was deducted even though the aggregate hasn't crossed
         the threshold yet (premature deduction).

    Confirmed rule: once threshold is crossed, TDS applies to the
    FULL cumulative amount, not just the excess.
    """
    issues: list[TDSIssue] = []

    # Group by (vendor_pan, section, financial_year)
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
            continue  # unknown/out-of-scope section

        threshold_config = section_config.get("threshold")
        if threshold_config is None:
            continue  # no threshold for this section (TDS from first rupee)

        # Handle both flat thresholds and structured ones (e.g. 194C's
        # single_contract/aggregate_fy, or 194A's tiered structure)
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

        cumulative_basic_amount = sum(t.basic_amount for t in group_txns)
        cumulative_tds_deducted = sum(t.tds_deducted_amount or 0.0 for t in group_txns)

        threshold_crossed = cumulative_basic_amount >= aggregate_threshold

        if threshold_crossed and cumulative_tds_deducted == 0:
            issues.append(TDSIssue(
                category="TDS Not Deducted — Threshold Crossed",
                message=(
                    f"Vendor PAN {pan}, Section {section}, FY {fy}: cumulative "
                    f"payments ₹{cumulative_basic_amount:,.2f} crossed the threshold "
                    f"of ₹{aggregate_threshold:,.2f}, but no TDS was deducted across "
                    f"{len(group_txns)} transaction(s)."
                ),
                severity="high",
            ))
        elif not threshold_crossed and cumulative_tds_deducted > 0:
            issues.append(TDSIssue(
                category="TDS Not Applicable — Premature Deduction",
                message=(
                    f"Vendor PAN {pan}, Section {section}, FY {fy}: cumulative "
                    f"payments ₹{cumulative_basic_amount:,.2f} have NOT crossed the "
                    f"threshold of ₹{aggregate_threshold:,.2f}, but TDS of "
                    f"₹{cumulative_tds_deducted:,.2f} was deducted anyway."
                ),
                severity="medium",
            ))

    return issues


