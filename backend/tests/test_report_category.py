"""Report categories (Reports → TDS Category Report) for the business sample cases.

Each case mirrors a sheet of Mahindra's scenario workbook; the row goes
through the real rules, issue builder and validation-row builder before
report_fields assigns its category.
"""
from datetime import date

from api.issues import _transaction_issue, _transaction_validation_row
from ingestion.sap_translator import _derive_vendor_category
from rules.tds_rule_engine import run_all_checks
from rules.transaction_model import Transaction
from services.report_category import (
    ADVANCE_FULL,
    ADVANCE_PARTIAL,
    EXCESS,
    LDC,
    NOT_APPLICABLE,
    NOT_DEDUCTED,
    OTHER,
    PROPERLY_DEDUCTED,
    SHORT,
    _category_for_issue,
    build_advance_roles,
    report_fields,
)


def _txn(**overrides) -> Transaction:
    pan = overrides.pop("vendor_pan", "ABKPP6288N")
    fields = dict(
        doc_number="2510953334",
        doc_type="KR",
        company_code="1001",
        posting_date=date(2026, 1, 2),
        vendor_code="DIS02167AB",
        vendor_name="Test Vendor",
        vendor_pan=pan,
        vendor_category=_derive_vendor_category(pan),
        bill_amount=1_524_308.0,
        basic_amount=1_291_786.0,
        tds_deducted_section="194C",
        tds_deducted_rate=1.0,
        tds_deducted_amount=12_918.0,
        person="ASHWIN TAJANPURE",
        bill_no="SIS/0620/2025-26",
        description="HSK MANPOWER SALARY NOV-25",
        gl_account="54280006",
        gl_description="Manpower Hiring",
    )
    fields.update(overrides)
    return Transaction(**fields)


def _categorise(txn: Transaction, advance_role=None) -> dict:
    results = [result for result in run_all_checks(txn) if result is not None]
    reported = [result for result in results if result.severity != "low"]
    info = next((result for result in results if result.severity == "low"), None)
    issue = _transaction_issue(1, txn, reported[0]) if reported else None
    status = "issue" if issue else "passed"
    row = _transaction_validation_row(txn, status, issue["category"] if issue else "Validated with no issue found.", 1, None)
    return report_fields(txn, row, issue, info, advance_role)


def test_properly_deducted_individual_pan_at_one_percent():
    fields = _categorise(_txn())

    assert fields["reportCategory"] == PROPERLY_DEDUCTED
    assert fields["applicableSection"] == "194C"
    assert fields["applicableRate"] == 1.0
    assert fields["deductedSection"] == "194C"
    assert fields["person"] == "ASHWIN TAJANPURE"
    assert fields["billNo"] == "SIS/0620/2025-26"
    assert fields["glAccount"] == "54280006"


def test_short_deducted_firm_pan_at_one_percent():
    # Business sample: ARTHVA VENTURES LLP, 4th PAN letter F → 2% applicable, 1% deducted.
    fields = _categorise(_txn(
        vendor_pan="ACHFA2304C",
        basic_amount=2_280_600.0,
        bill_amount=2_691_108.0,
        tds_deducted_amount=22_806.0,
    ))

    assert fields["reportCategory"] == SHORT
    assert fields["applicableRate"] == 2.0
    assert fields["applicableAmount"] == 45_612.0
    assert fields["remark"]


def test_excess_deducted_when_rate_above_applicable():
    fields = _categorise(_txn(tds_deducted_rate=5.0, tds_deducted_amount=64_589.3))

    assert fields["reportCategory"] == EXCESS


def test_hundred_percent_ldc_without_tds_is_ldc():
    # Business sample: THE AUTOMOTIVE RESEARCH, 194J, 100% LDC, nothing deducted.
    fields = _categorise(_txn(
        vendor_pan="AAATT1989P",
        tds_deducted_section="194J",
        tds_deducted_rate=None,
        tds_deducted_amount=0.0,
        basic_amount=374_437.0,
        posting_date=date(2026, 2, 11),
        ldc_exemption_number="LDC-TEST",
        ldc_exemption_percent=100.0,
        ldc_exempt_from=date(2025, 6, 13),
        ldc_exempt_to=date(2026, 3, 31),
    ))

    assert fields["reportCategory"] == LDC


