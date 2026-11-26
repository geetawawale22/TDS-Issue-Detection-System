"""Rows of a large SAP data API pull, saved for the Issues page.

A small upload sends its validation rows and issues to the browser, and the
Issues page (pages/Issues/Issues.jsx) works out its cards, tabs and table
from them. A pull too large for that (services/sap_analysis_job.py) saves
the same rows here instead, one batch at a time, and api/upload_rows.py
works out the same cards and pages the same table on the server.

Each row is stored as the browser would have received it (with its issues),
plus the few columns the cards and filters need. The page's own
reclassification (a zero base amount reads as Insufficient Data) is applied
here, so the server counts what the page would have shown.
"""

from __future__ import annotations

import json
import re
from datetime import date
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from db.bulk import insert_rows
from db.models import RuleRun, UploadRow

# Runs whose rows are kept; older runs' rows are deleted when a new run saves.
KEEP_RUNS = 2  # an 82k-row pull is ~110-200 MB here

# Issues page OPEN_ISSUE_TABS: report category -> tab under the cards.
ISSUE_TAB_BY_CATEGORY = {
    "short": "short",
    "excess": "excess",
    "not_deducted": "not_deducted",
    "ldc": "ldc",
    "advance_full": "advance",
    "advance_partial": "advance",
    "not_applicable": "not_applicable",
}

# utils/sectionAliases.js SECTION_ALIAS_PAIRS (old Act section <-> new Act section).
_SECTION_ALIAS_PAIRS = [
    ("194C", "393(1)6(i)"),
    ("194H", "393(1)1(ii)"),
    ("194I", "393(1)2(ii)"),
    ("194J", "393(1)6(iii)(a)"),
    ("194J", "393(1)6(iii)(b)"),
    ("194Q", "393(1)8(ii)"),
    ("194R", "393(1)8(iv)"),
]

# data/issueTypes.js getDisplayIssueType
_AMOUNT_MISMATCH_CATEGORY = "Short/Excess TDS Deducted — Amount Mismatch"
_DISPLAY_LABELS = {"LDC Not Yet Valid": "LDC Out of Date", "LDC Expired": "LDC Out of Date"}


def normalize_section(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "").strip().upper())


_ALIASES: dict[str, set[str]] = {}
for _legacy, _current in _SECTION_ALIAS_PAIRS:
    _ALIASES.setdefault(normalize_section(_legacy), set()).add(normalize_section(_current))
    _ALIASES.setdefault(normalize_section(_current), set()).add(normalize_section(_legacy))


def section_aliases(value: Any) -> set[str]:
    """sectionAliases(): each part of 'A, B' or 'A / B' plus its other-Act name."""
    aliases: set[str] = set()
    for part in re.split(r"[,/]", str(value or "")):
        part = normalize_section(part)
        if not part:
            continue
        aliases.add(part)
        aliases.update(_ALIASES.get(part, ()))
    return aliases


def has_section(value: Any) -> bool:
    text = normalize_section(value)
    return bool(text) and text not in {"—", "-"}


def display_issue_type(issue: dict[str, Any]) -> str:
    label = issue.get("category") or issue.get("issueTypeLabel") or ""
    shown = _DISPLAY_LABELS.get(label, label)
    if issue.get("category") != _AMOUNT_MISMATCH_CATEGORY:
        return shown
    base, rate, tds = issue.get("baseAmount"), issue.get("appliedRate"), issue.get("tdsAmount")
    try:
        diff = float(tds) - float(base) * (float(rate) / 100)
    except (TypeError, ValueError):
        return shown
    if abs(diff) <= 2:
        return shown
    return "Short TDS Deducted — Amount Mismatch" if diff < 0 else "Excess TDS Deducted — Amount Mismatch"


def _keys(values) -> str:
    """'|a|b|' so one value matches with LIKE '%|a|%'."""
    values = sorted({str(value) for value in values if value not in (None, "")})
    return f"|{'|'.join(values)}|" if values else ""


def _number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _page_status(row: dict[str, Any]) -> dict[str, Any]:
    """Issues.jsx adjustedValidationRows: a zero base can't be rate-checked."""
    status = row.get("status")
    if status in {"skipped", "issue"} or row.get("baseAmount") is None or _number(row.get("baseAmount")) != 0:
        return row
    if row.get("ldcCertificate") and _number(row.get("ldcExemptionPercent")) >= 100:
        return row
    return {**row, "status": "insufficient", "reason": "Base amount is zero, so TDS cannot be validated for this row."}


