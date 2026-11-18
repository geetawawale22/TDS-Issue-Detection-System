"""Document Ledger and GL Ledger over every saved line (all runs / daily feed).

Filtering, counting and paging run in the database, so this stays usable for a
whole year of daily files. Row shapes match the per-upload ledger so the TDS
Analysis tables render them unchanged. See services/ledger_store.py.
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, case, exists, func, literal, or_
from sqlalchemy.orm import Session

from core.dependencies import get_current_user, get_user_company_codes
from db.database import get_db
from db.models import LedgerGroup, LedgerLine, TrackedIssue, User
from services.issue_tracker import tracked_issue_to_dict
from services.ledger_store import NO_SECTION, financial_year_range

router = APIRouter(prefix="/ledger", tags=["Ledger (all runs)"])

_MAX_GL_LINES = 5000


class _Filters:
    """The TDS Analysis filter bar, as query parameters."""

    def __init__(
        self,
        company_code: str = "",
        financial_year: str = "",
        vendor: list[str] = Query(default=[]),
        section: list[str] = Query(default=[]),
        doc_type: list[str] = Query(default=[]),
        profit_center: list[str] = Query(default=[]),
        severity: list[str] = Query(default=[]),
        issue_type: list[str] = Query(default=[]),
        issue_status: list[str] = Query(default=[]),
        date_from: date | None = None,
        date_to: date | None = None,
        search: str = "",
    ) -> None:
        self.company_code = company_code.strip()
        self.fy_range = financial_year_range(financial_year)
        self.vendor = [v for v in vendor if v]
        self.section = [v for v in section if v]
        self.doc_type = [v.upper() for v in doc_type if v]
        self.profit_center = [v for v in profit_center if v]
        self.severity = [v.lower() for v in severity if v]
        # An issue-type option can stand for several categories joined with '||'.
        self.issue_type = [part for value in issue_type for part in value.split("||") if part]
        self.issue_status = [v for v in issue_status if v]
        self.date_from = date_from
        self.date_to = date_to
        self.search = search.strip()


def _allowed_companies(user: User, db: Session) -> list[str] | None:
    return None if user.role == "admin" else list(get_user_company_codes(user, db))


def _line_conditions(filters: _Filters, companies: list[str] | None, include_vendor: bool) -> list[Any]:
    """Conditions on LedgerLine for the filter bar (company, FY, line attributes, issues)."""
    conditions: list[Any] = []
    if companies is not None:
        conditions.append(LedgerLine.company_code.in_(companies))
    if filters.company_code:
        conditions.append(LedgerLine.company_code == filters.company_code)
    if filters.fy_range:
        conditions.append(LedgerLine.posting_date.between(*filters.fy_range))
    if filters.date_from:
        conditions.append(LedgerLine.posting_date >= filters.date_from)
    if filters.date_to:
        conditions.append(LedgerLine.posting_date <= filters.date_to)
    if include_vendor and filters.vendor:
        conditions.append(func.coalesce(LedgerLine.vendor_name, LedgerLine.vendor_code).in_(filters.vendor))
    if filters.section:
        options = []
        for value in filters.section:
            if value == NO_SECTION:
                options.append(LedgerLine.section.is_(None))
            else:
                options.append(LedgerLine.section == value)
                options.append(LedgerLine.section_label.ilike(f"%{value}%"))
        conditions.append(or_(*options))
    if filters.doc_type:
        conditions.append(func.upper(LedgerLine.doc_type).in_(filters.doc_type))
    if filters.profit_center:
        conditions.append(LedgerLine.profit_center.in_(filters.profit_center))
    if filters.severity or filters.issue_type or filters.issue_status:
        issue = [
            TrackedIssue.company_code == LedgerLine.company_code,
            TrackedIssue.fiscal_year == LedgerLine.fiscal_year,
            TrackedIssue.doc_no == LedgerLine.doc_no,
        ]
        if filters.severity:
            issue.append(TrackedIssue.severity.in_(filters.severity))
        if filters.issue_type:
            issue.append(or_(TrackedIssue.category.in_(filters.issue_type), TrackedIssue.issue_type.in_(filters.issue_type)))
        if filters.issue_status:
            issue.append(TrackedIssue.status.in_(filters.issue_status))
        else:
            issue.append(TrackedIssue.status == "open")
        conditions.append(exists().where(*issue))
    return conditions


def _line_search(term: str) -> Any:
    like = f"%{term}%"
    return or_(
        LedgerLine.doc_no.ilike(like), LedgerLine.assignment_number.ilike(like),
        LedgerLine.reference_document.ilike(like), LedgerLine.gl_account.ilike(like),
        LedgerLine.section_label.ilike(like), LedgerLine.vendor_name.ilike(like),
        LedgerLine.vendor_code.ilike(like), LedgerLine.vendor_pan.ilike(like),
        LedgerLine.doc_type.ilike(like), LedgerLine.event_type.ilike(like),
    )


def _open_issue_categories(db: Session, lines: list[LedgerLine]) -> dict[tuple[str, str, str], list[str]]:
    keys = list({(line.company_code, line.fiscal_year, line.doc_no) for line in lines})
    found: dict[tuple[str, str, str], list[str]] = defaultdict(list)
    for start in range(0, len(keys), 500):
        chunk = keys[start:start + 500]
        rows = db.query(TrackedIssue.company_code, TrackedIssue.fiscal_year, TrackedIssue.doc_no, TrackedIssue.category).filter(
            TrackedIssue.status == "open",
            func.concat(TrackedIssue.company_code, "|", TrackedIssue.fiscal_year, "|", TrackedIssue.doc_no).in_(
                [f"{c}|{f}|{d}" for c, f, d in chunk]
            ),
        )
        for row in rows:
            found[(row.company_code, row.fiscal_year, row.doc_no)].append(row.category)
    return found


def _event(line: LedgerLine, issues: dict[tuple[str, str, str], list[str]]) -> dict[str, Any]:
    event = json.loads(line.event)
    event["issues"] = issues.get((line.company_code, line.fiscal_year, line.doc_no), [])
    return event


def _num(value: Any) -> float:
    return float(value or 0)


def _group_row(group: LedgerGroup, events: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": f"LEDGER-{group.group_key}",
        "caseId": f"LEDGER-{group.group_key}",
        "groupType": group.group_type,
        "openItem": group.open_item,
        "anchorDocNo": group.anchor_doc or "—",
        "clearingDocument": group.clearing_document or "—",
        "assignmentNumber": group.assignment_number or "—",
        "companyCode": group.company_code or None,
        "financialYear": group.fiscal_year or None,
        "vendor": group.vendor_name or "Unknown vendor",
        "vendorId": group.vendor_code or "—",
        "pan": group.vendor_pan or "—",
        "section": group.section or "—",
        "invoiceAmount": _num(group.invoice_amount),
        "advanceAmount": _num(group.advance_amount),
        "paymentAmount": _num(group.payment_amount),
        "baseAmount": _num(group.base_amount),
        "adjustmentAmount": _num(group.adjustment_amount),
        "debitAmount": _num(group.debit_amount),
        "creditAmount": _num(group.credit_amount),
        "netAmount": _num(group.net_amount),
        "openAmount": _num(group.open_amount),
        "tdsAmount": _num(group.tds_amount),
        "eventCount": group.event_count,
        "issueCount": group.issue_count,
        "status": group.status,
        "events": events,
    }


@router.get("/groups")
def ledger_groups(
    status: str = "all",
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=500),
    filters: _Filters = Depends(),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Document Ledger groups over all saved lines: one page, plus the card counts."""
    companies = _allowed_companies(current_user, db)
    conditions = _line_conditions(filters, companies, include_vendor=False)
    if filters.search:
        like = f"%{filters.search}%"
        group_search = or_(
            LedgerGroup.anchor_doc.ilike(like), LedgerGroup.vendor_name.ilike(like),
            LedgerGroup.vendor_code.ilike(like), LedgerGroup.vendor_pan.ilike(like),
            LedgerGroup.assignment_number.ilike(like), LedgerGroup.clearing_document.ilike(like),
            LedgerGroup.status.ilike(like), LedgerGroup.section.ilike(like),
        )
    query = db.query(LedgerGroup)
    if companies is not None:
        query = query.filter(LedgerGroup.company_code.in_(companies))
    if filters.company_code:
        query = query.filter(LedgerGroup.company_code == filters.company_code)
    if filters.vendor:
        query = query.filter(LedgerGroup.vendor_name.in_(filters.vendor))
    line_match = exists().where(LedgerLine.group_key == LedgerGroup.group_key, *conditions)
    if filters.search:
        query = query.filter(or_(group_search, exists().where(
            LedgerLine.group_key == LedgerGroup.group_key, *conditions, _line_search(filters.search),
        )))
    query = query.filter(line_match)

    counts = dict(query.with_entities(LedgerGroup.status, func.count(LedgerGroup.id)).group_by(LedgerGroup.status).all())
    open_items = query.filter(or_(LedgerGroup.open_item.is_(True), LedgerGroup.status == "OPEN")).count()

    if status == "balanced":
        query = query.filter(LedgerGroup.status == "BALANCED")
    elif status == "open":
        query = query.filter(or_(LedgerGroup.open_item.is_(True), LedgerGroup.status == "OPEN"))
    elif status == "issue":
        query = query.filter(LedgerGroup.status == "ISSUE")
    elif status == "clearing_only":
        query = query.filter(LedgerGroup.status == "CLEARING_ONLY")
    total = query.count()
    groups = (
        query.order_by(case((LedgerGroup.status == "ISSUE", 0), else_=1), LedgerGroup.anchor_doc, LedgerGroup.id)
        .offset((page - 1) * page_size).limit(page_size).all()
    )

    lines_by_group: dict[str, list[LedgerLine]] = defaultdict(list)
    keys = [group.group_key for group in groups]
    if keys:
        lines = (
            db.query(LedgerLine).filter(LedgerLine.group_key.in_(keys))
            .order_by(LedgerLine.posting_date, LedgerLine.doc_no, LedgerLine.line_item).all()
        )
        issues = _open_issue_categories(db, lines)
        for line in lines:
            lines_by_group[line.group_key].append(_event(line, issues))

    transactions = db.query(func.count(LedgerLine.id)).filter(
        *_line_conditions(filters, companies, include_vendor=True),
        *([_line_search(filters.search)] if filters.search else []),
    ).scalar()
    return {
        "items": [_group_row(group, lines_by_group[group.group_key]) for group in groups],
        "total": total,
        "page": page,
        "pageSize": page_size,
        "counts": {
            "groups": sum(counts.values()),
            "balanced": counts.get("BALANCED", 0),
            "open": open_items,
            "issue": counts.get("ISSUE", 0),
            "clearingOnly": counts.get("CLEARING_ONLY", 0),
            "transactions": transactions or 0,
        },
    }