def test_passed_row_without_tds_is_not_applicable():
    row = {"status": "passed", "baseAmount": 5_000.0, "section": "194C", "expectedRate": 1.0,
           "tdsNote": "Below threshold for 194C", "reason": "Validated with no issue found."}
    fields = report_fields(_txn(tds_deducted_amount=0.0, tds_deducted_rate=None), row, None, None, None)

    assert fields["reportCategory"] == NOT_APPLICABLE
    assert fields["applicableRate"] is None
    assert fields["remark"] == "Below threshold for 194C"


def test_insufficient_data_goes_to_other():
    row = {"status": "insufficient", "baseAmount": 0.0, "reason": "Base amount is zero."}
    fields = report_fields(_txn(tds_deducted_amount=0.0), row, None, None, None)

    assert fields["reportCategory"] == OTHER


def test_issue_category_mapping():
    assert _category_for_issue("TDS Not Deducted — Threshold Crossed", 500.0, 0.0) == NOT_DEDUCTED
    assert _category_for_issue("Possible Missed TDS Deduction", 500.0, 0.0) == NOT_DEDUCTED
    assert _category_for_issue("PAN Missing/Invalid — Short TDS Deducted", 500.0, 100.0) == SHORT
    assert _category_for_issue("TDS Short Deducted — Threshold Crossed", 500.0, 100.0) == SHORT
    assert _category_for_issue("Excess TDS Deducted — Exceeds Invoice Amount", 100.0, 500.0) == EXCESS
    assert _category_for_issue("TDS Not Deducted as per LDC", 100.0, 500.0) == LDC
    assert _category_for_issue("TDS Not Applicable — Violation", None, 500.0) == NOT_APPLICABLE
    assert _category_for_issue("TDS Section Missing", 100.0, 0.0) == OTHER
    # Direction-neutral categories are split by the amounts.
    assert _category_for_issue("Short/Excess TDS Deducted", 1_000.0, 500.0) == SHORT
    assert _category_for_issue("Short/Excess TDS Deducted", 500.0, 1_000.0) == EXCESS
    assert _category_for_issue("Wrong Section Applied", 500.0, 0.0) == NOT_DEDUCTED
    # Advance issues go to TDS on Advance, not TDS Not Deducted / Short / Excess.
    assert _category_for_issue("TDS Not Deducted — Advance Payment", 500.0, 0.0) == ADVANCE_FULL
    assert _category_for_issue("TDS Not Deducted — Advance Payment", None, 0.0) == ADVANCE_FULL
    assert _category_for_issue("Short TDS Deducted — Advance Adjusted Invoice", 1_000.0, 500.0) == ADVANCE_PARTIAL
    assert _category_for_issue("Excess TDS Deducted — Advance Adjusted Invoice", 500.0, 1_000.0) == ADVANCE_PARTIAL


def _advance_and_invoice(invoice_tds: float):
    advance = _txn(
        doc_number="2610402630", doc_type="KZ", is_advance_payment=True,
        invoice_reference_document="3189856997", tds_deducted_section="194J",
        tds_deducted_rate=10.0, tds_deducted_amount=800.0, basic_amount=8_000.0, bill_amount=8_000.0,
    )
    invoice = _txn(
        doc_number="3189856997", doc_type="RE", tds_deducted_section="194J",
        tds_deducted_rate=10.0 if invoice_tds else None, tds_deducted_amount=invoice_tds,
        basic_amount=8_000.0, bill_amount=9_440.0,
    )
    return advance, invoice


def test_full_tds_on_advance_pairs_advance_and_invoice():
    advance, invoice = _advance_and_invoice(0.0)
    roles = build_advance_roles([advance, invoice])

    assert roles[id(invoice)] == (ADVANCE_FULL, "2610402630")
    assert roles[id(advance)] == (ADVANCE_FULL, "3189856997")


def test_partial_tds_on_advance_when_invoice_also_deducts():
    advance, invoice = _advance_and_invoice(430.0)
    roles = build_advance_roles([advance, invoice])

    assert roles[id(invoice)][0] == ADVANCE_PARTIAL
    assert roles[id(advance)][0] == ADVANCE_PARTIAL