def _posting_date(row: dict[str, Any]) -> date | None:
    value = row.get("date") or row.get("postingDate")
    try:
        return date.fromisoformat(str(value)[:10]) if value else None
    except ValueError:
        return None


def _clip(value: Any, size: int) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text[:size] if text else None


def build_upload_rows(run_id: int, seq_start: int, validation_rows: list[dict[str, Any]], issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """UploadRow mappings for one batch; rows are numbered from ``seq_start``.

    Row and issue ids are made unique across the run's batches (each batch
    numbers its own from 1), and each issue keeps its row's number in
    ``rowIndex`` so the page pairs them as it does for a small upload.
    """
    issues_by_row: dict[Any, list[dict[str, Any]]] = {}
    for issue in issues:
        issues_by_row.setdefault(issue.get("rowIndex"), []).append(issue)

    mappings = []
    for offset, source in enumerate(validation_rows):
        seq = seq_start + offset
        row = _page_status(source)
        row_issues = [
            {**issue, "id": f"R{run_id}-{seq}-{position + 1}", "rowIndex": seq}
            for position, issue in enumerate(issues_by_row.get(source.get("rowIndex"), []))
        ]
        row = {**row, "id": f"R{run_id}-{seq}", "rowIndex": seq, "issues": row_issues}
        status = row.get("status") or "passed"
        if status == "corrected":
            tab = "resolved"
        elif status == "issue":
            tab = ISSUE_TAB_BY_CATEGORY.get(row.get("reportCategory"), "other")
        else:
            tab = None
        sections = [row.get("section"), row.get("legacySection"), row.get("ruleSection"), row.get("newSection")]
        types = set()
        for issue in row_issues:
            types.update(filter(None, (display_issue_type(issue), issue.get("category"), issue.get("issueTypeLabel"), issue.get("issueType"))))
        doc_type = str(row.get("docType") or "").strip().upper()
        mappings.append({
            "run_id": run_id,
            "seq": seq,
            "company_code": str(row.get("companyCode") or "")[:10],
            "posting_date": _posting_date(row),
            "status": status,
            "tds_deducted": abs(_number(row.get("tdsAmount"))) > 0,
            "report_category": _clip(row.get("reportCategory"), 30),
            "issue_tab": tab,
            "vendor": _clip(row.get("vendor"), 255),
            "vendor_code": _clip(row.get("vendorId"), 50),
            "vendor_pan": _clip(row.get("vendorPan"), 20),
            "doc_no": _clip(row.get("docNo"), 50),
            "doc_type": doc_type[:10] if doc_type and doc_type != "—" else None,
            "section": _clip(row.get("section"), 100),
            "profit_center": _clip(row.get("profitCenter"), 50),
            "section_keys": _keys(alias for value in sections for alias in section_aliases(value))[:500],
            "has_section": any(has_section(value) for value in sections),
            "issue_severities": _keys(issue.get("severity") for issue in row_issues)[:100],
            "issue_statuses": _keys(issue.get("status") for issue in row_issues)[:200],
            "issue_types": _keys(types) or None,
            "data": json.dumps(row, default=str),
        })
    return mappings


def save_upload_rows(db: Session, run_id: int, validation_rows: list[dict[str, Any]], issues: list[dict[str, Any]]) -> int:
    """Add one batch's rows to the run; on its first batch, drop old runs' rows."""
    last_seq = db.query(func.max(UploadRow.seq)).filter(UploadRow.run_id == run_id).scalar()
    if last_seq is None:
        keep = [row.id for row in db.query(RuleRun.id).order_by(RuleRun.id.desc()).limit(KEEP_RUNS)]
        if run_id not in keep:
            keep.append(run_id)
        db.query(UploadRow).filter(UploadRow.run_id.notin_(keep)).delete(synchronize_session=False)
    rows = build_upload_rows(run_id, (last_seq or 0) + 1, validation_rows, issues)
    for start in range(0, len(rows), 2000):
        insert_rows(db, UploadRow, rows[start:start + 2000])
    db.commit()
    return len(rows)
