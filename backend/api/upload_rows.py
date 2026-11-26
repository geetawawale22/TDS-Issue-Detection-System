"""Issues page (Issues · This Upload) for a large SAP data API pull.

The same cards, category tabs and table as pages/Issues/Issues.jsx works out
in the browser for a small upload, worked out here over the run's saved rows
(services/upload_rows.py) and sent one page at a time. Filter meanings follow
Issues.jsx: the filter bar (search, vendor, section, doc type, profit
center, period) narrows every row; severity / status / issue type exist only
on issues, so while one is set only issue rows with such an issue remain.
"""

from __future__ import annotations

import json
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, case, func, or_
from sqlalchemy.orm import Session

from core.dependencies import get_current_user, get_user_company_codes
from db.database import get_db
from db.models import UploadRow, User
from services.ledger_store import financial_year_range
from services.upload_rows import section_aliases

router = APIRouter(prefix="/upload-rows", tags=["Issues · This Upload"])

NO_SECTION = "No Section"

# Issues.jsx BUCKET_VIEWS: TDS deducted or not x passed / issue rows.
BUCKET_VIEWS = {
    "passed_deducted": (True, ("passed", "skipped")),
    "issue_deducted": (True, ("issue",)),
    "passed_not_deducted": (False, ("passed", "skipped")),
    "issue_not_deducted": (False, ("issue",)),
}
ISSUE_TABS = ("short", "excess", "not_deducted", "ldc", "advance", "not_applicable", "other", "resolved")


def _values(values: list[str]) -> list[str]:
    return [value for value in values if value and value != "all"]


def _contains_any(column, values: list[str]):
    return or_(*(column.like(f"%|{value}|%") for value in values))


class _Filters:
    def __init__(
        self,
        run_id: int,
        company_code: str = "",
        financial_year: str = "",
        search: str = "",
        vendor: list[str] = Query(default=[]),
        section: list[str] = Query(default=[]),
        doc_type: list[str] = Query(default=[]),
        profit_center: list[str] = Query(default=[]),
        severity: list[str] = Query(default=[]),
        status: list[str] = Query(default=[]),
        issue_type: list[str] = Query(default=[]),
        date_from: date | None = None,
        date_to: date | None = None,
    ) -> None:
        self.run_id = run_id
        self.company_code = company_code.strip()
        self.fy_range = financial_year_range(financial_year)
        self.search = search.strip().lower()
        self.vendor = _values(vendor)
        self.section = _values(section)
        self.doc_type = [value.upper() for value in _values(doc_type)]
        self.profit_center = _values(profit_center)
        self.severity = [value.lower() for value in _values(severity)]
        self.status = _values(status)
        # An issue-type option can stand for several categories joined with '||'.
        self.issue_type = [part for value in _values(issue_type) for part in value.split("||") if part]
        self.date_from = date_from
        self.date_to = date_to

    @property
    def issue_level(self) -> bool:
        return bool(self.severity or self.status or self.issue_type)

    def row_conditions(self, user: User, db: Session) -> list[Any]:
        """Run, company / FY scope and the filter bar (validationRowMatchesFilters)."""
        conditions: list[Any] = [UploadRow.run_id == self.run_id]
        if user.role != "admin":
            conditions.append(UploadRow.company_code.in_(list(get_user_company_codes(user, db))))
        if self.company_code:
            conditions.append(UploadRow.company_code == self.company_code)
        if self.fy_range:
            conditions.append(or_(UploadRow.posting_date.is_(None), UploadRow.posting_date.between(*self.fy_range)))
        if self.date_from:
            conditions.append(UploadRow.posting_date >= self.date_from)
        if self.date_to:
            conditions.append(UploadRow.posting_date <= self.date_to)
        if self.profit_center:
            conditions.append(UploadRow.profit_center.in_(self.profit_center))
        if self.search:
            like = f"%{self.search}%"
            conditions.append(or_(*(
                func.lower(column).like(like)
                for column in (UploadRow.vendor, UploadRow.doc_no, UploadRow.doc_type, UploadRow.vendor_code, UploadRow.section, UploadRow.vendor_pan)
            )))
        if self.vendor:
            conditions.append(UploadRow.vendor.in_(self.vendor))
        if self.section:
            options = []
            for value in self.section:
                if value == NO_SECTION:
                    options.append(UploadRow.has_section.is_(False))
                    continue
                aliases = section_aliases(value)
                if not aliases:  # nothing to match on: the filter passes every row, as on the page
                    options.append(UploadRow.id.isnot(None))
                    continue
                options.append(_contains_any(UploadRow.section_keys, sorted(aliases)))
            conditions.append(or_(*options))
        if self.doc_type:
            conditions.append(UploadRow.doc_type.in_(self.doc_type))
        if self.issue_level:
            conditions.append(self.issue_match())
        return conditions

    def issue_match(self):
        """Issue rows that still have an issue after severity / status / issue type."""
        parts = [UploadRow.status == "issue"]
        if self.severity:
            parts.append(_contains_any(UploadRow.issue_severities, self.severity))
        if self.status:
            parts.append(_contains_any(UploadRow.issue_statuses, self.status))
        if self.issue_type:
            parts.append(_contains_any(UploadRow.issue_types, self.issue_type))
        return and_(*parts)


