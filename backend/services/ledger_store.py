"""Document / GL Ledger across runs (daily SAP feed).

Every analysed file's lines are saved in ``ledger_lines`` (one row per
company + fiscal year + document + line item + withholding tax type/code; a
line with two withholding taxes has two rows, and only the first counts the
line's amount) and grouped in ``ledger_groups``
the same way the per-upload ledger groups them:

    clearing document -> reference document (REBZG) -> assignment -> document

so an invoice posted one day and its payment / clearing on a later day end up
in one group. Two ways a later file can close an earlier open line:

* SAP sends the line again with its clearing document filled -> the saved line
  is updated and moves to the clearing group;
* SAP only sends the new lines -> a new line that references the earlier
  document (REBZG) and carries a clearing document passes that clearing on to
  the earlier, still-open line ("inferred" clearing).

Group status follows the issues that are still open in ``tracked_issues``, so
a group stops showing ISSUE once its issue is corrected in a later run.
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import date
from typing import Any, Iterable

from sqlalchemy import and_, exists, func, select, tuple_, update
from sqlalchemy.orm import Session

from db.models import LedgerGroup, LedgerLine, TrackedIssue
from services.issue_tracker import fiscal_year_for

_CHUNK = 500
NO_SECTION = "No Section"


def _chunks(values: list, size: int = _CHUNK) -> Iterable[list]:
    for start in range(0, len(values), size):
        yield values[start:start + size]


def _text(value: Any, limit: int | None = None) -> str | None:
    text = str(value or "").strip()
    if not text or text == "—":
        return None
    return text[:limit] if limit else text


def _rate(value: Any) -> float | None:
    """Rate rounded to 2 decimals; blank and 0 count as no rate (as the GL Ledger shows it)."""
    try:
        number = round(float(value), 2)
    except (TypeError, ValueError):
        return None
    return number or None


def section_label(legacy: Any, new: Any) -> str:
    """'Old / new' section label, e.g. '194C / 393(1)6(i)' (same as the GL Ledger)."""
    old_section, new_section = _text(legacy), _text(new)
    if old_section and new_section and old_section != new_section:
        return f"{old_section} / {new_section}"
    return old_section or new_section or NO_SECTION


def group_identity(line: dict[str, Any]) -> dict[str, Any]:
    """Group key and header for one saved line (mirrors the per-upload ledger)."""
    clearing = line.get("clearing_document") or line.get("inferred_clearing_document")
    clearing_year = (
        line.get("clearing_fiscal_year") if line.get("clearing_document")
        else line.get("inferred_clearing_fiscal_year")
    )
    fiscal_year = (clearing_year if clearing else None) or line.get("clearing_fiscal_year") or line.get("fiscal_year") or ""
    reference = line.get("reference_document")
    assignment = line.get("assignment_number")
    anchor = clearing or reference or assignment or line["doc_no"]
    if clearing:
        group_type = "CLEARING"
    else:
        group_type = "OPEN_REFERENCE" if reference else "OPEN_ASSIGNMENT" if assignment else "OPEN_DOCUMENT"
    company = line.get("company_code") or ""
    return {
        "group_key": f"{company}|{fiscal_year}|{anchor}"[:200],
        "fiscal_year": fiscal_year,
        "anchor": anchor,
        "group_type": group_type,
        "clearing": clearing,
    }


def _line_from_transaction(txn, event_type: str, event: dict[str, Any], run_id: int | None) -> dict[str, Any]:
    ldc_certificate = _text(event.get("ldcCertificate"), 100)
    ldc_rate = _rate(event.get("ldcRate")) if event.get("ldcRate") is not None else None
    has_ldc = bool(ldc_certificate and event.get("ldcRate") is not None)
    clearing = _text(txn.clearing_document, 50)
    doc_no = (txn.doc_number or "").strip()[:50]
    base = txn.basic_amount
    return {
        "company_code": (txn.company_code or "").strip()[:10],
        "fiscal_year": fiscal_year_for(txn)[:10],
        "doc_no": doc_no,
        "line_item": str(txn.line_item_number or "").strip()[:20],
        "withholding_tax_type": (txn.withholding_tax_type or "").strip().upper()[:10],
        "withholding_tax_code": (txn.withholding_tax_code or "").strip().upper()[:10],
        "clearing_document": clearing,
        "clearing_fiscal_year": _text(txn.clearing_fiscal_year, 10),
        "reference_document": _text(txn.invoice_reference_document or txn.advance_document_reference, 50),
        "assignment_number": _text(txn.assignment_number, 100),
        "vendor_code": _text(txn.vendor_code, 50),
        "vendor_name": _text(txn.vendor_name, 255),
        "vendor_pan": _text(txn.vendor_pan, 20),
        "doc_type": _text(txn.doc_type, 10),
        "event_type": event_type,
        "posting_date": txn.posting_date,
        "gl_account": _text(txn.gl_account, 30),
        "profit_center": _text(txn.profit_center, 50),
        "section": _text(event.get("tdsSection"), 100),
        "section_label": section_label(event.get("legacySection"), event.get("newSection"))[:150],
        "amount": float(txn.bill_amount or 0.0),
        "base_amount": float(base) if base is not None else None,
        "tds_amount": abs(float(txn.tds_deducted_amount or 0.0)),
        "sap_rate": _rate(event.get("sapRate")),
        "ldc_certificate": ldc_certificate if has_ldc else None,
        "ldc_rate": ldc_rate if has_ldc else None,
        "ldc_expected_rate": _rate(event.get("ldcExpectedRate")) if has_ldc else None,
        "rate_check_na": bool(event.get("rateCheckNotApplicable")),
        "self_clearing": bool(clearing and doc_no and clearing == doc_no),
        "event": json.dumps(event, default=str),
        "last_run_id": run_id,
    }


LineKey = tuple[str, str, str, str]


def _line_key(line: dict[str, Any]) -> LineKey:
    """One SAP line: company + fiscal year + document + line item."""
    return (line["company_code"], line["fiscal_year"], line["doc_no"], line["line_item"])


def save_run_lines(
    db: Session,
    run_id: int | None,
    items: list[tuple[Any, str, dict[str, Any]]],
    reports: dict[int, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Save one run's lines (``(txn, event_type, event)``) and refresh the groups they touch.

    Each withholding tax of a SAP line is its own row. When a file sends a line
    again, its saved rows are replaced by the ones sent now: rows matched by
    withholding type/code are updated, a row saved before withholding types were
    kept ('' type) is reused, and rows SAP no longer sends for that line go.

    ``reports`` maps id(txn) to the line's report row (TDS Category Report).
    """
    # Entries of each SAP line in this run, by withholding type/code (a repeated
    # identical row keeps the last one, as before).
    incoming: dict[LineKey, dict[tuple[str, str], dict[str, Any]]] = defaultdict(dict)
    for txn, event_type, event in items:
        line = _line_from_transaction(txn, event_type, event, run_id)
        if not line["doc_no"]:
            continue
        report = (reports or {}).get(id(txn))
        line["report"] = json.dumps(report, default=str) if report else None
        line["report_category"] = (str(report.get("reportCategory") or "")[:30] or None) if report else None
        incoming[_line_key(line)][(line["withholding_tax_type"], line["withholding_tax_code"])] = line

    identity = (LedgerLine.company_code, LedgerLine.fiscal_year, LedgerLine.doc_no, LedgerLine.line_item)
    existing: dict[LineKey, list[Any]] = defaultdict(list)
    for chunk in _chunks(list(incoming)):
        rows = db.query(
            LedgerLine.id, *identity, LedgerLine.withholding_tax_type, LedgerLine.withholding_tax_code,
            LedgerLine.group_key, LedgerLine.inferred_clearing_document, LedgerLine.inferred_clearing_fiscal_year,
        ).filter(tuple_(*identity).in_(chunk))
        for row in rows:
            existing[(row.company_code, row.fiscal_year, row.doc_no, row.line_item)].append(row)

    affected: set[str] = set()
    inserts, updates, removed = [], [], []
    saved = 0
    for key, entries in incoming.items():
        previous_rows = existing.get(key, [])
        by_withholding = {(row.withholding_tax_type, row.withholding_tax_code): row for row in previous_rows}
        claimed: set[int] = set()
        # Same order every run, so the same entry stays the primary one.
        for position, withholding in enumerate(sorted(entries)):
            line = entries[withholding]
            line["is_primary_entry"] = position == 0
            previous = by_withholding.get(withholding)
            if previous is None or previous.id in claimed:
                # Reuse a row from before withholding types were saved, or one SAP stopped sending.
                previous = next((row for row in previous_rows if row.id not in claimed and (row.withholding_tax_type, row.withholding_tax_code) not in entries), None)
            if previous is not None and not line["clearing_document"]:
                # Keep a clearing learnt from a later line until SAP sends its own.
                line["inferred_clearing_document"] = previous.inferred_clearing_document
                line["inferred_clearing_fiscal_year"] = previous.inferred_clearing_fiscal_year
            elif line["clearing_document"]:
                line["inferred_clearing_document"] = None
                line["inferred_clearing_fiscal_year"] = None
            elif previous_rows:
                # A new withholding entry on a line saved earlier shares that line's inferred clearing.
                line["inferred_clearing_document"] = previous_rows[0].inferred_clearing_document
                line["inferred_clearing_fiscal_year"] = previous_rows[0].inferred_clearing_fiscal_year
            line["group_key"] = group_identity(line)["group_key"]
            affected.add(line["group_key"])
            saved += 1
            if previous is None:
                inserts.append({**line, "first_run_id": run_id})
            else:
                claimed.add(previous.id)
                affected.add(previous.group_key)
                updates.append({**line, "id": previous.id})
        for row in previous_rows:
            if row.id not in claimed:
                removed.append(row.id)
                affected.add(row.group_key)

    if removed:
        db.query(LedgerLine).filter(LedgerLine.id.in_(removed)).delete(synchronize_session=False)
    if updates:
        db.bulk_update_mappings(LedgerLine, updates)
    if inserts:
        db.bulk_insert_mappings(LedgerLine, inserts)
    db.flush()

    all_lines = [line for entries in incoming.values() for line in entries.values()]
    affected |= _infer_clearing(db, all_lines)
    companies = sorted({key[0] for key in incoming})
    _refresh_issue_flags(db, companies)
    _rebuild_groups(db, affected)
    _refresh_group_issues(db, companies)
    db.commit()
    return {"linesSaved": saved, "newLines": len(inserts), "groupsTouched": len(affected)}


