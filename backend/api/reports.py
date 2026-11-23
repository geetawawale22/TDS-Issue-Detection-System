"""Reports built from saved data (every run), not from one uploaded file."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from api.issues import _FastJSONResponse
from core.dependencies import get_current_user, get_user_company_codes
from db.database import get_db
from db.models import TrackedIssue, User
from services.category_report import category_report_rows
from services.issue_tracker import tracked_issue_to_dict
from services.ledger_store import financial_year_range


router = APIRouter(prefix="/reports", tags=["Reports"])


@router.get("/category", response_class=_FastJSONResponse)
def category_report(
    company_code: str = "",
    financial_year: str = "",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """TDS Category Report rows: every saved SAP line in the Company / FY scope, all runs.

    ``linesWithoutReport`` counts lines saved before report rows were kept;
    analysing their file again adds them.
    """
    companies = None if current_user.role == "admin" else list(get_user_company_codes(current_user, db))
    return _FastJSONResponse(category_report_rows(db, companies, company_code, financial_year))


@router.get("/issue-status", response_class=_FastJSONResponse)
def issue_status_report(
    company_code: str = "",
    financial_year: str = "",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Open Issues & Correction Status: every saved issue (open and resolved), all runs.

    Each issue once however many files raised it, with how it was resolved
    (reversal, correction entry, no longer raised, by hand) and its correction
    documents. Scoped by posting date to the financial year, like Open Issues.
    """
    query = db.query(TrackedIssue)
    if current_user.role != "admin":
        query = query.filter(TrackedIssue.company_code.in_(list(get_user_company_codes(current_user, db))))
    if company_code.strip():
        query = query.filter(TrackedIssue.company_code == company_code.strip())
    period = financial_year_range(financial_year)
    if period:
        query = query.filter(TrackedIssue.posting_date.between(*period))
    rows = query.order_by(TrackedIssue.posting_date, TrackedIssue.doc_no, TrackedIssue.line_item, TrackedIssue.id).all()
    return _FastJSONResponse({"rows": [tracked_issue_to_dict(row) for row in rows]})
