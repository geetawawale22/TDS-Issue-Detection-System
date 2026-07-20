import yaml
from pathlib import Path
from typing import Optional
from datetime import date
import re
from rules.transaction_model import Transaction

# ============================================================
# Load tds_sections.yaml once when this module is imported.
# This is our "source of truth" for applicable rates/thresholds
# until Mahindra sends real TDS Applicable data per transaction.
# ============================================================

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