def test_advance_without_tds_is_filed_under_tds_on_advance():
    # No TDS on the advance means no advance chain (no advance role), but the
    # issue still belongs with the advances, not under TDS Not Deducted.
    advance = _txn(
        doc_number="2610402630", doc_type="KZ", is_advance_payment=True,
        tds_deducted_section="194J", tds_deducted_rate=None, tds_deducted_amount=0.0,
        basic_amount=8_000.0, bill_amount=8_000.0,
    )
    fields = _categorise(advance)

    assert fields["reportCategory"] == ADVANCE_FULL


def test_passed_row_without_known_rate_is_flagged_as_not_verified():
    # A section with no single statutory rate (195, DTAA-based): the rules pass the row
    # without checking its rate; the report must say so, not show ₹0 applicable.
    row = {"status": "passed", "baseAmount": 268_589.41, "section": "195", "expectedRate": None,
           "appliedRate": 10.0, "tdsNote": None, "reason": "Validated with no issue found."}
    fields = report_fields(_txn(tds_deducted_section="195", tds_deducted_amount=26_858.94), row, None, None, None)

    assert fields["reportCategory"] == PROPERLY_DEDUCTED
    assert fields["applicableAmount"] is None
    assert fields["remark"].startswith("Rate not verified")


# ---- 194I rent (2% plant/machinery, 10% land/building) and 194R (10%) ----

def _rent(**overrides) -> Transaction:
    fields = dict(
        vendor_pan="AAACK1234F", tds_deducted_section="194I",
        tds_raw_section="LandBldg/Fur Ind/HUF/Fim10%NS393(1)2(ii)",
        gl_description="Rent - Office Building", description="Office rent",
        basic_amount=100_000.0, bill_amount=118_000.0,
        tds_deducted_rate=10.0, tds_deducted_amount=10_000.0,
    )
    fields.update(overrides)
    return _txn(**fields)


def test_rent_land_building_at_ten_percent_is_proper():
    fields = _categorise(_rent())

    assert fields["reportCategory"] == PROPERLY_DEDUCTED
    assert fields["applicableRate"] == 10.0


def test_rent_land_building_at_two_percent_is_short():
    fields = _categorise(_rent(tds_deducted_rate=2.0, tds_deducted_amount=2_000.0))

    assert fields["reportCategory"] == SHORT
    assert fields["applicableAmount"] == 10_000.0


def test_rent_plant_machinery_tax_code_expects_two_percent():
    fields = _categorise(_rent(
        tds_raw_section="PlantMach Rent@2%-NS393(1)2(i)", gl_description="RENTAL CHARGES - IT ASSETS",
        tds_deducted_rate=2.0, tds_deducted_amount=2_000.0,
    ))
    assert fields["reportCategory"] == PROPERLY_DEDUCTED
    assert fields["applicableRate"] == 2.0

    fields = _categorise(_rent(tds_raw_section="PlantMach Rent@2%-NS393(1)2(i)", gl_description="RENTAL CHARGES - IT ASSETS"))
    assert fields["reportCategory"] == EXCESS


def test_rent_nature_falls_back_to_gl_description():
    from rules.tds_rule_engine import RENT_LAND_BUILDING, RENT_PLANT_MACHINERY, rent_nature

    assert rent_nature(_rent(tds_raw_section="Rent", gl_description="RENTAL CHARGES - IT ASSETS")) == RENT_PLANT_MACHINERY
    assert rent_nature(_rent(tds_raw_section="Rent", gl_description="Rent - Office Building")) == RENT_LAND_BUILDING
    assert rent_nature(_rent(tds_raw_section="Rent", gl_description="Rent", description="Rent")) is None


def test_rent_without_stated_nature_accepts_either_rate():
    unknown = dict(tds_raw_section="Rent 194I", gl_description="Rent", description="Monthly rent")

    two = _categorise(_rent(**unknown, tds_deducted_rate=2.0, tds_deducted_amount=2_000.0))
    assert two["reportCategory"] == PROPERLY_DEDUCTED
    assert two["remark"].startswith("Rent TDS at 2% accepted")

    one = _categorise(_rent(**unknown, tds_deducted_rate=1.0, tds_deducted_amount=1_000.0))
    assert one["reportCategory"] == SHORT
    assert one["applicableRate"] == 2.0


