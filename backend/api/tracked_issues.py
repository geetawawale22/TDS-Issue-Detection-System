"""Issue history across rule-engine runs (see services/issue_tracker.py)."""

from __future__ import annotations

from datetime import date
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from core.dependencies import get_current_user, get_user_company_codes
from db.database import get_db
from db.models import RuleRun, TrackedIssue, User
from services.issue_tracker import manual_resolve, tracked_issue_to_dict
from services.ledger_store import NO_SECTION, financial_year_range, refresh_issue_state


router = APIRouter(prefix="/tracked-issues", tags=["Issue History"])


def _in_selection(query, company_code: str = "", financial_year: str = ""):
    """The company code and financial year picked in the app header (empty = all)."""
    if company_code.strip():
        query = query.filter(TrackedIssue.company_code == company_code.strip())
    period = financial_year_range(financial_year)
    if period:
        query = query.filter(TrackedIssue.posting_date.between(*period))
    return query


class _BarFilters:
    """The TDS Analysis filter bar (vendor, section, doc type, ...), as query parameters."""

    def __init__(
        self,
        vendor: list[str] = Query(default=[]),
        section: list[str] = Query(default=[]),
        doc_type: list[str] = Query(default=[]),
        profit_center: list[str] = Query(default=[]),
        severity_in: list[str] = Query(default=[]),
        issue_type: list[str] = Query(default=[]),
        date_from: date | None = None,
        date_to: date | None = None,
        bar_search: str = "",
    ) -> None:
        self.search = bar_search.strip()
        self.vendor = [v for v in vendor if v]
        self.section = [v for v in section if v]
        self.doc_type = [v.upper() for v in doc_type if v]
        self.profit_center = [v for v in profit_center if v]
        self.severity = [v.lower() for v in severity_in if v]
        # An issue-type option can stand for several categories joined with '||'.
        self.issue_type = [part for value in issue_type for part in value.split("||") if part]
        self.date_from = date_from
        self.date_to = date_to

    def apply(self, query):
        if self.search:
            like = f"%{self.search}%"
            query = query.filter(or_(
                TrackedIssue.doc_no.ilike(like), TrackedIssue.vendor_name.ilike(like),
                TrackedIssue.vendor_code.ilike(like), TrackedIssue.vendor_pan.ilike(like),
                TrackedIssue.section.ilike(like), TrackedIssue.category.ilike(like),
            ))
        if self.vendor:
            query = query.filter(func.coalesce(TrackedIssue.vendor_name, TrackedIssue.vendor_code).in_(self.vendor))
        if self.section:
            options = [
                TrackedIssue.section.is_(None) if value == NO_SECTION else TrackedIssue.section == value
                for value in self.section
            ]
            query = query.filter(or_(*options))
        if self.doc_type:
            query = query.filter(func.upper(TrackedIssue.doc_type).in_(self.doc_type))
        if self.profit_center:
            query = query.filter(TrackedIssue.profit_center.in_(self.profit_center))
        if self.severity:
            query = query.filter(TrackedIssue.severity.in_(self.severity))
        if self.issue_type:
            query = query.filter(or_(TrackedIssue.category.in_(self.issue_type), TrackedIssue.issue_type.in_(self.issue_type)))
        if self.date_from:
            query = query.filter(TrackedIssue.posting_date >= self.date_from)
        if self.date_to:
            query = query.filter(TrackedIssue.posting_date <= self.date_to)
        return query


# Open Issues tabs (as on the Issues tab), each a set of report categories
# (services/report_category.py). "other" takes every open issue no tab above takes.
ISSUE_TABS: dict[str, tuple[str, ...]] = {
    "short": ("short",),
    "excess": ("excess",),
    "not_deducted": ("not_deducted",),
    "ldc": ("ldc",),
    "advance": ("advance_full", "advance_partial"),
    "not_applicable": ("not_applicable",),
}
_TABBED_CATEGORIES = tuple(category for categories in ISSUE_TABS.values() for category in categories)


def _issue_tab_filter(query, issue_tab: str):
    if issue_tab in ISSUE_TABS:
        return query.filter(TrackedIssue.report_category.in_(ISSUE_TABS[issue_tab]))
    if issue_tab == "other":
        return query.filter(or_(
            TrackedIssue.report_category.is_(None),
            TrackedIssue.report_category.notin_(_TABBED_CATEGORIES),
        ))
    return query


def _scoped(query, user: User, db: Session):
    """Accountants see only their company codes; admins see everything."""
    if user.role == "admin":
        return query
    codes = get_user_company_codes(user, db)
    return query.filter(TrackedIssue.company_code.in_(codes))


def _desc_nulls_last(column):
    """Newest first, empty values last. `NULLS LAST` is PostgreSQL-only (MySQL
    rejects it), so sort on "is empty" first: false (0) before true (1)."""
    return column.is_(None), column.desc()

@router.get("")
def list_tracked_issues(
    status: Literal["open", "resolved", "all"] = "open",
    search: str = "",
    resolution_type: str = "",
    company_code: str = "",
    financial_year: str = "",
    run: Literal["", "latest"] = "",
    seen_in_run: int | None = None,
    tds: Literal["", "deducted", "not_deducted"] = "",
    severity: str = "",
    partial: bool = False,
    issue_tab: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=1000),
    bar: _BarFilters = Depends(),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """One page of saved issues; filtering and paging happen in the database."""
    base = bar.apply(_in_selection(_scoped(db.query(TrackedIssue), current_user, db), company_code, financial_year))
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
    if seen_in_run is not None:
        # Raised by that run (new or again): "This Upload" for a pull too large for the browser.
        query = query.filter(TrackedIssue.last_seen_run_id == seen_in_run)
    query = _card_filters(query, tds, severity, partial)
    query = _issue_tab_filter(query, issue_tab.strip())
    if resolution_type.strip():
        query = query.filter(TrackedIssue.resolution_type == resolution_type.strip().upper())
    total = query.count()
    order = _desc_nulls_last(TrackedIssue.resolved_at) if status == "resolved" else (TrackedIssue.last_seen_at.desc(),)
    rows = query.order_by(*order, TrackedIssue.id.desc()).offset((page - 1) * page_size).limit(page_size).all()
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
    financial_year: str = "",
    seen_in_run: int | None = None,
    bar: _BarFilters = Depends(),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Issue book across every run: each issue once, however many files raised it.

    With ``seen_in_run``: only the issues that run raised (new or again), for the
    cards of a large SAP pull's "Issues · This Upload".
    """
    base = bar.apply(_in_selection(_scoped(db.query(TrackedIssue), current_user, db), company_code, financial_year))
    if seen_in_run is not None:
        base = base.filter(TrackedIssue.last_seen_run_id == seen_in_run)
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
    by_category = dict(
        open_rows.with_entities(TrackedIssue.report_category, func.count(TrackedIssue.id))
        .group_by(TrackedIssue.report_category).all()
    )
    by_tab = {tab: sum(by_category.get(category, 0) for category in categories) for tab, categories in ISSUE_TABS.items()}
    by_tab["other"] = open_count - sum(by_tab.values())
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
        "openByIssueTab": by_tab,
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
        .order_by(*_desc_nulls_last(TrackedIssue.posting_date), TrackedIssue.id.desc())
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


@router.get("/runs/{run_id}/exists")
def rule_run_exists(
    run_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, bool]:
    """Whether a run is still saved. The browser keeps a copy of the last
    upload; once its run is gone (clear_analysis.py) that copy is dropped."""
    return {"exists": db.query(RuleRun.id).filter(RuleRun.id == run_id).first() is not None}
