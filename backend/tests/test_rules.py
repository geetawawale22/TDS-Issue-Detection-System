from datetime import date

from api.issues import (
    _build_case_ledger_from_transactions,
    _is_skipped_non_tds_document_without_tds_amounts,
    _skipped_non_tds_document_reason,
    _transaction_issue,
)
from ingestion.sap_translator import _derive_vendor_category, build_transactions_from_sap_export, build_transactions_from_sap_rows
from rules.tds_rule_engine import (
    _get_applicable_rate,
    check_amount_consistency,
    check_short_excess_tds,
    check_threshold_breach,
    check_pan_validity,
    check_excess_tds_exceeds_invoice,
    check_advance_payment_lifecycle,
    check_missing_deduction,
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
    assert issues[0].category == "Short TDS Deducted — Amount Mismatch"
    assert "₹400.00 was actually deducted" in issues[0].message


def test_excess_amount_mismatch_gets_excess_category_when_rate_is_correct():
    transaction = _contractor_transaction("ABCHP1234K", 1.0)
    transaction.basic_amount = 100_000
    transaction.bill_amount = 100_000
    transaction.tds_deducted_amount = 2_000

    issues = run_all_checks(transaction)

    assert len(issues) == 1
    assert issues[0].category == "Excess TDS Deducted — Amount Mismatch"
    assert "₹2,000.00 was actually deducted" in issues[0].message


def test_194j_two_percent_still_checks_amount_consistency():
    transaction = Transaction(
        doc_number="TEST-194J-2PCT",
        doc_type="KR",
        posting_date=date(2025, 12, 18),
        vendor_code="V194J",
        vendor_pan="DDTOO472AA",
        vendor_category=_derive_vendor_category("DDTOO472AA"),
        bill_amount=344_978,
        basic_amount=344_978,
        tds_deducted_section="194J",
        tds_deducted_rate=2.0,
        tds_deducted_amount=6_900,
    )

    assert check_short_excess_tds(transaction) is None
    assert check_amount_consistency(transaction) is None

    transaction.tds_deducted_amount = 4_000

    issue = check_amount_consistency(transaction)
    assert issue is not None
    assert issue.category == "Short TDS Deducted — Amount Mismatch"
    assert "Expected rate is 2.0%" in issue.message


def test_classified_row_keeps_zero_basic_amount_instead_of_using_bill_amount():
    transaction = Transaction(
        doc_number="TEST-194H-ZERO-BASIC",
        doc_type="TP",
        posting_date=date(2025, 11, 7),
        vendor_code="V005",
        vendor_pan="AAEPZ9355R",
        vendor_category=_derive_vendor_category("AAEPZ9355R"),
        bill_amount=24_415,
        basic_amount=0,
        tds_deducted_section="194H",
        tds_deducted_rate=2.0,
        tds_deducted_amount=0,
    )

    assert run_all_checks(transaction) == []


def test_payment_type_contract_catches_wrong_section_194j_instead_of_194c():
    transaction = Transaction(
        doc_number="TEST-PAYTYPE-WRONG",
        doc_type="KA",
        transaction_kind="contract",
        posting_date=date(2025, 5, 29),
        vendor_code="V006",
        vendor_pan="AAEPZ9355R",
        vendor_category=_derive_vendor_category("AAEPZ9355R"),
        bill_amount=450_000,
        basic_amount=450_000,
        tds_deducted_section="194J",
        tds_legacy_section="194J",
        tds_deducted_rate=1.0,
        tds_deducted_amount=4_500,
    )

    issues = run_all_checks(transaction)

    assert len(issues) == 1
    assert issues[0].category == "Wrong Section Applied"
    assert "requires section 194C" in issues[0].message

    ui_issue = _transaction_issue(1, transaction, issues[0])
    assert ui_issue["expectedRate"] == 1.0
    assert ui_issue["taxImpact"] == 0


def test_payment_type_contract_accepts_194c():
    transaction = Transaction(
        doc_number="TEST-PAYTYPE-CORRECT",
        doc_type="KA",
        transaction_kind="contract",
        posting_date=date(2025, 5, 29),
        vendor_code="V006",
        vendor_pan="AAEPZ9355R",
        vendor_category=_derive_vendor_category("AAEPZ9355R"),
        bill_amount=450_000,
        basic_amount=450_000,
        tds_deducted_section="194C",
        tds_legacy_section="194C",
        tds_deducted_rate=1.0,
        tds_deducted_amount=4_500,
    )

    assert run_all_checks(transaction) == []


def test_po_number_header_maps_to_transaction_po_no():
    transaction = build_transactions_from_sap_rows([{
        "Document_No": "TEST-PO",
        "Document_Type": "KR",
        "Posting_Date": "2026-02-10",
        "Vendor_Code": "V-PO",
        "PAN": "ABCDE1234F",
        "Bill_Amount": 1000,
        "Basic_Amount": 1000,
        "PO_Number": "4500012345",
        "TDS_Section": "194J",
        "TDS_Rate": "10%",
        "TDS_Amount": 100,
    }])[0]

    assert transaction.po_no == "4500012345"


def test_tds_section_text_infers_purchase_and_flags_unrecognised_section():
    transaction = build_transactions_from_sap_export([{
        "Document_No": "TEST-PNS392",
        "Document_Type": "KA",
        "Posting_Date": "2025-05-29",
        "Vendor_Code": "V006",
        "PAN": "AAEPZ9355R",
        "Bill_Amount": 450_000,
        "Basic_Amount": 450_000,
        "TDSSection": "Purc of Good-0.1%PMTCOM-PNS392",
        "TDSRate": 0.1,
        "TDSAmount": -450,
    }])[0]

    issues = run_all_checks(transaction)

    assert transaction.transaction_kind == "purchase"
    assert len(issues) == 1
    assert issues[0].category == "Wrong Section Applied"
    assert issues[0].expected_section == "194Q"
    assert "requires section 194Q" in issues[0].message
    assert "not recognised" in issues[0].message


def test_tds_section_text_infers_purchase_and_flags_wrong_legacy_section():
    transaction = build_transactions_from_sap_export([{
        "Document_No": "TEST-PURCHASE-AS-194J",
        "Document_Type": "KA",
        "Posting_Date": "2025-05-29",
        "Vendor_Code": "V006",
        "PAN": "AAEPZ9355R",
        "Bill_Amount": 450_000,
        "Basic_Amount": 450_000,
        "TDSSection": "194J Purc of Good-0.1%",
        "TDSRate": 0.1,
        "TDSAmount": -450,
    }])[0]

    issues = run_all_checks(transaction)

    assert transaction.transaction_kind == "purchase"
    assert transaction.tds_deducted_section == "194J"
    assert len(issues) == 1
    assert issues[0].category == "Wrong Section Applied"
    assert "requires section 194Q" in issues[0].message


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

    assert run_all_checks(transactions[0])[0].category == "Short TDS Deducted — Amount Mismatch"
    assert check_threshold_breach(transactions) == []


def test_below_threshold_tds_deduction_is_not_flagged_as_premature():
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

    assert issues == []


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


def test_ka_transaction_sets_advance_flag_and_normalises_advance_section_alias():
    transaction = build_transactions_from_sap_rows([{
        "Company_Code": "1001",
        "Fiscal_Year": "2025",
        "Document_Number": "2100002001",
        "Line_Item": "001",
        "Vendor_Code": "V001",
        "Vendor_PAN": "ABCFA1234K",
        "Document_Type": "KA",
        "Special_GL_Indicator": "A",
        "Posting_Date": "2025-04-01",
        "Document_Amount": 200000,
        "TDS_Section": "194CP",
        "TDS_Rate": 2,
        "TDS_Amount": 4000,
    }])[0]

    assert transaction.is_advance_payment is True
    assert transaction.tds_deducted_section == "194C"


def test_vendor_gstin_header_extracts_pan_for_grouping():
    transaction = build_transactions_from_sap_rows([{
        "Company_Code": "1001",
        "Document_Number": "1054137871",
        "Vendor_Number": "EBU23812",
        "Vendor_PAN": "09AAEPZ9355R1ZD",
        "Document_Type": "KR",
        "Posting_Date": "2025-06-19",
        "Local_Amount": 760,
        "Withholding_Tax_Base_Amount": 760,
        "TDS_Section": "194C",
        "tds_rate": 1,
        "Withholding_Tax_Amount": 8,
    }])[0]

    assert transaction.vendor_pan == "AAEPZ9355R"


def test_reference_document_number_maps_to_invoice_link_not_bill_no():
    transaction = build_transactions_from_sap_rows([{
        "Company_Code": "1001",
        "Fiscal_Year": "2025",
        "Document_Number": "2100002001",
        "Reference_Document_Number": "5100001001",
        "Reference_Fiscal_Year": "2025",
        "Reference_Line_Item": "001",
        "Reference_Document": "VENDOR-BILL-22",
        "Vendor_Number": "V001",
        "Vendor_PAN": "ABCFA1234K",
        "Document_Type": "KA",
        "Posting_Date": "2025-04-01",
        "Local_Amount": 200000,
        "Withholding_Tax_Base_Amount": 200000,
        "TDS_Section": "194C",
        "tds_rate": 2,
        "Withholding_Tax_Amount": 4000,
    }])[0]

    assert transaction.invoice_reference_document == "5100001001"
    assert transaction.invoice_reference_fiscal_year == "2025"
    assert transaction.invoice_reference_line_item == "001"
    assert transaction.bill_no == "VENDOR-BILL-22"


def test_assignment_number_maps_to_transaction():
    transaction = build_transactions_from_sap_rows([{
        "Company_Code": "1001",
        "Document_Number": "2100002001",
        "Assignment_Number": "5100001001",
        "Vendor_Number": "V001",
        "Vendor_PAN": "ABCFA1234K",
        "Document_Type": "KA",
        "Special_GL_Indicator": "A",
        "Posting_Date": "2025-04-01",
        "Local_Amount": 200000,
        "Withholding_Tax_Base_Amount": 200000,
        "TDS_Section": "194C",
        "tds_rate": 2,
        "Withholding_Tax_Amount": 4000,
    }])[0]

    assert transaction.assignment_number == "5100001001"


def test_kz_without_advance_signal_is_not_marked_as_advance():
    transaction = build_transactions_from_sap_rows([{
        "Company_Code": "1001",
        "Document_Number": "2610274616",
        "Vendor_Number": "DIA00483AA",
        "Vendor_PAN": "ABCFA1234K",
        "Document_Type": "KZ",
        "Posting_Date": "2025-07-22",
        "Local_Amount": 2297515,
        "Withholding_Tax_Base_Amount": 1980617.58,
        "TDS_Section": "194C",
        "tds_rate": 2,
        "Withholding_Tax_Amount": 0,
    }])[0]

    assert transaction.is_advance_payment is False


def test_kz_with_special_gl_advance_signal_is_marked_as_advance():
    transaction = build_transactions_from_sap_rows([{
        "Company_Code": "1001",
        "Document_Number": "2610274616",
        "Vendor_Number": "DIA00483AA",
        "Vendor_PAN": "ABCFA1234K",
        "Document_Type": "KZ",
        "special_gl_indicator": "A",
        "Posting_Date": "2025-07-22",
        "Local_Amount": 2297515,
        "Withholding_Tax_Base_Amount": 1980617.58,
        "TDS_Section": "194C",
        "tds_rate": 2,
        "Withholding_Tax_Amount": 39712.35,
    }])[0]

    assert transaction.is_advance_payment is True


def test_kz_with_special_gl_advance_text_is_marked_as_advance():
    transaction = build_transactions_from_sap_rows([{
        "Company_Code": "1001",
        "Document_Number": "2610274617",
        "Vendor_Number": "DIA00483AA",
        "Vendor_PAN": "ABCFA1234K",
        "Document_Type": "KZ",
        "special_gl_indicator": "advance",
        "Posting_Date": "2025-07-22",
        "Local_Amount": 2297515,
        "Withholding_Tax_Base_Amount": 1980617.58,
        "TDS_Section": "194C",
        "tds_rate": 2,
        "Withholding_Tax_Amount": 39712.35,
    }])[0]

    assert transaction.is_advance_payment is True


def test_ab_adjustment_without_tds_does_not_raise_transaction_issue():
    transaction = build_transactions_from_sap_rows([{
        "Company_Code": "1001",
        "Document_Number": "1054137871",
        "Vendor_Number": "EBU23812",
        "Vendor_PAN": "09AAEPZ9355R1ZD",
        "Document_Type": "AB",
        "Posting_Date": "2025-06-19",
        "Local_Amount": 760,
        "Withholding_Tax_Base_Amount": 0,
        "Withholding_Tax_Amount": 0,
        "GL_Account": "23636001",
    }])[0]

    assert run_all_checks(transaction) == []


def test_skip_eligible_doc_type_with_blank_section_and_zero_tds_is_skipped():
    transaction = build_transactions_from_sap_rows([{
        "Company_Code": "1001",
        "Document_Number": "1054137872",
        "Vendor_Number": "EBU23812",
        "Vendor_PAN": "AAEPZ9355R",
        "Document_Type": "BD",
        "Posting_Date": "2025-06-19",
        "Local_Amount": 760,
        "Withholding_Tax_Base_Amount": 100,
        "Withholding_Tax_Amount": 0,
        "TDS_Section": "",
    }])[0]

    assert _is_skipped_non_tds_document_without_tds_amounts(transaction) is True
    reason = _skipped_non_tds_document_reason(transaction)
    assert "Document Type BD" in reason
    assert "TDS section and TDS amount are blank/zero" in reason


def test_always_validate_doc_types_are_not_skipped_even_without_tds_signal():
    for doc_type in ["RE", "KZ", "KR", "KG", "LQ"]:
        transaction = build_transactions_from_sap_rows([{
            "Company_Code": "1001",
            "Document_Number": f"DOC-{doc_type}",
            "Vendor_Number": "EBU23812",
            "Vendor_PAN": "AAEPZ9355R",
            "Document_Type": doc_type,
            "Posting_Date": "2025-06-19",
            "Local_Amount": 760,
            "Withholding_Tax_Base_Amount": 0,
            "Withholding_Tax_Amount": 0,
            "TDS_Section": "",
        }])[0]

        assert _is_skipped_non_tds_document_without_tds_amounts(transaction) is False


def test_skip_eligible_doc_type_with_tds_section_or_amount_is_validated():
    with_section = build_transactions_from_sap_rows([{
        "Company_Code": "1001",
        "Document_Number": "JV-SECTION",
        "Vendor_Number": "EBU23812",
        "Vendor_PAN": "AAEPZ9355R",
        "Document_Type": "JV",
        "Posting_Date": "2025-06-19",
        "Local_Amount": 760,
        "Withholding_Tax_Base_Amount": 760,
        "Withholding_Tax_Amount": 0,
        "TDS_Section": "194C",
    }])[0]
    with_amount = build_transactions_from_sap_rows([{
        "Company_Code": "1001",
        "Document_Number": "JV-AMOUNT",
        "Vendor_Number": "EBU23812",
        "Vendor_PAN": "AAEPZ9355R",
        "Document_Type": "JV",
        "Posting_Date": "2025-06-19",
        "Local_Amount": 760,
        "Withholding_Tax_Base_Amount": 760,
        "Withholding_Tax_Amount": 10,
        "TDS_Section": "",
    }])[0]

    assert _is_skipped_non_tds_document_without_tds_amounts(with_section) is False
    assert _is_skipped_non_tds_document_without_tds_amounts(with_amount) is False


def test_kz_payment_without_advance_marker_is_not_missing_tds_candidate():
    invoice_with_tds = Transaction(
        doc_number="2510162130",
        doc_type="KR",
        posting_date=date(2025, 9, 30),
        company_code="1001",
        vendor_code="EBU23812",
        vendor_pan="AAEPZ9355R",
        vendor_category=_derive_vendor_category("AAEPZ9355R"),
        gl_account="16060001",
        bill_amount=346281.84,
        basic_amount=346281.84,
        tds_deducted_section="194C",
        tds_deducted_rate=1,
        tds_deducted_amount=3463,
    )
    normal_payment = Transaction(
        doc_number="2610380025",
        doc_type="KZ",
        debit_credit="S",
        posting_date=date(2025, 9, 30),
        company_code="1001",
        vendor_code="EBU23812",
        vendor_pan="AAEPZ9355R",
        vendor_category=_derive_vendor_category("AAEPZ9355R"),
        gl_account="16060001",
        bill_amount=48988.07,
        basic_amount=41550.91,
        tds_deducted_amount=0,
        is_advance_payment=False,
    )

    assert check_missing_deduction([invoice_with_tds, normal_payment]) == []


def test_uncleared_rows_are_exposed_as_open_items_in_tds_analysis():
    invoice = Transaction(
        doc_number="2510993976",
        doc_type="KR",
        posting_date=date(2026, 1, 15),
        company_code="1001",
        fiscal_year="2026",
        vendor_code="DIM00420AB",
        vendor_pan="AAEPZ9355R",
        vendor_category=_derive_vendor_category("AAEPZ9355R"),
        assignment_number="20260115",
        clearing_document=None,
        bill_amount=-122301.44,
        basic_amount=104308,
        tds_deducted_section="194C",
        tds_deducted_rate=0.75,
        tds_deducted_amount=782,
    )
    payment_without_tds = Transaction(
        doc_number="1287539966",
        doc_type="BD",
        posting_date=date(2026, 1, 30),
        company_code="1001",
        fiscal_year="2026",
        vendor_code="DIM00420AB",
        vendor_pan="AAEPZ9355R",
        vendor_category=_derive_vendor_category("AAEPZ9355R"),
        assignment_number="20260130",
        clearing_document="",
        bill_amount=976004.52,
        basic_amount=976004.52,
        withholding_tax_base_amount=0,
        tds_deducted_amount=0,
    )

    ledger = _build_case_ledger_from_transactions([invoice, payment_without_tds], [])

    assert len(ledger) == 2
    assert {row["anchorDocNo"] for row in ledger} == {"20260115", "20260130"}
    assert all(row["openItem"] is True for row in ledger)
    assert all(row["groupType"].startswith("OPEN_") for row in ledger)
    assert all(row["status"] == "OPEN" for row in ledger)


def test_kz_with_tds_signal_is_still_checked_for_amount_mismatch():
    transaction = Transaction(
        doc_number="2610380025",
        doc_type="KZ",
        debit_credit="S",
        posting_date=date(2025, 9, 30),
        company_code="1001",
        vendor_code="EBU23812",
        vendor_pan="AAEPZ9355R",
        vendor_category=_derive_vendor_category("AAEPZ9355R"),
        gl_account="16060001",
        bill_amount=48988.07,
        basic_amount=41550.91,
        tds_deducted_section="194C",
        tds_deducted_rate=1,
        tds_deducted_amount=0,
        is_advance_payment=False,
    )

    issues = run_all_checks(transaction)

    assert any(issue.category == "Short TDS Deducted — Amount Mismatch" for issue in issues)


def test_advance_lifecycle_allows_partial_advance_and_balance_invoice_tds():
    advance = Transaction(
        doc_number="2100002001",
        doc_type="KA",
        posting_date=date(2025, 4, 1),
        company_code="1001",
        fiscal_year="2025",
        vendor_code="V001",
        vendor_pan="ABCFA1234K",
        vendor_category=_derive_vendor_category("ABCFA1234K"),
        bill_amount=200000,
        basic_amount=200000,
        tds_deducted_section="194C",
        tds_deducted_rate=2,
        tds_deducted_amount=4000,
        is_advance_payment=True,
        invoice_reference_document="5100001001",
        invoice_reference_fiscal_year="2025",
    )
    invoice = Transaction(
        doc_number="5100001001",
        doc_type="KR",
        posting_date=date(2025, 4, 10),
        company_code="1001",
        fiscal_year="2025",
        vendor_code="V001",
        vendor_pan="ABCFA1234K",
        vendor_category=_derive_vendor_category("ABCFA1234K"),
        bill_amount=500000,
        basic_amount=500000,
        tds_deducted_section="194C",
        tds_deducted_rate=2,
        tds_deducted_amount=10000,
    )

    assert check_advance_payment_lifecycle([advance, invoice]) == []


def test_advance_lifecycle_links_by_assignment_number():
    advance = Transaction(
        doc_number="2100002001",
        doc_type="KA",
        assignment_number="5100001001",
        posting_date=date(2025, 4, 1),
        company_code="1001",
        fiscal_year="2025",
        vendor_code="V001",
        vendor_pan="ABCFA1234K",
        vendor_category=_derive_vendor_category("ABCFA1234K"),
        bill_amount=200000,
        basic_amount=200000,
        tds_deducted_section="194C",
        tds_deducted_rate=2,
        tds_deducted_amount=4000,
        is_advance_payment=True,
    )
    invoice = Transaction(
        doc_number="5100001001",
        doc_type="KR",
        posting_date=date(2025, 4, 10),
        company_code="1001",
        fiscal_year="2025",
        vendor_code="V001",
        vendor_pan="ABCFA1234K",
        vendor_category=_derive_vendor_category("ABCFA1234K"),
        bill_amount=500000,
        basic_amount=500000,
        tds_deducted_section="194C",
        tds_deducted_rate=2,
        tds_deducted_amount=10000,
    )

    assert check_advance_payment_lifecycle([advance, invoice]) == []


def test_advance_lifecycle_flags_chain_level_excess_tds():
    advance = Transaction(
        doc_number="2100002001", doc_type="KA", posting_date=date(2025, 4, 1),
        company_code="1001", fiscal_year="2025", vendor_code="V001", vendor_pan="ABCFA1234K",
        vendor_category=_derive_vendor_category("ABCFA1234K"), bill_amount=200000, basic_amount=200000,
        tds_deducted_section="194C", tds_deducted_rate=2, tds_deducted_amount=4000,
        is_advance_payment=True, invoice_reference_document="5100001001", invoice_reference_fiscal_year="2025",
    )
    invoice = Transaction(
        doc_number="5100001001", doc_type="KR", posting_date=date(2025, 4, 10),
        company_code="1001", fiscal_year="2025", vendor_code="V001", vendor_pan="ABCFA1234K",
        vendor_category=_derive_vendor_category("ABCFA1234K"), bill_amount=500000, basic_amount=500000,
        tds_deducted_section="194C", tds_deducted_rate=2, tds_deducted_amount=12000,
    )

    issues = check_advance_payment_lifecycle([advance, invoice])

    assert len(issues) == 1
    assert issues[0][1].category == "Excess TDS Deducted — Advance Adjusted Invoice"


def test_advance_lifecycle_allows_chain_level_tds_for_mantra_case():
    advance = Transaction(
        doc_number="2610455298",
        doc_type="KZ",
        assignment_number="6500010688",
        posting_date=date(2025, 11, 20),
        company_code="1001",
        fiscal_year="2026",
        vendor_code="DIM00977AA",
        vendor_pan="AAFCM9927Q",
        vendor_category=_derive_vendor_category("AAFCM9927Q"),
        bill_amount=3350491,
        basic_amount=3350491,
        tds_deducted_section="194C",
        tds_deducted_rate=2,
        tds_deducted_amount=67010,
        is_advance_payment=True,
    )
    invoice = Transaction(
        doc_number="3189959523",
        doc_type="RE",
        assignment_number="6500010688",
        posting_date=date(2026, 1, 5),
        company_code="1001",
        fiscal_year="2026",
        vendor_code="DIM00977AA",
        vendor_pan="AAFCM9927Q",
        vendor_category=_derive_vendor_category("AAFCM9927Q"),
        bill_amount=-7840148.24,
        basic_amount=3350490.56,
        tds_deducted_section="194C",
        tds_deducted_rate=2,
        tds_deducted_amount=67010,
    )

    assert check_advance_payment_lifecycle([advance, invoice]) == []


def test_advance_lifecycle_does_not_flag_rounded_invoice_tds_when_advance_tds_absent():
    advance = Transaction(
        doc_number="2100002001", doc_type="KA", posting_date=date(2025, 4, 1),
        company_code="1001", fiscal_year="2025", vendor_code="V001", vendor_pan="ABCFA1234K",
        vendor_category=_derive_vendor_category("ABCFA1234K"), bill_amount=181798.83, basic_amount=181798.83,
        tds_deducted_section="194Q", tds_deducted_rate=0.1, tds_deducted_amount=0,
        is_advance_payment=True, invoice_reference_document="2510560687", invoice_reference_fiscal_year="2025",
    )
    invoice = Transaction(
        doc_number="2510560687", doc_type="KR", posting_date=date(2025, 5, 28),
        company_code="1001", fiscal_year="2025", vendor_code="V001", vendor_pan="ABCFA1234K",
        vendor_category=_derive_vendor_category("ABCFA1234K"), bill_amount=181798.83, basic_amount=181798.83,
        tds_deducted_section="194Q", tds_deducted_rate=0.1, tds_deducted_amount=182,
    )

    issues = check_advance_payment_lifecycle([advance, invoice])

    assert not any(issue.category == "Excess TDS Deducted — Advance Adjusted Invoice" for _, issue in issues)


def test_advance_lifecycle_flags_missing_advance_tds():
    advance = Transaction(
        doc_number="2100002001", doc_type="KA", posting_date=date(2025, 4, 1),
        company_code="1001", fiscal_year="2025", vendor_code="V001", vendor_pan="ABCFA1234K",
        vendor_category=_derive_vendor_category("ABCFA1234K"), bill_amount=200000, basic_amount=200000,
        tds_deducted_section="194C", tds_deducted_rate=2, tds_deducted_amount=0,
        is_advance_payment=True, invoice_reference_document="5100001001", invoice_reference_fiscal_year="2025",
    )
    invoice = Transaction(
        doc_number="5100001001", doc_type="KR", posting_date=date(2025, 4, 10),
        company_code="1001", fiscal_year="2025", vendor_code="V001", vendor_pan="ABCFA1234K",
        vendor_category=_derive_vendor_category("ABCFA1234K"), bill_amount=500000, basic_amount=500000,
        tds_deducted_section="194C", tds_deducted_rate=2, tds_deducted_amount=6000,
    )

    issues = check_advance_payment_lifecycle([advance, invoice])

    assert any(issue.category == "TDS Not Deducted — Advance Payment" for _, issue in issues)
    assert any(issue.category == "Short TDS Deducted — Advance Adjusted Invoice" for _, issue in issues)


def test_advance_clearing_adjustment_does_not_raise_missing_advance_tds():
    adjustment = Transaction(
        doc_number="2610523222",
        doc_type="KZ",
        posting_date=date(2026, 1, 6),
        company_code="1001",
        fiscal_year="2026",
        vendor_code="DIM00977AA",
        vendor_pan="AAFCM9927Q",
        vendor_category=_derive_vendor_category("AAFCM9927Q"),
        bill_amount=-3350491,
        basic_amount=3350491,
        tds_deducted_section="194C",
        tds_deducted_rate=2,
        tds_deducted_amount=0,
        is_advance_payment=True,
        clearing_document="2610523222",
        clearing_fiscal_year="2026",
        invoice_reference_document="2610455298",
        invoice_reference_fiscal_year="2026",
    )

    assert run_all_checks(adjustment) == []


def test_advance_lifecycle_does_not_link_by_clearing_document_only():
    advance = Transaction(
        doc_number="2100002001", doc_type="KA", posting_date=date(2025, 4, 1),
        company_code="1001", fiscal_year="2025", vendor_code="V001", vendor_pan="ABCFA1234K",
        vendor_category=_derive_vendor_category("ABCFA1234K"), bill_amount=200000, basic_amount=200000,
        tds_deducted_section="194C", tds_deducted_rate=2, tds_deducted_amount=4000,
        is_advance_payment=True, clearing_document="900000001", clearing_fiscal_year="2025",
    )
    invoice = Transaction(
        doc_number="5100001001", doc_type="KR", posting_date=date(2025, 4, 10),
        company_code="1001", fiscal_year="2025", vendor_code="V001", vendor_pan="ABCFA1234K",
        vendor_category=_derive_vendor_category("ABCFA1234K"), bill_amount=500000, basic_amount=500000,
        tds_deducted_section="194C", tds_deducted_rate=2, tds_deducted_amount=10000,
        clearing_document="900000001", clearing_fiscal_year="2025",
    )

    assert check_advance_payment_lifecycle([advance, invoice]) == []


def test_tds_description_decodes_contract_cost_to_old_and_new_section():
    transaction = build_transactions_from_sap_export([{
        "Accounting_Document_Number": "2610000001",
        "Document_Type": "KZ",
        "Posting_Date": "2025-06-27",
        "Vendor_Number": "DIA00483AA",
        "Vendor_PAN": "ABCFA1234K",
        "Amount_Local_Currency": 770974,
        "Withholding_Tax_Base_Amount": 770974,
        "Withholding_Tax_Amount": 15420,
        "tds_rate": 2,
        "tds_description": "Cont. Cos - 2%-New Sec-393(1)6(i)",
    }])[0]

    assert transaction.tds_deducted_section == "194C"
    assert transaction.tds_legacy_section == "194C"
    assert transaction.tds_new_section == "393(1)6(i)"
    assert transaction.tds_deducted_rate == 2


def test_tds_description_decodes_plant_machinery_rent_to_194i():
    transaction = build_transactions_from_sap_export([{
        "Accounting_Document_Number": "2610000002",
        "Document_Type": "KZ",
        "Posting_Date": "2025-06-27",
        "Vendor_Number": "DIA00483AA",
        "Vendor_PAN": "ABCFA1234K",
        "Amount_Local_Currency": 22000,
        "Withholding_Tax_Base_Amount": 22000,
        "Withholding_Tax_Amount": 440,
        "tds_rate": 2,
        "tds_description": "Plt/Mach/Eqpt Cos-2%-N/S-393(1)2(i)",
    }])[0]

    assert transaction.tds_deducted_section == "194I"
    assert transaction.tds_legacy_section == "194I"
    assert transaction.tds_new_section == "393(1)2(i)"
    assert transaction.tds_deducted_rate == 2


def test_excess_tds_check_uses_absolute_signed_invoice_amount():
    transaction = _contractor_transaction("ABCFA1234K", 2.0)
    transaction.bill_amount = -894_329.32
    transaction.basic_amount = 770_974
    transaction.tds_deducted_amount = 15_420

    assert check_excess_tds_exceeds_invoice(transaction) is None