def _view_condition(view: str):
    if view in BUCKET_VIEWS:
        deducted, statuses = BUCKET_VIEWS[view]
        return and_(UploadRow.tds_deducted.is_(deducted), UploadRow.status.in_(statuses))
    if view == "tds_deducted":
        return UploadRow.tds_deducted.is_(True)
    if view == "tds_not_deducted":
        return UploadRow.tds_deducted.is_(False)
    if view in {"issue", "passed", "insufficient", "skipped", "corrected"}:
        return UploadRow.status == view
    return None


def _count(condition):
    return func.coalesce(func.sum(case((condition, 1), else_=0)), 0)


@router.get("/summary")
def upload_rows_summary(
    filters: _Filters = Depends(),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """The Issues page cards for the run's rows under the filters."""
    available = db.query(UploadRow.id).filter(UploadRow.run_id == filters.run_id).first() is not None
    deducted = UploadRow.tds_deducted.is_(True)
    status = UploadRow.status
    row = db.query(
        func.count(UploadRow.id),
        _count(status == "passed"),
        _count(status == "issue"),
        _count(status == "insufficient"),
        _count(status == "skipped"),
        _count(status == "corrected"),
        _count(and_(status == "corrected", deducted)),
        _count(deducted),
        _count(and_(status == "insufficient", deducted)),
        *(_count(_view_condition(view)) for view in BUCKET_VIEWS),
    ).filter(*filters.row_conditions(current_user, db)).one()
    total, passed, issue, insufficient, skipped, corrected, corrected_deducted, deducted_rows, insufficient_deducted, *buckets = (int(value or 0) for value in row)
    return {
        "available": available,
        "totalRows": total,
        "passedRows": passed,
        "issueRows": issue,
        "insufficientDataRows": insufficient,
        "skippedRows": skipped,
        "correctedRows": corrected,
        "correctedDeducted": corrected_deducted,
        "deducted": deducted_rows,
        "notDeducted": total - deducted_rows,
        "insufficientDeducted": insufficient_deducted,
        "insufficientNotDeducted": insufficient - insufficient_deducted,
        "buckets": dict(zip(BUCKET_VIEWS, buckets)),
    }


@router.get("")
def upload_rows_page(
    view: str = "all",
    tab: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(1000, ge=1, le=5000),
    filters: _Filters = Depends(),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """One page of the table under the selected card and category tab, in pull order.

    ``tabCounts`` are the category tabs' counts for the card's rows, so a tab's
    count is what clicking it shows.
    """
    conditions = filters.row_conditions(current_user, db)
    condition = _view_condition(view)
    if condition is not None:
        conditions.append(condition)
    tab_counts = dict.fromkeys(ISSUE_TABS, 0)
    tab_counts.update({
        name: int(count)
        for name, count in db.query(UploadRow.issue_tab, func.count(UploadRow.id))
        .filter(*conditions, UploadRow.issue_tab.isnot(None))
        .group_by(UploadRow.issue_tab)
    })
    has_categories = db.query(UploadRow.id).filter(*conditions, UploadRow.report_category.isnot(None)).first() is not None
    if tab in ISSUE_TABS and has_categories:
        conditions.append(UploadRow.issue_tab == tab)
    query = db.query(UploadRow.seq, UploadRow.data).filter(*conditions)
    total = query.count()
    rows = query.order_by(UploadRow.seq).offset((page - 1) * page_size).limit(page_size).all()
    return {
        "items": [json.loads(row.data) for row in rows],
        "total": total,
        "page": page,
        "pageSize": page_size,
        "tabCounts": tab_counts,
        "hasReportCategories": has_categories,
    }


@router.get("/search")
def upload_rows_search(
    run_id: int,
    q: str = "",
    exclude_doc: str = "",
    limit: int = Query(80, ge=1, le=500),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Rows for Match SAP Rows: search hits by doc no. / vendor / PAN / section / doc type."""
    filters = _Filters(run_id=run_id, vendor=[], section=[], doc_type=[], profit_center=[], severity=[], status=[], issue_type=[])
    conditions = filters.row_conditions(current_user, db)
    if exclude_doc.strip():
        conditions.append(or_(UploadRow.doc_no.is_(None), UploadRow.doc_no != exclude_doc.strip()))
    query_text = q.strip().lower()
    if query_text:
        like = f"%{query_text}%"
        doc_like = f"%{query_text.lstrip('0') or query_text}%"
        conditions.append(or_(
            func.lower(UploadRow.vendor).like(like), func.lower(UploadRow.vendor_code).like(like),
            func.lower(UploadRow.vendor_pan).like(like), func.lower(UploadRow.section).like(like),
            func.lower(UploadRow.doc_type).like(like), UploadRow.doc_no.like(doc_like),
        ))
    query = db.query(UploadRow.data).filter(*conditions)
    total = query.count()
    rows = query.order_by(UploadRow.seq).limit(limit).all()
    return {"items": [json.loads(row.data) for row in rows], "total": total}

