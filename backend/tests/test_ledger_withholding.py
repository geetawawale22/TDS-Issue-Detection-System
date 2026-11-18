"""Saved ledger: a SAP line with two withholding taxes keeps both, its amount counts once."""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from api.issues import ledger_event
from db.database import Base
from db.models import LedgerGroup, LedgerLine
from ingestion.sap_translator import build_transactions_from_sap_export
from services.ledger_store import save_run_lines
from services.tds_case_builder import classify_event


@pytest.fixture()
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


def _row(wtax_type, wtax_code, base, tds, description, assignment="A1"):
    return {
        "Company_Code": "1001", "Fiscal_Year": "2026", "Document_Number": "2510968484", "Line_Item": "001",
        "Document_Type": "RE", "Posting_Date": "2026-01-07", "Vendor_Number": "V1", "Vendor_Name": "Vendor One",
        "Vendor_PAN": "AAACV1234F", "Assignment_Number": assignment, "Local_Amount": -10000, "Debit_Credit": "H",
        "Withholding_Tax_Base_Amount": base, "Withholding_Tax_Amount": tds,
        "withholding_tax_type": wtax_type, "withholding_tax_code": wtax_code, "tds_rate": 1,
        "tds_description": description,
    }


TWO_TAXES = [
    _row("LI", "L1", -6000, -6, "Pur ofGood-0.1% INVCOMP-NS393(1)8(ii)"),
    _row("CI", "C1", -3700, -74, "Cont. Cos - 2%-New Sec-393(1)6(i)"),
]


def _save(db, rows, run_id=1):
    items = [(txn, classify_event(txn), ledger_event(txn, classify_event(txn), None))
             for txn in build_transactions_from_sap_export(rows)]
    return save_run_lines(db, run_id, items)


def test_line_with_two_withholding_taxes_keeps_both_and_counts_amount_once(db):
    result = _save(db, TWO_TAXES)

    lines = db.query(LedgerLine).order_by(LedgerLine.withholding_tax_type).all()
    assert result["linesSaved"] == 2
    assert [(l.withholding_tax_type, float(l.tds_amount), l.is_primary_entry) for l in lines] == [
        ("CI", 74.0, True), ("LI", 6.0, False),
    ]
    group = db.query(LedgerGroup).one()
    assert float(group.tds_amount) == 80.0           # both deductions
    assert float(group.invoice_amount) == 10000.0    # line amount once, not 20,000
    assert float(group.net_amount) == -10000.0
    assert group.event_count == 2


def test_saving_the_same_file_again_does_not_duplicate(db):
    _save(db, TWO_TAXES)
    _save(db, TWO_TAXES, run_id=2)
    assert db.query(LedgerLine).count() == 2
    assert float(db.query(LedgerGroup).one().invoice_amount) == 10000.0


def test_row_saved_before_withholding_types_is_reused(db):
    _save(db, TWO_TAXES[:1])
    # A row saved by the old code had no withholding type.
    db.query(LedgerLine).update({LedgerLine.withholding_tax_type: "", LedgerLine.withholding_tax_code: ""})
    db.commit()

    _save(db, TWO_TAXES, run_id=2)

    lines = db.query(LedgerLine).all()
    assert len(lines) == 2
    assert {(l.withholding_tax_type, l.withholding_tax_code) for l in lines} == {("CI", "C1"), ("LI", "L1")}
    assert sum(l.is_primary_entry for l in lines) == 1


def test_withholding_no_longer_sent_is_removed(db):
    _save(db, TWO_TAXES)
    _save(db, TWO_TAXES[1:], run_id=2)
    lines = db.query(LedgerLine).all()
    assert [(l.withholding_tax_type, l.is_primary_entry) for l in lines] == [("CI", True)]
    assert float(db.query(LedgerGroup).one().tds_amount) == 74.0


def test_identical_rows_still_count_once(db):
    # Same line, same withholding, only the assignment differs (left for the API data check).
    _save(db, [TWO_TAXES[1], {**TWO_TAXES[1], "Assignment_Number": ""}])
    assert db.query(LedgerLine).count() == 1