def test_194r_benefit_rate_is_ten_percent():
    benefit = dict(
        tds_deducted_section="194R", tds_raw_section="Ben. 194R @ 10% COM PAN-N/S-393(1)8(iv)",
        gl_description="INCENTIVE SPARE PART", basic_amount=50_000.0, bill_amount=50_000.0,
    )
    assert _categorise(_txn(**benefit, tds_deducted_rate=10.0, tds_deducted_amount=5_000.0))["reportCategory"] == PROPERLY_DEDUCTED

    short = _categorise(_txn(**benefit, tds_deducted_rate=5.0, tds_deducted_amount=2_500.0))
    assert short["reportCategory"] == SHORT
    assert short["applicableAmount"] == 5_000.0


def test_rent_threshold_is_per_month():
    from rules.tds_rule_engine import check_threshold_breach

    no_tds = dict(tds_deducted_rate=None, tds_deducted_amount=0.0, basic_amount=40_000.0)
    # ₹40,000 a month for three months: ₹1.2 lakh in the FY, but never over ₹50,000 in a month.
    monthly = [_rent(**no_tds, doc_number=f"R{m}", posting_date=date(2025, m, 5)) for m in (5, 6, 7)]
    assert check_threshold_breach(monthly) == []

    # Two bills in one month take that month over ₹50,000.
    same_month = [_rent(**no_tds, doc_number=f"S{d}", posting_date=date(2025, 8, d)) for d in (5, 20)]
    breaches = check_threshold_breach(same_month)
    assert len(breaches) == 1
    assert breaches[0][1].category == "TDS Not Deducted — Threshold Crossed"
    assert "Aug 2025" in breaches[0][1].message


def test_194r_threshold_is_twenty_thousand_per_year():
    from rules.tds_rule_engine import check_threshold_breach

    benefit = dict(tds_deducted_section="194R", tds_deducted_rate=None, tds_deducted_amount=0.0)
    under = [_txn(**benefit, doc_number="B1", basic_amount=8_000.0, posting_date=date(2025, 5, 1)),
             _txn(**benefit, doc_number="B2", basic_amount=9_000.0, posting_date=date(2025, 9, 1))]
    assert check_threshold_breach(under) == []

    over = under + [_txn(**benefit, doc_number="B3", basic_amount=5_000.0, posting_date=date(2026, 1, 1))]
    assert len(check_threshold_breach(over)) == 1


# ---- Rows a later correction / reversal resolved ----

def _corrected_row(**overrides) -> dict:
    # Doc 3190024310: 194C at 2% on 16,700, nothing deducted; topped up by SA doc 1009700010.
    row = {
        "status": "corrected", "companyCode": "1001", "docNo": "3190024310", "tdsAmount": 0.0,
        "reportCategory": SHORT, "issueCategory": "Short TDS Deducted — Amount Mismatch",
        "applicableSection": "194C", "applicableRate": 2.0, "applicableAmount": 334.0,
        "deductedSection": None, "deductedRate": None, "remark": "Expected rate is 2.0% ...",
        "reason": "Correction posted in 1009700010; TDS now matches the expected amount.",
        "resolutionType": "CORRECTION_POSTED",
        "correctionDocs": [{"docNo": "1009700010", "postingDate": "2026-01-09", "tdsAmount": 334.0, "tdsEffect": 334.0}],
    }
    row.update(overrides)
    return row


def test_corrected_short_deduction_goes_to_resolved_with_corrected_tds():
    from services.report_category import RESOLVED, apply_resolutions

    row = _corrected_row()
    apply_resolutions([row])

    assert row["reportCategory"] == RESOLVED
    assert row["resolvedFrom"] == SHORT  # the sheet its original issue belongs to
    assert row["reportTdsAmount"] == 334.0
    assert row["deductedSection"] == "194C" and row["deductedRate"] == 2.0
    assert row["linkedDoc"] == "1009700010"
    assert row["issueCategory"] == "Short TDS Deducted — Amount Mismatch"
    assert "corrected by 1009700010 on 2026-01-09" in row["remark"]


def test_reversed_document_goes_to_resolved_with_nothing_applicable():
    from services.report_category import RESOLVED, apply_resolutions

    row = _corrected_row(resolutionType="REVERSED", correctionDocs=[{"docNo": "5100000001"}])
    apply_resolutions([row])

    assert row["reportCategory"] == RESOLVED
    assert row["applicableAmount"] is None
    assert "cancelled by 5100000001" in row["remark"]


