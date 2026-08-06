from datetime import date

from ingestion.sap_translator import _derive_vendor_category
from rules.tds_rule_engine import (
    _get_applicable_rate,
    check_amount_consistency,
    check_short_excess_tds,
    check_threshold_breach,
    check_pan_validity,
    check_excess_tds_exceeds_invoice,
    run_all_checks,
)
from rules.transaction_model import Transaction


def _contractor_transaction(pan: str, rate: float) -> Transaction:
    return Transaction(
        doc_number="TEST-194C",
        doc_type="KR",
        posting_date=date(2026, 4, 1),
        vendor_code="V001",
        vendor_pan=pan,
        vendor_category=_derive_vendor_category(pan),
        bill_amount=100_000,
        basic_amount=100_000,
        tds_deducted_section="194C",
        tds_deducted_rate=rate,
    )


def test_huf_pan_category_uses_individual_huf_rate_for_194c():
    transaction = _contractor_transaction("ABCHP1234K", 1.0)

    assert transaction.vendor_category == "HUF"
    assert _get_applicable_rate(transaction) == 1.0
    assert check_short_excess_tds(transaction) is None


def test_firm_pan_category_uses_two_percent_rate_for_194c():
    transaction = _contractor_transaction("ABCFA1234K", 1.0)

    assert transaction.vendor_category == "Firm/Trust/AOP/Company"
    assert _get_applicable_rate(transaction) == 2.0
    assert check_short_excess_tds(transaction).category == "Wrong TDS Rate"


def test_wrong_rate_is_single_issue_with_expected_rate_context():
    transaction = _contractor_transaction("ABCHP1234K", 2.0)
    transaction.basic_amount = 40_000_000
    transaction.bill_amount = 50_000_000
    transaction.tds_deducted_amount = 400_000

    issues = run_all_checks(transaction)

    assert len(issues) == 1
    assert issues[0].category == "Wrong TDS Rate"
    assert issues[0].expected_rate == 1.0
    assert check_amount_consistency(transaction) is None


def test_wrong_amount_is_single_amount_mismatch_when_rate_is_correct():
    transaction = _contractor_transaction("ABCHP1234K", 1.0)
    transaction.basic_amount = 40_000_000
    transaction.bill_amount = 50_000_000
    transaction.tds_deducted_amount = 400

    issues = run_all_checks(transaction)

    assert len(issues) == 1
    assert issues[0].category == "Short/Excess TDS Deducted — Amount Mismatch"
    assert "₹400.00 was actually deducted" in issues[0].message


def test_threshold_shortfall_is_not_duplicated_when_row_level_issue_explains_it():
    transactions = []
    for idx in range(3):
        transaction = _contractor_transaction("ABCHP1234K", 1.0)
        transaction.doc_number = f"TEST-194C-{idx}"
        transaction.basic_amount = 40_000_000
        transaction.bill_amount = 50_000_000
        transaction.tds_deducted_amount = 400_000
        transactions.append(transaction)

    transactions[0].tds_deducted_amount = 400

    assert run_all_checks(transactions[0])[0].category == "Short/Excess TDS Deducted — Amount Mismatch"
    assert check_threshold_breach(transactions) == []


def test_premature_threshold_issue_carries_matching_transaction():
    transaction = Transaction(
        doc_number="TEST-194Q-THRESHOLD",
        doc_type="KA",
        posting_date=date(2025, 5, 8),
        vendor_code="V004",
        vendor_pan="AACCS3003",
        bill_amount=33_750,
        basic_amount=33_750,
        tds_deducted_section="194Q",
        tds_legacy_section="194Q",
        tds_new_section="393(1)8(ii)",
        tds_deducted_rate=0.1,
        tds_deducted_amount=34,
    )

    issues = check_threshold_breach([transaction])

    assert len(issues) == 1
    issue_txn, issue = issues[0]
    assert issue_txn.doc_number == "TEST-194Q-THRESHOLD"
    assert issue_txn.tds_deducted_section == "194Q"
    assert issue.category == "TDS Not Applicable — Premature Deduction"