def _infer_clearing(db: Session, lines: list[dict[str, Any]]) -> set[str]:
    """Pass a later line's clearing document to the earlier open document it references."""
    clearing_by_ref: dict[tuple[str, str], tuple[str, str | None]] = {}
    for line in lines:
        reference = line.get("reference_document")
        clearing = line.get("clearing_document")
        if reference and clearing and reference != line["doc_no"]:
            clearing_by_ref[(line["company_code"], reference)] = (clearing, line.get("clearing_fiscal_year"))
    if not clearing_by_ref:
        return set()

    affected: set[str] = set()
    updates = []
    columns = (
        LedgerLine.id, LedgerLine.company_code, LedgerLine.fiscal_year, LedgerLine.doc_no, LedgerLine.group_key,
        LedgerLine.clearing_fiscal_year, LedgerLine.reference_document, LedgerLine.assignment_number,
        LedgerLine.inferred_clearing_document,
    )
    for chunk in _chunks(list(clearing_by_ref)):
        rows = db.query(*columns).filter(
            tuple_(LedgerLine.company_code, LedgerLine.doc_no).in_(chunk),
            LedgerLine.clearing_document.is_(None),
        )
        for row in rows:
            clearing, clearing_year = clearing_by_ref[(row.company_code, row.doc_no)]
            if row.inferred_clearing_document == clearing:
                continue
            line = {
                "company_code": row.company_code, "fiscal_year": row.fiscal_year, "doc_no": row.doc_no,
                "clearing_document": None, "clearing_fiscal_year": row.clearing_fiscal_year,
                "inferred_clearing_document": clearing, "inferred_clearing_fiscal_year": clearing_year,
                "reference_document": row.reference_document, "assignment_number": row.assignment_number,
            }
            new_key = group_identity(line)["group_key"]
            updates.append({
                "id": row.id, "inferred_clearing_document": clearing,
                "inferred_clearing_fiscal_year": clearing_year, "group_key": new_key,
            })
            affected.update({row.group_key, new_key})
    if updates:
        db.bulk_update_mappings(LedgerLine, updates)
        db.flush()
    return affected


