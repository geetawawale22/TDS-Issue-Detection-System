"""An issue raised again takes the latest run's description, section, rate and amounts."""
from datetime import date

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from api.issues import _transaction_issue
from db.database import Base
from db.models import TrackedIssue
from rules.tds_rule_engine import TDSIssue
from rules.transaction_model import Transaction
from services.issue_tracker import track_rule_run


@pytest.fixture()
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


def _run(db, txn, rule_issue):
    issue = _transaction_issue(1, txn, rule_issue)
    track_rule_run(
        db, issues=[issue], issue_txns=[txn], transactions=[txn], user_id=None,
        source="upload", file_name="test.csv", include_informational=False,
    )


def test_recurring_issue_takes_the_latest_rule_wording(db):
    txn = Transaction(
        doc_number="2510724369", doc_type="KR", posting_date=date(2025, 10, 27), company_code="1001",
        fiscal_year="2026", line_item_number="1", vendor_code="DIS02167AB", vendor_pan="ABKPP6288N",
        bill_amount=22672.74, basic_amount=0.0, tds_deducted_amount=0,
    )
    _run(db, txn, TDSIssue("Possible Missed TDS Deduction", "GL shows 194Q at 0.1%", "medium", expected_rate=0.1))
    _run(db, txn, TDSIssue(
        "Possible Missed TDS Deduction", "Interest: 194A at 10%", "medium",
        expected_rate=10.0, expected_section="194A", estimated_base=22672.74,
    ))

    [saved] = db.query(TrackedIssue).all()
    assert saved.description == "Interest: 194A at 10%"
    assert saved.section == "194A"
    assert float(saved.expected_rate) == 10.0
    assert float(saved.tax_impact) == 2267.27
