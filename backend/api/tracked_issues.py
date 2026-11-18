"""Issue history across rule-engine runs (see services/issue_tracker.py)."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from core.dependencies import get_current_user, get_user_company_codes
from db.database import get_db
from db.models import RuleRun, TrackedIssue, User
from services.issue_tracker import manual_resolve, tracked_issue_to_dict
from services.ledger_store import refresh_issue_state


router = APIRouter(prefix="/tracked-issues", tags=["Issue History"])


def _scoped(query, user: User, db: Session):
    """Accountants see only their company codes; admins see everything."""
    if user.role == "admin":
        return query
    codes = get_user_company_codes(user, db)
    return query.filter(TrackedIssue.company_code.in_(codes))


@router.get("")
def list_tracked_issues(
    status: Literal["open", "resolved", "all"] = "open",
    search: str = "",
    resolution_type: str = "",
    company_code: str = "",
    run: Literal["", "latest"] = "",
    tds: Literal["", "deducted", "not_deducted"] = "",
    severity: str = "",
    partial: bool = False,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """One page of saved issues; filtering and paging happen in the database."""
    base = _scoped(db.query(TrackedIssue), current_user, db)
    if company_code.strip():
        base = base.filter(TrackedIssue.company_code == company_code.strip())
    term = search.strip()
    if term:
        like = f"%{term}%"
        base = base.filter(or_(
            TrackedIssue.doc_no.ilike(like),
            TrackedIssue.vendor_name.ilike(like),
            TrackedIssue.vendor_code.ilike(like),
            TrackedIssue.vendor_pan.ilike(like),
            TrackedIssue.correction_docs.ilike(like),
        ))

    counts = dict(
        base.with_entities(TrackedIssue.status, func.count(TrackedIssue.id))
        .group_by(TrackedIssue.status)
        .all()
    )

    query = base
    if status != "all":
        query = query.filter(TrackedIssue.status == status)
    if run == "latest":
        # Open: raised for the first time in the latest run. Resolved: resolved by it.
        latest_id = _latest_run_id(db)
        column = TrackedIssue.resolved_run_id if status == "resolved" else TrackedIssue.first_seen_run_id
        query = query.filter(column == latest_id)
    query = _card_filters(query, tds, severity, partial)
    if resolution_type.strip():
        query = query.filter(TrackedIssue.resolution_type == resolution_type.strip().upper())
    total = query.count()
    order = TrackedIssue.resolved_at.desc().nullslast() if status == "resolved" else TrackedIssue.last_seen_at.desc()
    rows = query.order_by(order, TrackedIssue.id.desc()).offset((page - 1) * page_size).limit(page_size).all()
    return {
        "items": [tracked_issue_to_dict(row) for row in rows],
        "total": total,
        "page": page,
        "pageSize": page_size,
        "counts": {"open": counts.get("open", 0), "resolved": counts.get("resolved", 0)},
    }


def _tds_deducted():
    return func.abs(func.coalesce(TrackedIssue.tds_amount, 0)) > 0


def _card_filters(query, tds: str = "", severity: str = "", partial: bool = False):
    """Filters behind the summary cards (TDS deducted or not, severity, partly corrected)."""
    if tds == "deducted":
        query = query.filter(_tds_deducted())
    elif tds == "not_deducted":
        query = query.filter(~_tds_deducted())
    if severity.strip():
        query = query.filter(TrackedIssue.severity == severity.strip().lower())
    if partial:
        query = query.filter(TrackedIssue.remaining_shortfall.isnot(None))
    return query


def _latest_run_id(db: Session) -> int | None:
    return db.query(func.max(RuleRun.id)).scalar()


def _run_dict(run: RuleRun) -> dict[str, Any]:
    return {
        "id": run.id,
        "source": run.source,
        "fileName": run.file_name,
        "companyCodes": run.company_codes,
        "periodFrom": run.period_from.isoformat() if run.period_from else None,
        "periodTo": run.period_to.isoformat() if run.period_to else None,
        "transactions": run.transactions,
        "issuesFound": run.issues_found,
        "newIssues": run.new_issues,
        "recurringIssues": run.recurring_issues,
        "reopenedIssues": run.reopened_issues,
        "resolvedIssues": run.resolved_issues,
        "partiallyCorrected": run.partially_corrected,
        "createdAt": run.created_at.isoformat() if run.created_at else None,
    }


@router.get("/summary")
def tracked_issue_summary(
    company_code: str = "",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Issue book across every run: each issue once, however many files raised it."""
    base = _scoped(db.query(TrackedIssue), current_user, db)
    if company_code.strip():
        base = base.filter(TrackedIssue.company_code == company_code.strip())
    open_rows = base.filter(TrackedIssue.status == "open")
    open_count, open_impact = open_rows.with_entities(
        func.count(TrackedIssue.id), func.coalesce(func.sum(TrackedIssue.tax_impact), 0),
    ).one()
    partly = open_rows.filter(TrackedIssue.remaining_shortfall.isnot(None)).count()
    resolved = base.filter(TrackedIssue.status == "resolved").count()
    latest = db.query(RuleRun).order_by(RuleRun.id.desc()).first()
    severity_counts = dict(
        open_rows.with_entities(TrackedIssue.severity, func.count(TrackedIssue.id))
        .group_by(TrackedIssue.severity).all()
    )
    deducted = open_rows.filter(_tds_deducted()).count()
    return {
        "open": open_count,
        "openTaxImpact": float(open_impact or 0),
        "partlyCorrected": partly,
        "openTdsDeducted": deducted,
        "openTdsNotDeducted": open_count - deducted,
        "openHigh": severity_counts.get("high", 0),
        "openMedium": severity_counts.get("medium", 0),
        "openLow": severity_counts.get("low", 0),
        "openNewInLatestRun": open_rows.filter(TrackedIssue.first_seen_run_id == latest.id).count() if latest else 0,
        "resolved": resolved,
        "latestRun": _run_dict(latest) if latest else None,
    }