def _open_issue_exists():
    return exists().where(
        TrackedIssue.status == "open",
        TrackedIssue.company_code == LedgerLine.company_code,
        TrackedIssue.fiscal_year == LedgerLine.fiscal_year,
        TrackedIssue.doc_no == LedgerLine.doc_no,
    )


def _refresh_issue_flags(db: Session, companies: list[str]) -> None:
    """has_open_issue on each line follows tracked_issues (written only where it changed)."""
    if not companies:
        return
    flag = _open_issue_exists()
    db.execute(
        update(LedgerLine)
        .where(LedgerLine.company_code.in_(companies), LedgerLine.has_open_issue != flag)
        .values(has_open_issue=flag)
        .execution_options(synchronize_session=False)
    )


def _status(issue_count: int, open_item: bool, net_amount: float, clearing_only: bool = False) -> str:
    if issue_count:
        return "ISSUE"
    if clearing_only:
        # Only the clearing entry is known; what it settles is not in the data.
        return "CLEARING_ONLY"
    if open_item:
        return "OPEN"
    return "BALANCED" if abs(net_amount) <= 1 else "OPEN"


def _rebuild_groups(db: Session, group_keys: set[str]) -> None:
    """Recalculate the given groups from their saved lines (same sums as the per-upload ledger)."""
    keys = sorted(key for key in group_keys if key)
    for chunk in _chunks(keys):
        lines = (
            db.query(LedgerLine)
            .filter(LedgerLine.group_key.in_(chunk))
            .order_by(
                LedgerLine.group_key, LedgerLine.posting_date, LedgerLine.doc_no, LedgerLine.line_item,
                LedgerLine.is_primary_entry.desc(), LedgerLine.withholding_tax_type, LedgerLine.withholding_tax_code,
            )
            .all()
        )
        by_group: dict[str, list[LedgerLine]] = defaultdict(list)
        for line in lines:
            by_group[line.group_key].append(line)

        current = {row.group_key: row.id for row in db.query(LedgerGroup.id, LedgerGroup.group_key).filter(LedgerGroup.group_key.in_(chunk))}
        stale = [current[key] for key in chunk if key in current and key not in by_group]
        if stale:
            db.query(LedgerGroup).filter(LedgerGroup.id.in_(stale)).delete(synchronize_session=False)

        inserts, updates = [], []
        for key, group_lines in by_group.items():
            first = group_lines[0]
            identity = group_identity({
                "company_code": first.company_code, "fiscal_year": first.fiscal_year, "doc_no": first.doc_no,
                "clearing_document": first.clearing_document, "clearing_fiscal_year": first.clearing_fiscal_year,
                "inferred_clearing_document": first.inferred_clearing_document,
                "inferred_clearing_fiscal_year": first.inferred_clearing_fiscal_year,
                "reference_document": first.reference_document, "assignment_number": first.assignment_number,
            })
            sums = defaultdict(float)
            for line in group_lines:
                # A line's second withholding tax adds its own base and TDS, not the line amount again.
                amount = float(line.amount or 0) if line.is_primary_entry else 0.0
                absolute = abs(amount)
                sums["debit" if amount >= 0 else "credit"] += absolute
                sums["net"] += amount
                if line.event_type == "INVOICE":
                    sums["invoice"] += absolute
                elif line.event_type == "ADVANCE_PAYMENT" and not line.self_clearing:
                    sums["advance"] += absolute
                elif line.event_type == "PAYMENT":
                    sums["payment"] += absolute
                else:
                    sums["adjustment"] += absolute
                if line.event_type in {"INVOICE", "ADVANCE_PAYMENT"} and line.base_amount is not None:
                    sums["base"] += abs(float(line.base_amount))
                sums["tds"] += float(line.tds_amount or 0)
            dates = [line.posting_date for line in group_lines if line.posting_date]
            open_item = not bool(identity["clearing"])
            net = round(sums["net"], 2)
            anchor = str(identity["anchor"])
            linked = sum(1 for line in group_lines if line.doc_no != anchor)
            clearing_only = identity["group_type"] == "CLEARING" and linked == 0
            row = {
                "group_key": key,
                "company_code": first.company_code,
                "fiscal_year": identity["fiscal_year"][:10],
                "anchor_doc": str(identity["anchor"])[:100],
                "group_type": identity["group_type"],
                "open_item": open_item,
                "clearing_document": identity["clearing"],
                "assignment_number": first.assignment_number,
                "vendor_name": first.vendor_name or first.vendor_code,
                "vendor_code": first.vendor_code,
                "vendor_pan": first.vendor_pan,
                "section": first.section,
                "invoice_amount": round(sums["invoice"], 2),
                "advance_amount": round(sums["advance"], 2),
                "payment_amount": round(sums["payment"], 2),
                "base_amount": round(sums["base"], 2),
                "adjustment_amount": round(sums["adjustment"], 2),
                "debit_amount": round(sums["debit"], 2),
                "credit_amount": round(sums["credit"], 2),
                "net_amount": net,
                "open_amount": round(sums["invoice"] + sums["advance"] - sums["payment"] - sums["adjustment"], 2),
                "tds_amount": round(sums["tds"], 2),
                "event_count": len(group_lines),
                "linked_count": linked,
                "min_posting_date": min(dates) if dates else None,
                "max_posting_date": max(dates) if dates else None,
                # Issue count and status are set by _refresh_group_issues.
                "issue_count": 0,
                "status": _status(0, open_item, net, clearing_only),
            }
            if key in current:
                updates.append({**row, "id": current[key]})
            else:
                inserts.append(row)
        if inserts:
            db.bulk_insert_mappings(LedgerGroup, inserts)
        if updates:
            db.bulk_update_mappings(LedgerGroup, updates)
    db.flush()