def _gl_columns():
    base = func.abs(func.coalesce(LedgerLine.base_amount, 0))
    tds = func.coalesce(LedgerLine.tds_amount, 0)
    skipped = or_(LedgerLine.rate_check_na.is_(True), and_(tds == 0, LedgerLine.has_open_issue.is_(False)))
    target = case((LedgerLine.ldc_certificate.isnot(None), LedgerLine.ldc_expected_rate), else_=LedgerLine.sap_rate)
    off_by = func.abs(base * target / 100 - tds)
    checked = and_(~skipped, tds > 0, target.isnot(None), base > 0)
    matched = and_(checked, off_by <= 1)
    mismatched = and_(~skipped, or_(tds == 0, and_(checked, off_by > 1)))
    keys = (
        LedgerLine.company_code, LedgerLine.gl_account, LedgerLine.section_label, LedgerLine.sap_rate,
        LedgerLine.ldc_certificate, LedgerLine.ldc_rate, LedgerLine.ldc_expected_rate,
    )
    aggregates = (
        func.count(LedgerLine.id).label("row_count"),
        func.sum(base).label("base_amount"),
        func.sum(tds).label("tds_amount"),
        func.sum(case((tds > 0, 1), else_=0)).label("deducted_rows"),
        func.sum(case((matched, 1), else_=0)).label("matched_rows"),
        func.sum(case((mismatched, 1), else_=0)).label("mismatched_rows"),
        func.sum(case((~skipped, base), else_=0)).label("checked_base"),
        func.sum(case((~skipped, tds), else_=0)).label("checked_tds"),
        func.sum(case((LedgerLine.has_open_issue.is_(True), 1), else_=0)).label("issue_rows"),
    )
    return keys, aggregates


