"""TDS Category Report from saved lines: the issue history decides open vs resolved."""

import json

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from api.issues import ledger_event
from db.database import Base
from db.models import LedgerLine, TrackedIssue
from ingestion.sap_translator import build_transactions_from_sap_export
from services.category_report import category_report_rows
from services.ledger_store import save_run_lines
from services.tds_case_builder import classify_event


@pytest.fixture()
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


ROW = {
    "Company_Code": "1001", "Fiscal_Year": "2026", "Document_Number": "3190024299", "Line_Item": "001",
    "Document_Type": "RE", "Posting_Date": "2026-01-07", "Vendor_Number": "V1", "Vendor_Name": "Vendor One",
    "Vendor_PAN": "AAACV1234F", "Local_Amount": -19706, "Debit_Credit": "H",
    "Withholding_Tax_Base_Amount": -16700, "Withholding_Tax_Amount": 0,
    "withholding_tax_type": "CP", "withholding_tax_code": "C1", "tds_rate": 2,
    "tds_description": "Cont. Cos - 2%-New Sec-393(1)6(i)",
}

REPORT = {
    "status": "issue", "reportCategory": "not_deducted", "docNo": "3190024299", "lineItem": "001",
    "companyCode": "1001", "postingDate": "2026-01-07", "tdsAmount": 0, "baseAmount": -16700,
    "applicableAmount": 334.0, "issueCategory": "TDS Not Deducted — Amount Zero", "reason": "TDS Not Deducted",
}


def _save(db, report):
    txns = build_transactions_from_sap_export([ROW])
    items = [(txn, classify_event(txn), ledger_event(txn, classify_event(txn), None)) for txn in txns]
    save_run_lines(db, 1, items, reports={id(txns[0]): report})


def _issue(db, **values):
    db.add(TrackedIssue(
        issue_key="k1", company_code="1001", fiscal_year="2026", doc_no="3190024299", line_item="001",
        category="TDS Not Deducted — Amount Zero", **values,
    ))
    db.commit()


def test_saved_issue_row_stays_in_its_category_while_open(db):
    _save(db, REPORT)
    _issue(db, status="open")
    rows = category_report_rows(db, None, "1001")["rows"]
    assert [(r["status"], r["reportCategory"]) for r in rows] == [("issue", "not_deducted")]
    assert db.query(LedgerLine).one().report_category == "not_deducted"


def test_issue_resolved_by_a_later_correction_moves_to_resolved(db):
    _save(db, REPORT)
    docs = [{"docNo": "5100000001", "tdsEffect": 334.0, "postingDate": "2026-01-20"}]
    _issue(db, status="resolved", resolution_type="CORRECTION_POSTED", correction_docs=json.dumps(docs))
    row = category_report_rows(db, None, "1001")["rows"][0]
    assert row["status"] == "corrected"
    assert row["reportCategory"] == "resolved"
    assert row["resolvedFrom"] == "not_deducted"
    assert row["reportTdsAmount"] == 334.0
    assert row["linkedDoc"] == "5100000001"


def test_lines_saved_before_report_rows_are_counted(db):
    _save(db, None)
    result = category_report_rows(db, None, "1001")
    assert result["rows"] == []
    assert result["linesWithoutReport"] == 1