def _refresh_group_issues(db: Session, companies: list[str]) -> None:
    """Issue count (distinct open issues on the group's documents) and status for every group."""
    if not companies:
        return
    issue_counts = dict(
        db.query(LedgerLine.group_key, func.count(func.distinct(TrackedIssue.id)))
        .join(TrackedIssue, and_(
            TrackedIssue.status == "open",
            TrackedIssue.company_code == LedgerLine.company_code,
            TrackedIssue.fiscal_year == LedgerLine.fiscal_year,
            TrackedIssue.doc_no == LedgerLine.doc_no,
        ))
        .filter(LedgerLine.company_code.in_(companies))
        .group_by(LedgerLine.group_key)
        .all()
    )
    changes = []
    groups = db.query(
        LedgerGroup.id, LedgerGroup.group_key, LedgerGroup.issue_count, LedgerGroup.status,
        LedgerGroup.open_item, LedgerGroup.net_amount, LedgerGroup.group_type, LedgerGroup.linked_count,
    ).filter(LedgerGroup.company_code.in_(companies))
    for group in groups:
        count = issue_counts.get(group.group_key, 0)
        clearing_only = group.group_type == "CLEARING" and not group.linked_count
        status = _status(count, group.open_item, float(group.net_amount or 0), clearing_only)
        if count != group.issue_count or status != group.status:
            changes.append({"id": group.id, "issue_count": count, "status": status})
    if changes:
        db.bulk_update_mappings(LedgerGroup, changes)


def refresh_issue_state(db: Session, companies: list[str]) -> None:
    """After issues change outside an upload (e.g. a manual resolve)."""
    _refresh_issue_flags(db, companies)
    _refresh_group_issues(db, companies)
    db.commit()


def financial_year_range(label: str | None) -> tuple[date, date] | None:
    """'FY 2025-26' -> (2025-04-01, 2026-03-31)."""
    text = str(label or "").replace("FY", "").strip()
    try:
        start_year = int(text.split("-")[0])
    except ValueError:
        return None
    return date(start_year, 4, 1), date(start_year + 1, 3, 31)