def _gl_key(row) -> dict[str, Any]:
    return {
        "companyCode": row.company_code or "",
        "glAccount": row.gl_account or "",
        "section": row.section_label or NO_SECTION,
        "rate": float(row.sap_rate) if row.sap_rate is not None else None,
        "ldcCertificate": row.ldc_certificate,
        "ldcRate": float(row.ldc_rate) if row.ldc_rate is not None else None,
        "ldcExpectedRate": float(row.ldc_expected_rate) if row.ldc_expected_rate is not None else None,
    }


@router.get("/gl")
def gl_ledger(
    filters: _Filters = Depends(),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """GL Ledger rows (company + GL + section + SAP rate + LDC) over all saved lines."""
    companies = _allowed_companies(current_user, db)
    conditions = _line_conditions(filters, companies, include_vendor=True)
    if filters.search:
        conditions.append(_line_search(filters.search))
    keys, aggregates = _gl_columns()
    rows = db.query(*keys, *aggregates).filter(*conditions).group_by(*keys).all()

    profit_centers: dict[tuple, list[str]] = defaultdict(list)
    for row in db.query(*keys, LedgerLine.profit_center).filter(*conditions, LedgerLine.profit_center.isnot(None)).group_by(*keys, LedgerLine.profit_center):
        profit_centers[tuple(row[:7])].append(row.profit_center)

    items = []
    for row in rows:
        key = _gl_key(row)
        ldc = None
        if key["ldcCertificate"] and key["ldcRate"] is not None:
            ldc = {"certificate": key["ldcCertificate"], "exemptionRate": key["ldcRate"], "expectedRate": key["ldcExpectedRate"]}
        checked_base = _num(row.checked_base)
        status = "mismatched" if row.mismatched_rows else "matched" if row.matched_rows else None
        centers = sorted(profit_centers.get(tuple(row[:7]), []))
        items.append({
            "id": "GL-" + json.dumps(key, sort_keys=True),
            "glKey": json.dumps(key, sort_keys=True),
            "keyParts": key,
            "companyCode": key["companyCode"] or "—",
            "glAccount": key["glAccount"] or "No GL",
            "section": key["section"],
            "rate": key["rate"],
            "ldc": ldc,
            "rowCount": row.row_count,
            "baseAmount": _num(row.base_amount),
            "tdsAmount": _num(row.tds_amount),
            "calculatedRate": (_num(row.checked_tds) / checked_base * 100) if checked_base > 0 else None,
            "rateStatus": status,
            "deductedRows": int(row.deducted_rows or 0),
            "notDeductedRows": row.row_count - int(row.deducted_rows or 0),
            "issueRows": int(row.issue_rows or 0),
            "profitCenterLabel": (", ".join(centers[:3]) + (f" +{len(centers) - 3}" if len(centers) > 3 else "")) if centers else "—",
            "events": [],
            "issues": [],
        })
    items.sort(key=lambda item: (
        item["companyCode"], item["glAccount"], item["section"] == NO_SECTION, item["section"],
        item["rate"] is None, item["rate"] or 0, item["ldc"] is not None,
        (item["ldc"] or {}).get("certificate") or "", (item["ldc"] or {}).get("exemptionRate") or 0,
    ))
    return {"items": items}


def _nullable_equal(column, value):
    return column.is_(None) if value is None or value == "" else column == value


@router.get("/gl/lines")
def gl_ledger_lines(
    gl_key: str,
    filters: _Filters = Depends(),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Transactions and open issues behind one GL Ledger row."""
    key = json.loads(gl_key)
    companies = _allowed_companies(current_user, db)
    conditions = _line_conditions(filters, companies, include_vendor=True)
    if filters.search:
        conditions.append(_line_search(filters.search))
    conditions += [
        LedgerLine.company_code == key.get("companyCode", ""),
        _nullable_equal(LedgerLine.gl_account, key.get("glAccount")),
        LedgerLine.section_label == key.get("section") if key.get("section") != NO_SECTION
        else or_(LedgerLine.section_label == NO_SECTION, LedgerLine.section_label.is_(None)),
        _nullable_equal(LedgerLine.sap_rate, key.get("rate")),
        _nullable_equal(LedgerLine.ldc_certificate, key.get("ldcCertificate")),
        _nullable_equal(LedgerLine.ldc_rate, key.get("ldcRate")),
        _nullable_equal(LedgerLine.ldc_expected_rate, key.get("ldcExpectedRate")),
    ]
    lines = (
        db.query(LedgerLine).filter(*conditions)
        .order_by(LedgerLine.posting_date, LedgerLine.doc_no, LedgerLine.line_item)
        .limit(_MAX_GL_LINES + 1).all()
    )
    truncated = len(lines) > _MAX_GL_LINES
    lines = lines[:_MAX_GL_LINES]
    issue_categories = _open_issue_categories(db, lines)
    events = []
    for index, line in enumerate(lines):
        event = _event(line, issue_categories)
        event.update({
            "id": f"{line.id}-{index}",
            "vendor": line.vendor_name or line.vendor_code or "Unknown vendor",
            "vendorId": line.vendor_code or "—",
            "pan": line.vendor_pan or "—",
        })
        events.append(event)

    doc_keys = {f"{line.company_code}|{line.fiscal_year}|{line.doc_no}" for line in lines}
    issues = []
    doc_list = list(doc_keys)
    for start in range(0, len(doc_list), 500):
        rows = db.query(TrackedIssue).filter(
            TrackedIssue.status == "open",
            func.concat(TrackedIssue.company_code, "|", TrackedIssue.fiscal_year, "|", TrackedIssue.doc_no).in_(doc_list[start:start + 500]),
        )
        issues.extend(tracked_issue_to_dict(row) for row in rows)
    return {"events": events, "issues": issues, "truncated": truncated}


@router.get("/options")
def ledger_filter_options(
    company_code: str = "",
    financial_year: str = "",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Values for the filter dropdowns, from every saved line in scope."""
    companies = _allowed_companies(current_user, db)
    filters = _Filters(
        company_code=company_code, financial_year=financial_year, vendor=[], section=[], doc_type=[],
        profit_center=[], severity=[], issue_type=[], issue_status=[], date_from=None, date_to=None, search="",
    )
    conditions = _line_conditions(filters, companies, include_vendor=False)

    def distinct(column, limit: int = 5000) -> list[str]:
        rows = db.query(column).filter(*conditions, column.isnot(None)).distinct().limit(limit).all()
        return sorted(str(row[0]) for row in rows if str(row[0]).strip())

    has_lines = db.query(literal(1)).filter(exists().where(*conditions) if conditions else exists().where(LedgerLine.id.isnot(None))).scalar()
    return {
        "hasData": bool(has_lines),
        "vendors": distinct(func.coalesce(LedgerLine.vendor_name, LedgerLine.vendor_code)),
        "sections": distinct(LedgerLine.section),
        "profitCenters": distinct(LedgerLine.profit_center),
        "docTypes": distinct(func.upper(LedgerLine.doc_type)),
    }
