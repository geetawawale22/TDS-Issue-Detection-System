"""TDS Category Report rows from the saved ledger lines (every run).

Each ledger line keeps its validation row as analysed (``ledger_lines.report``,
saved by api/issues.py). An issue can be resolved later, by a correction in
another file or by hand in Correction Center, so the issue history decides
when the report is read whether a row is still an issue or is resolved; the
same rules as the upload then file it (services/report_category.py).
"""
from __future__ import annotations

import json
from collections import defaultdict
from typing import Any, Iterable

from sqlalchemy import func, tuple_
from sqlalchemy.orm import Session

from db.models import LedgerLine, TrackedIssue
from services.ledger_store import financial_year_range
from services.report_category import apply_resolutions

_CHUNK = 500

LineKey = tuple[str, str, str, str]


def _chunks(values: list, size: int = _CHUNK) -> Iterable[list]:
    for start in range(0, len(values), size):
        yield values[start:start + size]


def _scope(companies: list[str] | None, company_code: str, financial_year: str) -> list[Any]:
    conditions: list[Any] = []
    if companies is not None:
        conditions.append(LedgerLine.company_code.in_(companies))
    if company_code.strip():
        conditions.append(LedgerLine.company_code == company_code.strip())
    period = financial_year_range(financial_year)
    if period:
        conditions.append(LedgerLine.posting_date.between(*period))
    return conditions


def _issue_state(db: Session, keys: list[LineKey]) -> dict[LineKey, list[Any]]:
    """Saved issues of each SAP line (company, fiscal year, document, line item)."""
    found: dict[LineKey, list[Any]] = defaultdict(list)
    identity = (TrackedIssue.company_code, TrackedIssue.fiscal_year, TrackedIssue.doc_no, TrackedIssue.line_item)
    for chunk in _chunks(keys):
        rows = db.query(
            *identity, TrackedIssue.status, TrackedIssue.severity, TrackedIssue.resolution_type,
            TrackedIssue.resolution_note, TrackedIssue.correction_docs,
        ).filter(tuple_(*identity).in_(chunk))
        for row in rows:
            found[(row.company_code, row.fiscal_year, row.doc_no, row.line_item)].append(row)
    return found


def _apply_issue_state(row: dict[str, Any], issues: list[Any]) -> None:
    """Issue row -> 'corrected' when every saved issue on its line is resolved now."""
    if not issues or any(issue.status != "resolved" for issue in issues):
        return
    first = issues[0]
    try:
        docs = json.loads(first.correction_docs) if first.correction_docs else []
    except ValueError:
        docs = []
    row["status"] = "corrected"
    row["originalReason"] = row.get("reason")
    row["originalSeverity"] = first.severity
    row["reason"] = first.resolution_note or "Resolved in the issue history."
    row["resolutionType"] = first.resolution_type
    row["correctionDocs"] = docs


def category_report_rows(
    db: Session,
    companies: list[str] | None,
    company_code: str = "",
    financial_year: str = "",
) -> dict[str, Any]:
    """Every saved line's report row in the Company / FY scope, filed as it stands now."""
    conditions = _scope(companies, company_code, financial_year)
    query = (
        db.query(LedgerLine.company_code, LedgerLine.fiscal_year, LedgerLine.doc_no, LedgerLine.line_item, LedgerLine.report)
        .filter(*conditions, LedgerLine.report.isnot(None))
        .order_by(LedgerLine.posting_date, LedgerLine.doc_no, LedgerLine.line_item, LedgerLine.withholding_tax_type, LedgerLine.withholding_tax_code)
    )
    rows: list[dict[str, Any]] = []
    keys: list[LineKey] = []
    for line in query:
        row = json.loads(line.report)
        key = (line.company_code, line.fiscal_year, line.doc_no, line.line_item)
        if row.get("status") in ("issue", "corrected"):
            # Saved before resolutions; the issue history decides below.
            row["status"] = "issue"
            keys.append(key)
        row["_key"] = key
        rows.append(row)

    state = _issue_state(db, list(set(keys)))
    for row in rows:
        key = row.pop("_key")
        if row.get("status") == "issue":
            _apply_issue_state(row, state.get(key, []))
    apply_resolutions(rows)

    for index, row in enumerate(rows, start=1):
        row["id"] = index
    without_report = db.query(func.count(LedgerLine.id)).filter(*conditions, LedgerLine.report.is_(None)).scalar() or 0
    return {"rows": rows, "linesWithoutReport": without_report}