def test_manually_resolved_row_goes_to_resolved():
    from services.report_category import RESOLVED, apply_resolutions

    row = _corrected_row(resolutionType="MANUAL", correctionDocs=None, reason="Accepted by tax team.")
    apply_resolutions([row])

    assert row["reportCategory"] == RESOLVED and row["resolvedFrom"] == SHORT
    assert "reportTdsAmount" not in row
    assert row["remark"].endswith("Resolved: Accepted by tax team.")


def test_open_issue_rows_are_not_moved():
    from services.report_category import apply_resolutions

    row = _corrected_row(status="issue")
    apply_resolutions([row])

    assert row["reportCategory"] == SHORT


def test_correction_line_in_same_upload_is_not_counted_twice():
    from services.report_category import apply_resolutions

    original = _corrected_row()
    correction = {"status": "passed", "rowKind": "correction", "companyCode": "1001", "docNo": "1009700010",
                  "correctionOf": "3190024310", "tdsAmount": 334.0, "reportCategory": PROPERLY_DEDUCTED}
    unrelated = {"status": "passed", "rowKind": "correction", "companyCode": "1001", "docNo": "1009700011",
                 "correctionOf": "9999999999", "tdsAmount": 50.0, "reportCategory": PROPERLY_DEDUCTED}
    apply_resolutions([original, correction, unrelated])

    assert correction["reportCountedOn"] == "3190024310"
    assert correction["reportCategory"] == "resolved"
    assert "reportCountedOn" not in unrelated
    assert unrelated["reportCategory"] == PROPERLY_DEDUCTED


def test_payment_against_invoice_without_section_is_not_applicable():
    row = {"status": "insufficient", "baseAmount": 50_000.0, "docType": "KZ",
           "tdsNote": "Payment against invoice — TDS is deducted when the invoice is booked, not at payment.",
           "reason": "Missing section/rate/applicable section/payment type, so rules cannot validate this row."}
    fields = report_fields(_txn(doc_type="KZ", tds_deducted_section=None, tds_deducted_rate=None, tds_deducted_amount=0.0),
                           row, None, None, None)

    assert fields["reportCategory"] == NOT_APPLICABLE
    assert fields["remark"].startswith("Payment against invoice")


def test_skipped_correction_line_without_tds_is_not_applicable():
    # A KG credit note correcting an invoice, with no TDS of its own: skipped by
    # the rules, so not a TDS event — not "needs review" despite its generic note.
    row = {"status": "skipped", "rowKind": "correction", "baseAmount": 1_500.0,
           "tdsNote": "Cannot verify — SAP has no TDS section, rate or payment type for this row.",
           "reason": "Correction entry (credit note / reversal) for document 2510912172 with no TDS on it."}
    fields = report_fields(_txn(doc_type="KG", tds_deducted_section=None, tds_deducted_rate=None, tds_deducted_amount=0.0),
                           row, None, None, None)

    assert fields["reportCategory"] == NOT_APPLICABLE
    assert fields["remark"].startswith("Correction entry (credit note / reversal)")


def test_rate_recorded_but_nothing_deducted_is_not_deducted():
    # SAP: 194C at 2% on 16,700, TDS amount 0 (doc 3190024299).
    fields = _categorise(_txn(
        vendor_pan="AAPCS4515C", tds_deducted_rate=2.0, tds_deducted_amount=0.0,
        basic_amount=16_700.0, bill_amount=19_706.0,
    ))

    assert fields["issueCategory"] == "TDS Not Deducted — Amount Zero"
    assert fields["reportCategory"] == NOT_DEDUCTED
    assert fields["applicableAmount"] == 334.0


def test_any_issue_with_nothing_deducted_is_not_deducted():
    assert _category_for_issue("Short TDS Deducted — Amount Mismatch", 334.0, 0.0) == NOT_DEDUCTED
    assert _category_for_issue("Wrong TDS Rate", 334.0, 0.0) == NOT_DEDUCTED
    assert _category_for_issue("TDS Not Deducted as per LDC", 334.0, 0.0) == LDC