_DASHBOARD_LIMIT = 200_000


@router.get("/all")
def all_tracked_issues(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Every saved issue in a compact form, for the Dashboard's totals and charts.

    Each issue appears once however many runs raised it, so yesterday's and
    today's issues add up without double counting.
    """
    columns = (
        TrackedIssue.id, TrackedIssue.issue_key, TrackedIssue.company_code, TrackedIssue.fiscal_year,
        TrackedIssue.doc_no, TrackedIssue.line_item, TrackedIssue.doc_type, TrackedIssue.category,
        TrackedIssue.issue_type, TrackedIssue.severity, TrackedIssue.status, TrackedIssue.resolution_type,
        TrackedIssue.vendor_name, TrackedIssue.vendor_code, TrackedIssue.vendor_pan, TrackedIssue.section,
        TrackedIssue.posting_date, TrackedIssue.base_amount, TrackedIssue.tds_amount, TrackedIssue.tax_impact,
        TrackedIssue.remaining_shortfall, TrackedIssue.first_seen_at, TrackedIssue.resolved_at,
        TrackedIssue.profit_center,
    )
    rows = (
        _scoped(db.query(*columns), current_user, db)
        .order_by(TrackedIssue.posting_date.desc().nullslast(), TrackedIssue.id.desc())
        .limit(_DASHBOARD_LIMIT + 1)
        .all()
    )

    def number(value):
        return float(value) if value is not None else None

    items = [{
        "id": f"T{row.id}",
        "issueKey": row.issue_key,
        "companyCode": row.company_code or None,
        "fiscalYear": row.fiscal_year or None,
        "docNo": row.doc_no,
        "lineItem": row.line_item or None,
        "docType": row.doc_type,
        "category": row.category,
        "issueType": row.issue_type,
        "severity": row.severity,
        "status": row.status,
        "resolutionType": row.resolution_type,
        "partlyCorrected": row.status == "open" and row.remaining_shortfall is not None,
        "vendor": row.vendor_name or row.vendor_code or "Unknown vendor",
        "vendorId": row.vendor_code,
        "vendorPan": row.vendor_pan,
        "section": row.section,
        "profitCenter": row.profit_center,
        "date": row.posting_date.isoformat() if row.posting_date else None,
        "baseAmount": number(row.base_amount),
        "tdsAmount": number(row.tds_amount),
        "taxImpact": number(row.tax_impact),
        "firstSeenAt": row.first_seen_at.isoformat() if row.first_seen_at else None,
        "resolvedAt": row.resolved_at.isoformat() if row.resolved_at else None,
    } for row in rows[:_DASHBOARD_LIMIT]]
    return {"items": items, "truncated": len(rows) > _DASHBOARD_LIMIT}


class ManualResolveRequest(BaseModel):
    issueKey: str
    note: str | None = None
    correctionDocs: list[dict[str, Any]] | None = None


@router.post("/resolve")
def resolve_tracked_issue(
    body: ManualResolveRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Mark one saved issue resolved by hand (Match SAP Rows). Later runs keep it resolved."""
    row = _scoped(db.query(TrackedIssue), current_user, db).filter(TrackedIssue.issue_key == body.issueKey).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Issue not found in the issue history.")
    row = manual_resolve(db, body.issueKey, current_user.id, body.note, body.correctionDocs)
    refresh_issue_state(db, [row.company_code])
    return tracked_issue_to_dict(row)


@router.get("/runs")
def list_rule_runs(
    limit: int = Query(20, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    """Most recent rule-engine runs with their new / resolved counts."""
    query = db.query(RuleRun)
    if current_user.role != "admin":
        query = query.filter(RuleRun.run_by == current_user.id)
    rows = query.order_by(RuleRun.created_at.desc(), RuleRun.id.desc()).limit(limit).all()
    return [_run_dict(run) for run in rows]
