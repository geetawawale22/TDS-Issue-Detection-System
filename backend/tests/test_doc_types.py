"""Client SAP doc-type master (Client 500) drives event classification and skip rules."""

from datetime import date

import pytest

from api.issues import _event_type_from_joined_row, _ldc_consumption
from rules.doc_types import DOC_TYPE_MASTER, NON_TDS_DEDUCTION_DOC_TYPES
from rules.tds_rule_engine import (
    _is_supporting_adjustment_without_tds,
    _skips_missing_deduction_stats,
    link_advances_to_invoices,
)
from rules.transaction_model import Transaction
from services.issue_tracker import references_other_document
from services.tds_case_builder import classify_event


def _txn(doc_type, **kwargs):
    values = dict(
        doc_number="5100000001", doc_type=doc_type, posting_date=date(2025, 6, 1),
        vendor_code="V1", vendor_pan="AAACV1234F", bill_amount=100_000, basic_amount=100_000,
    )
    values.update(kwargs)
    return Transaction(**values)


def test_master_covers_all_188_client_doc_types():
    assert len(DOC_TYPE_MASTER) == 188


@pytest.mark.parametrize("doc_type", sorted(DOC_TYPE_MASTER))
def test_every_client_doc_type_is_classified(doc_type):
    assert classify_event(_txn(doc_type)) != "UNKNOWN"
    assert _event_type_from_joined_row({"docType": doc_type, "amount": 1}) != "UNKNOWN"


@pytest.mark.parametrize("doc_type, event", [
    ("CA", "INVOICE"), ("FE", "INVOICE"), ("FT", "INVOICE"), ("LS", "INVOICE"), ("ZE", "INVOICE"),
    ("P1", "PAYMENT"), ("P3", "PAYMENT"), ("CP", "PAYMENT"), ("PC", "PAYMENT"), ("ZT", "PAYMENT"),
    ("F8", "CREDIT_MEMO"), ("LD", "DEBIT_NOTE"), ("KB", "TRANSFER_POSTING"), ("KP", "TRANSFER_POSTING"),
    ("JW", "JOURNAL"),
])
def test_new_vendor_doc_types_get_their_event(doc_type, event):
    assert classify_event(_txn(doc_type)) == event


def test_previous_skip_decisions_are_kept():
    old = {"AB", "BD", "JR", "JV", "KW", "SK", "KA", "TP", "BT", "SA", "ST", "BR", "ML", "PR", "QR",
           "QS", "UG", "ZY", "ZZ", "WA", "WE", "WI", "WL", "WN", "W2", "W3"}
    assert old <= NON_TDS_DEDUCTION_DOC_TYPES


def test_vendor_invoice_types_are_never_skipped_when_tds_blank():
    for doc_type in ("RE", "KR", "F1", "LQ", "CA", "FE", "FT", "LS", "KS", "ZE", "JW"):
        assert doc_type not in NON_TDS_DEDUCTION_DOC_TYPES


@pytest.mark.parametrize("doc_type", ["EX", "TE", "SP", "PM", "C1", "RV", "OK", "QA"])
def test_no_tds_doc_types_are_skipped_only_when_tds_blank(doc_type):
    assert _is_supporting_adjustment_without_tds(_txn(doc_type))
    assert _skips_missing_deduction_stats(_txn(doc_type))
    # A TDS section on the row means it is validated after all.
    assert not _is_supporting_adjustment_without_tds(_txn(doc_type, tds_deducted_section="194C"))


@pytest.mark.parametrize("doc_type", ["RE", "CA", "FE", "LS", "P1"])
def test_vendor_doc_types_are_not_skipped(doc_type):
    assert not _is_supporting_adjustment_without_tds(_txn(doc_type))


def test_non_kz_payment_without_tds_is_left_out_of_gl_missing_deduction_check():
    assert _skips_missing_deduction_stats(_txn("P1"))
    assert not _skips_missing_deduction_stats(_txn("P1", tds_deducted_section="194C", tds_deducted_amount=1000))


def test_non_kz_payment_does_not_use_ldc_limit():
    assert _ldc_consumption(_txn("P3", debit_credit="S")) is None


def test_payment_referencing_invoice_is_not_a_correction_line():
    assert not references_other_document(_txn("P1", invoice_reference_document="5100000999"))
    assert references_other_document(_txn("KG", invoice_reference_document="5100000999"))


def test_advance_links_to_capital_invoice():
    advance = _txn("KA", doc_number="2100000001", is_advance_payment=True,
                   invoice_reference_document="5100000002", company_code="1001")
    invoice = _txn("LQ", doc_number="5100000002", company_code="1001")
    links = link_advances_to_invoices([advance, invoice])
    assert [(inv.doc_number, [a.doc_number for a in advs]) for inv, advs in links] == [
        ("5100000002", ["2100000001"]),
    ]