def test_missing_pan_and_non_filer_takes_the_higher_of_206aa_and_206ab():
    """
    Section 195 (non-resident) with a DTAA rate of 15% confirmed by
    Mahindra as the applicable rate: 206AB would require max(2*15, 5)
    = 30%, which is HIGHER than 206AA's flat 20%. The engine must
    apply 30%, not stop at 206AA's 20%.
    """
    transaction = Transaction(
        doc_number="TEST-195-NONFILER",
        doc_type="KR",
        posting_date=date(2026, 4, 1),
        vendor_code="V002",
        vendor_pan="",  # missing PAN
        bill_amount=1_000_000,
        basic_amount=1_000_000,
        tds_deducted_section="195",
        tds_applicable_rate=15.0,  # DTAA rate confirmed by Mahindra
        tds_deducted_rate=20.0,   # only correct under plain 206AA
        is_non_filer=True,
    )

    issue = check_pan_validity(transaction)

    assert issue is not None
    assert issue.category == "PAN Missing/Invalid — Short TDS Deducted"
    assert "30" in issue.message  # required rate should be 30%, not 20%


def test_missing_pan_without_non_filer_still_uses_plain_206aa_rate():
    """
    Sanity check: when the vendor is NOT a non-filer, 206AB must not
    be considered at all — plain 206AA (20%) still governs on its own.
    """
    transaction = _contractor_transaction("", 20.0)
    transaction.is_non_filer = False

    issue = check_pan_validity(transaction)

    assert issue is not None
    assert issue.category == "PAN Missing/Invalid — Correctly Handled"


def test_invalid_pan_for_194q_uses_five_percent_206aa_exception():
    transaction = Transaction(
        doc_number="TEST-194Q-PAN",
        doc_type="KR",
        posting_date=date(2026, 4, 1),
        vendor_code="V003",
        vendor_pan="INVALIDPAN",
        bill_amount=33_750,
        basic_amount=33_750,
        tds_deducted_section="194Q",
        tds_deducted_rate=0.1,
        tds_deducted_amount=34,
    )

    issue = check_pan_validity(transaction)

    assert issue is not None
    assert issue.category == "PAN Missing/Invalid — Short TDS Deducted"
    assert issue.expected_rate == 5.0
    assert "requires 5.0% TDS" in issue.message


def test_missing_pan_and_non_filer_where_206aa_is_still_higher():
    """
    For a low-rate section like 194C, 206AB's 2x rate (or 5% floor)
    stays below 206AA's flat 20% — 206AA should still govern, and the
    fix should not accidentally lower the required rate.
    """
    transaction = _contractor_transaction("", 20.0)
    transaction.is_non_filer = True  # 2*1%=2%, floored to 5% — still < 20%

    issue = check_pan_validity(transaction)

    assert issue is not None
    assert issue.category == "PAN Missing/Invalid — Correctly Handled"
    assert "20" in issue.message


def test_excess_tds_check_flags_when_tds_exceeds_full_invoice_amount():
    """
    TDS deducted (₹90,000) exceeds the full bill amount (₹80,000) —
    structurally impossible, must be flagged regardless of rate math.
    """
    transaction = _contractor_transaction("ABCFA1234K", 2.0)
    transaction.bill_amount = 80_000
    transaction.tds_deducted_amount = 90_000

    issue = check_excess_tds_exceeds_invoice(transaction)

    assert issue is not None
    assert issue.category == "Excess TDS Deducted — Exceeds Invoice Amount"


def test_excess_tds_check_does_not_flag_normal_case():
    """
    TDS deducted (₹2,000 on a 2% rate) is well within the bill amount
    (₹100,000) — this is the ordinary case and must not be flagged.
    """
    transaction = _contractor_transaction("ABCFA1234K", 2.0)
    transaction.tds_deducted_amount = 2_000

    assert check_excess_tds_exceeds_invoice(transaction) is None


def test_excess_tds_check_does_not_flag_when_equal_to_bill_amount():
    """
    Boundary case: TDS deducted exactly equals the bill amount.
    Not realistic in practice, but should not itself be flagged by
    this specific structural check (it's on the boundary, not beyond it).
    """
    transaction = _contractor_transaction("ABCFA1234K", 2.0)
    transaction.bill_amount = 50_000
    transaction.tds_deducted_amount = 50_000

    assert check_excess_tds_exceeds_invoice(transaction) is None
