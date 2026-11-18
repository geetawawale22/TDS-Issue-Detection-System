"""Issue history across rule-engine runs.

The rule engine itself is stateless: it checks whatever transactions it is
given. This module gives it a memory. After every run (a file upload today,
a daily SAP/API pull later) the issues are saved in ``tracked_issues`` under
a stable key, and earlier issues are re-evaluated against the new data:

* still flagged                     -> recurring (stays open)
* flagged again after auto-resolve  -> reopened
* original document reversed        -> resolved, REVERSED
  (STBLG link in either direction: X says "reversed by Y" or Y says "reverses X")
* later document(s) referencing it  -> each line is read by what it does:
  (REBZG / Reference_Document_Number)  - TDS-only line: TDS topped up (or refunded)
                                       - opposite side to the original (credit memo,
                                         reversal): cancels that much base and TDS
                                       - same side (supplementary invoice): adds both
                                       fully cancelled -> resolved, REVERSED;
                                       TDS on the base left within the tolerance ->
                                       resolved, CORRECTION_POSTED; else partially corrected
* document re-checked, not flagged  -> resolved, NO_LONGER_FLAGGED
* document not in this run          -> carried forward, stays open

A manual resolution (Match SAP Rows) is never reopened by a later run.
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from datetime import date, datetime, timezone
from typing import Any, Iterable

from sqlalchemy import update
from sqlalchemy.orm import Session

from db.models import RuleRun, TrackedIssue
from rules.tds_rule_engine import _get_financial_year

# Rupee difference within which a correction counts as complete.
AMOUNT_TOLERANCE = 1.0
_CHUNK = 1000
# Payments, clearings and transfer postings reference other documents to
# settle or move them; they do not correct TDS.
_NOT_CORRECTION_DOC_TYPES = {"KZ", "AB", "TP", "TM"}


def references_other_document(txn) -> bool:
    """True for a correction line (credit memo, reversal, TDS top-up): it points
    (REBZG) at another document and is not a payment / clearing / transfer.

    Such a line is checked through the document it corrects, not on its own.
    """
    reference = str(txn.invoice_reference_document or "").strip()
    doc_no = str(txn.doc_number or "").strip()
    return bool(
        reference and doc_no and reference != doc_no
        and str(txn.doc_type or "").strip().upper() not in _NOT_CORRECTION_DOC_TYPES
    )


def _side(debit_credit: Any, amount: Any) -> str | None:
    """'S' (debit) or 'H' (credit); falls back to the amount's sign."""
    value = str(debit_credit or "").strip().upper()
    if value in {"S", "H"}:
        return value
    number = _num(amount)
    if number:
        return "S" if number > 0 else "H"
    return None


def fiscal_year_for(txn) -> str:
    year = str(txn.fiscal_year or "").strip()
    if year:
        return year
    return _get_financial_year(txn.posting_date) if txn.posting_date else ""


def doc_identity(txn) -> tuple[str, str, str, str]:
    return (
        str(txn.company_code or "").strip(),
        fiscal_year_for(txn),
        str(txn.doc_number or "").strip(),
        str(txn.line_item_number or "").strip(),
    )


def build_issue_key(txn, category: str) -> str:
    """Stable id for one issue on one SAP line, the same in every run."""
    parts = [
        *doc_identity(txn),
        str(txn.withholding_tax_type or "").strip(),
        str(txn.withholding_tax_code or "").strip(),
        str(category or "").strip(),
    ]
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()


def _chunks(values: list, size: int = _CHUNK) -> Iterable[list]:
    for start in range(0, len(values), size):
        yield values[start:start + size]


def _num(value: Any) -> float | None:
    if value is None or value == "" or value == "—":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_date(value: Any) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _link_doc(txn, link: str) -> dict[str, Any]:
    return {
        "docNo": str(txn.doc_number or ""),
        "lineItem": txn.line_item_number,
        "docType": txn.doc_type,
        "postingDate": txn.posting_date.isoformat() if txn.posting_date else None,
        "tdsAmount": round(abs(float(txn.tds_deducted_amount or 0.0)), 2),
        "amount": round(abs(float(txn.bill_amount or 0.0)), 2),
        "link": link,
    }


class _CorrectionIndex:
    """Links between documents found in one run's transactions."""

    def __init__(self, transactions) -> None:
        self.present: set[tuple[str, str, str, str]] = set()
        # (company, doc) -> partner documents of a reversal pair
        self.reversals: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        # (company, doc) -> later lines that reference it through REBZG
        self.references: dict[tuple[str, str], list[Any]] = defaultdict(list)

        for txn in transactions:
            company, _, doc_no, _ = identity = doc_identity(txn)
            self.present.add(identity)
            partner = str(txn.reversal_document or "").strip()
            if partner and doc_no and partner != doc_no:
                # Both directions: this row may be the reversed document or the reversal.
                self.reversals[(company, doc_no)].append({
                    "docNo": partner, "docType": None, "postingDate": None,
                    "tdsAmount": None, "link": "REVERSED_BY",
                })
                self.reversals[(company, partner)].append(_link_doc(txn, "REVERSAL"))
            if references_other_document(txn):
                reference = str(txn.invoice_reference_document).strip()
                self.references[(company, reference)].append(txn)

    def evaluate(self, entry: dict[str, Any], flagged_now: bool, include_informational: bool) -> dict[str, Any] | None:
        """Resolution fields for one open issue, or None when it stays open as-is."""
        company, doc_no = entry["company_code"], entry["doc_no"]

        partners = self.reversals.get((company, doc_no))
        if partners:
            docs = _dedupe_docs(partners)
            return {
                "status": "resolved",
                "resolution_type": "REVERSED",
                "resolution_note": "Original document reversed by " + ", ".join(d["docNo"] for d in docs),
                "correction_docs": docs,
                "corrected_tds": None,
                "remaining_shortfall": None,
            }

        linked = [
            txn for txn in self.references.get((company, doc_no), [])
            if _same_fiscal_year(txn, entry.get("fiscal_year"))
        ]
        tax_impact = _num(entry.get("tax_impact")) or 0.0
        base = _num(entry.get("base_amount"))
        rate = _num(entry.get("expected_rate"))
        # Some rules (e.g. PAN missing -> 20%) save no tax impact, so the gap
        # between expected and deducted TDS also counts.
        gap = (
            abs(abs(base) * rate / 100 - abs(_num(entry.get("tds_amount")) or 0.0))
            if base is not None and rate is not None else 0.0
        )
        # Corrections found in earlier runs still count: SAP keeps them even
        # when today's file does not carry them again.
        earlier = _saved_effects(entry.get("correction_docs"))
        if (linked or earlier) and (tax_impact > 0 or gap > AMOUNT_TOLERANCE) and base is not None and rate is not None:
            outcome = _apply_corrections(entry, linked, earlier, abs(base), rate)
            if outcome is not None:
                return outcome

        identity = (company, entry["fiscal_year"], doc_no, entry["line_item"])
        low_hidden = entry.get("severity") == "low" and not include_informational
        if not flagged_now and identity in self.present and not low_hidden:
            return {
                "status": "resolved",
                "resolution_type": "NO_LONGER_FLAGGED",
                "resolution_note": "Document re-checked in a later run and the rule no longer raises this issue.",
                "correction_docs": None,
                "corrected_tds": None,
                "remaining_shortfall": None,
            }
        return None


def _dedupe_docs(docs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_doc: dict[str, dict[str, Any]] = {}
    for doc in docs:
        current = by_doc.get(doc["docNo"])
        # Prefer the entry that carries the reversal row's own details.
        if current is None or (current.get("postingDate") is None and doc.get("postingDate")):
            by_doc[doc["docNo"]] = doc
    return list(by_doc.values())


def _year(value: Any) -> str:
    """'2026', '2026.0' -> '2026'; blank or 0 -> ''."""
    number = _num(value)
    return str(int(number)) if number else ""


def _same_fiscal_year(txn, fiscal_year: Any) -> bool:
    """A reference fiscal year (REBZJ), when given, must match the issue's."""
    reference_year = _year(txn.invoice_reference_fiscal_year)
    issue_year = _year(fiscal_year)
    return not reference_year or not issue_year or reference_year == issue_year


def _saved_effects(saved: Any) -> dict[str, dict[str, Any]]:
    """Correction docs saved on an issue that carry their effect, by doc number."""
    if not saved:
        return {}
    try:
        docs = json.loads(saved) if isinstance(saved, str) else saved
    except (TypeError, ValueError):
        return {}
    return {
        str(doc["docNo"]): doc for doc in docs or []
        if isinstance(doc, dict) and doc.get("docNo") and "tdsEffect" in doc
    }


def _correction_effect(txn, base: float, short: bool, original_amount: float, original_side: str | None) -> dict[str, Any] | None:
    """What one referencing line does to the original's base and TDS.

    * TDS-only line (amount no bigger than its TDS): TDS topped up, or refunded
      for an excess deduction.
    * Opposite side to the original (credit memo, reversal): cancels its base
      and the TDS on it. With no base on the line, the base cancelled is in
      proportion to its amount against the original document's amount.
    * Same side (supplementary invoice): adds its base and TDS.
    """
    tds = abs(float(txn.tds_deducted_amount or 0.0))
    amount = abs(float(txn.bill_amount or 0.0))
    line_base = abs(float(txn.basic_amount or 0.0))
    side = _side(txn.debit_credit, txn.bill_amount)
    if tds > 0 and (amount <= tds + AMOUNT_TOLERANCE or side is None):
        return {**_link_doc(txn, "TDS_CORRECTION"), "baseEffect": 0.0, "tdsEffect": tds if short else -tds}
    if side is None or original_side is None:
        return None
    if line_base <= 0:
        if not original_amount:
            return None  # nothing to measure the line against
        line_base = base * amount / original_amount
    if side != original_side:
        return {**_link_doc(txn, "CANCELLATION"), "baseEffect": -round(line_base, 2), "tdsEffect": -tds}
    return {**_link_doc(txn, "SUPPLEMENTARY"), "baseEffect": round(line_base, 2), "tdsEffect": tds}


def _apply_corrections(
    entry: dict[str, Any],
    linked: list[Any],
    earlier: dict[str, dict[str, Any]],
    base: float,
    rate: float,
) -> dict[str, Any] | None:
    """Net effect of every line found so far that references an issue's document.

    Lines in this run are added to (or replace, by doc number) the ones saved
    from earlier runs, so a part top-up today and the rest tomorrow add up.
    TDS expected on the base that is left is then compared with TDS held.
    """
    original_tds = abs(_num(entry.get("tds_amount")) or 0.0)
    original_amount = abs(_num(entry.get("document_amount")) or 0.0)
    original_side = _side(entry.get("debit_credit"), entry.get("document_amount"))
    short = base * rate / 100 >= original_tds

    effects = dict(earlier)
    for txn in linked:
        effect = _correction_effect(txn, base, short, original_amount, original_side)
        if effect is not None:
            effects[effect["docNo"]] = effect
    if not effects:
        return None

    docs = list(effects.values())
    net_base = max(base + sum(float(d["baseEffect"]) for d in docs), 0.0)
    net_tds = original_tds + sum(float(d["tdsEffect"]) for d in docs)
    remaining = round(net_base * rate / 100 - net_tds, 2)
    doc_list = ", ".join(d["docNo"] for d in docs)
    if abs(remaining) <= AMOUNT_TOLERANCE and net_base <= AMOUNT_TOLERANCE:
        return {
            "status": "resolved",
            "resolution_type": "REVERSED",
            "resolution_note": f"Document cancelled by {doc_list}; no TDS is due on it now.",
            "correction_docs": docs,
            "corrected_tds": round(net_tds, 2),
            "remaining_shortfall": 0.0,
        }
    if abs(remaining) <= AMOUNT_TOLERANCE:
        return {
            "status": "resolved",
            "resolution_type": "CORRECTION_POSTED",
            "resolution_note": f"Correction posted in {doc_list}; TDS now matches the expected amount.",
            "correction_docs": docs,
            "corrected_tds": round(net_tds, 2),
            "remaining_shortfall": 0.0,
        }
    return {
        "status": "open",
        "resolution_type": None,
        "resolution_note": f"Partially corrected by {doc_list}; {abs(remaining):,.2f} still {'short' if remaining > 0 else 'excess'}.",
        "correction_docs": docs,
        "corrected_tds": round(net_tds, 2),
        "remaining_shortfall": remaining,
    }


_STICKY_RESOLUTIONS = {"REVERSED", "CORRECTION_POSTED"}


def _keeps_earlier_resolution(previous: dict[str, Any]) -> bool:
    """Resolved by a reversal/correction, or partly corrected: kept when flagged again."""
    if previous["status"] == "resolved":
        return previous["resolution_type"] in _STICKY_RESOLUTIONS
    return previous.get("remaining_shortfall") is not None


def _same_outcome(previous: dict[str, Any], result: dict[str, Any] | None) -> bool:
    if not result:
        return False
    return (
        result["status"] == previous["status"]
        and result["resolution_type"] == previous["resolution_type"]
        and round(_num(result.get("remaining_shortfall")) or 0.0, 2)
        == round(_num(previous.get("remaining_shortfall")) or 0.0, 2)
    )


def _earlier_result(previous: dict[str, Any]) -> dict[str, Any]:
    docs = previous.get("correction_docs")
    try:
        docs = json.loads(docs) if isinstance(docs, str) else docs
    except (TypeError, ValueError):
        docs = None
    return {
        "status": previous["status"],
        "resolution_type": previous["resolution_type"],
        "resolution_note": previous["resolution_note"],
        "correction_docs": docs,
        "corrected_tds": _num(previous.get("corrected_tds")),
        "remaining_shortfall": _num(previous.get("remaining_shortfall")),
    }


def _entry_from_issue(issue: dict[str, Any], txn) -> dict[str, Any]:
    company, fiscal_year, doc_no, line_item = doc_identity(txn)
    return {
        "issue_key": issue["issueKey"],
        "company_code": company[:10],
        "fiscal_year": fiscal_year[:10],
        "doc_no": doc_no[:50],
        "line_item": line_item[:20],
        "doc_type": (str(txn.doc_type or "")[:10] or None),
        "category": str(issue.get("category") or "")[:150],
        "issue_type": (str(issue.get("issueType") or "")[:60] or None),
        "severity": (str(issue.get("severity") or "")[:10] or None),
        "vendor_code": (str(txn.vendor_code or "")[:50] or None),
        "vendor_name": (str(txn.vendor_name or "")[:255] or None),
        "vendor_pan": (str(txn.vendor_pan or "")[:20] or None),
        "section": (str(issue.get("section") or "")[:50] or None),
        "posting_date": txn.posting_date,
        "base_amount": _num(issue.get("baseAmount")),
        "tds_amount": _num(issue.get("tdsAmount")),
        "applied_rate": _num(issue.get("appliedRate")),
        "expected_rate": _num(issue.get("expectedRate")),
        "tax_impact": _num(issue.get("taxImpact")),
        "document_amount": _num(txn.bill_amount),
        "debit_credit": _side(txn.debit_credit, txn.bill_amount),
        "profit_center": (str(txn.profit_center or "")[:50] or None),
        "description": issue.get("description"),
    }


_EVAL_COLUMNS = (
    TrackedIssue.id, TrackedIssue.issue_key, TrackedIssue.status, TrackedIssue.resolution_type,
    TrackedIssue.resolution_note, TrackedIssue.company_code, TrackedIssue.fiscal_year,
    TrackedIssue.doc_no, TrackedIssue.line_item, TrackedIssue.severity, TrackedIssue.base_amount,
    TrackedIssue.tds_amount, TrackedIssue.expected_rate, TrackedIssue.tax_impact,
    TrackedIssue.first_seen_at, TrackedIssue.remaining_shortfall,
    TrackedIssue.document_amount, TrackedIssue.debit_credit,
    TrackedIssue.correction_docs, TrackedIssue.corrected_tds,
)


def _row_dict(row) -> dict[str, Any]:
    return dict(row._mapping)


def track_rule_run(
    db: Session,
    *,
    issues: list[dict[str, Any]],
    issue_txns: list[Any],
    transactions: list[Any],
    user_id: int | None,
    source: str,
    file_name: str | None,
    include_informational: bool,
) -> dict[str, Any]:
    """Save this run's issues, re-evaluate earlier ones, annotate ``issues`` in place.

    ``issue_txns[i]`` is the transaction behind ``issues[i]``.
    """
    now = datetime.now(timezone.utc)
    index = _CorrectionIndex(transactions)
    company_codes = sorted({doc_identity(txn)[0] for txn in transactions})
    posting_dates = [txn.posting_date for txn in transactions if txn.posting_date]

    run = RuleRun(
        source=source,
        file_name=file_name,
        company_codes=",".join(code or "—" for code in company_codes)[:255],
        period_from=min(posting_dates) if posting_dates else None,
        period_to=max(posting_dates) if posting_dates else None,
        transactions=len(transactions),
        issues_found=len(issues),
        run_by=user_id,
    )
    db.add(run)
    db.flush()

    # Current issues by key; one SAP line can raise the same issue only once.
    current: dict[str, dict[str, Any]] = {}
    issues_by_key: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for issue, txn in zip(issues, issue_txns):
        key = issue["issueKey"]
        issues_by_key[key].append(issue)
        if key not in current:
            current[key] = _entry_from_issue(issue, txn)

    existing: dict[str, dict[str, Any]] = {}
    keys = list(current)
    for chunk in _chunks(keys):
        for row in db.query(*_EVAL_COLUMNS).filter(TrackedIssue.issue_key.in_(chunk)):
            existing[row.issue_key] = _row_dict(row)
    carried: dict[str, dict[str, Any]] = {}
    for chunk in _chunks(company_codes):
        open_rows = db.query(*_EVAL_COLUMNS).filter(
            TrackedIssue.status == "open",
            TrackedIssue.company_code.in_(chunk),
        )
        for row in open_rows:
            if row.issue_key not in current:
                carried[row.issue_key] = _row_dict(row)

    new_rows: list[dict[str, Any]] = []
    updates: list[dict[str, Any]] = []
    counts = defaultdict(int)
    resolved_by_type: dict[str, int] = defaultdict(int)
    annotations: dict[str, dict[str, Any]] = {}

    def resolution_fields(result: dict[str, Any]) -> dict[str, Any]:
        resolved = result["status"] == "resolved"
        return {
            "status": result["status"],
            "resolution_type": result["resolution_type"],
            "resolution_note": result["resolution_note"],
            "correction_docs": json.dumps(result["correction_docs"]) if result["correction_docs"] else None,
            "corrected_tds": result["corrected_tds"],
            "remaining_shortfall": result["remaining_shortfall"],
            "resolved_at": now if resolved else None,
            "resolved_run_id": run.id if resolved else None,
        }

    def note_result(key: str, result: dict[str, Any] | None, tracking_status: str, first_seen, count: bool = True) -> None:
        annotation = {
            "trackingStatus": tracking_status,
            "firstSeenAt": (first_seen or now).isoformat(),
        }
        if result:
            annotation.update({
                "resolutionType": result["resolution_type"],
                "resolutionNote": result["resolution_note"],
                "correctionDocs": result["correction_docs"],
                "remainingShortfall": result["remaining_shortfall"],
            })
            if result["status"] == "resolved":
                annotation["status"] = "resolved"
                if count:
                    resolved_by_type[result["resolution_type"]] += 1
                    counts["resolved"] += 1
            elif result.get("correction_docs") and count:
                counts["partial"] += 1
        annotations[key] = annotation

    for key, entry in current.items():
        previous = existing.get(key)
        if previous is None:
            result = index.evaluate(entry, True, include_informational)
            row = {
                **entry,
                "status": "open",
                "times_seen": 1,
                "reopened_count": 0,
                "first_seen_run_id": run.id,
                "last_seen_run_id": run.id,
                "first_seen_at": now,
                "last_seen_at": now,
            }
            if result:
                row.update(resolution_fields(result))
            new_rows.append(row)
            counts["new"] += 1
            note_result(key, result, "new", now)
            continue

        counts["recurring"] += 1
        if previous["status"] == "resolved" and previous["resolution_type"] == "MANUAL":
            annotations[key] = {
                "trackingStatus": "recurring",
                "firstSeenAt": previous["first_seen_at"].isoformat() if previous["first_seen_at"] else None,
                "status": "resolved",
                "resolutionType": "MANUAL",
                "resolutionNote": previous["resolution_note"],
            }
            continue

        result = index.evaluate({**previous, **entry}, True, include_informational)
        was_resolved = previous["status"] == "resolved"
        # Same outcome as the earlier run (e.g. worked out from saved corrections): nothing new to record.
        unchanged = _same_outcome(previous, result)
        if result:
            if not unchanged:
                updates.append({"id": previous["id"], **resolution_fields(result)})
            tracking_status = "reopened" if was_resolved and result["status"] != "resolved" else "recurring"
        elif _keeps_earlier_resolution(previous):
            # The original document always raises the issue again when a file
            # carries it; the correction lives in another document, which SAP
            # keeps even if this file does not include it. Nothing changes.
            note_result(key, _earlier_result(previous), "recurring", previous["first_seen_at"], count=False)
            continue
        elif was_resolved:
            # Resolved only because it stopped being flagged, and flagged again: reopen.
            updates.append({
                "id": previous["id"], "status": "open", "resolution_type": None,
                "resolution_note": None, "correction_docs": None, "corrected_tds": None,
                "remaining_shortfall": None, "resolved_at": None, "resolved_run_id": None,
            })
            tracking_status = "reopened" if was_resolved else "recurring"
        else:
            tracking_status = "recurring"
        if tracking_status == "reopened":
            counts["reopened"] += 1
        note_result(key, result, tracking_status, previous["first_seen_at"], count=not unchanged)

    carried_open = 0
    for key, previous in carried.items():
        result = index.evaluate(previous, False, include_informational)
        if not result or result["status"] != "resolved":
            carried_open += 1
        if result and not _same_outcome(previous, result):
            updates.append({"id": previous["id"], **resolution_fields(result)})
            if result["status"] == "resolved":
                counts["resolved"] += 1
                resolved_by_type[result["resolution_type"]] += 1
            elif result.get("correction_docs"):
                counts["partial"] += 1

    if new_rows:
        db.bulk_insert_mappings(TrackedIssue, new_rows)
    seen_ids = [existing[key]["id"] for key in current if key in existing]
    for chunk in _chunks(seen_ids):
        db.execute(
            update(TrackedIssue)
            .where(TrackedIssue.id.in_(chunk))
            .values(
                last_seen_run_id=run.id,
                last_seen_at=now,
                times_seen=TrackedIssue.times_seen + 1,
            )
            .execution_options(synchronize_session=False)
        )
    reopened_ids = [
        existing[key]["id"] for key, note in annotations.items()
        if note.get("trackingStatus") == "reopened" and key in existing
    ]
    for chunk in _chunks(reopened_ids):
        db.execute(
            update(TrackedIssue)
            .where(TrackedIssue.id.in_(chunk))
            .values(reopened_count=TrackedIssue.reopened_count + 1)
            .execution_options(synchronize_session=False)
        )
    if updates:
        db.bulk_update_mappings(TrackedIssue, updates)
    # Details added after an issue was first saved (e.g. profit center) are
    # filled in whenever a later file raises it again.
    detail_updates = [
        {"id": existing[key]["id"], "profit_center": entry["profit_center"]}
        for key, entry in current.items()
        if key in existing and entry.get("profit_center")
    ]
    if detail_updates:
        db.bulk_update_mappings(TrackedIssue, detail_updates)

    run.new_issues = counts["new"]
    run.recurring_issues = counts["recurring"]
    run.reopened_issues = counts["reopened"]
    run.resolved_issues = counts["resolved"]
    run.partially_corrected = counts["partial"]
    db.commit()

    for key, note in annotations.items():
        for issue in issues_by_key[key]:
            issue.update(note)

    open_total = 0
    for chunk in _chunks(company_codes):
        open_total += db.query(TrackedIssue).filter(
            TrackedIssue.status == "open",
            TrackedIssue.company_code.in_(chunk),
        ).count()

    return {
        "runId": run.id,
        "newIssues": counts["new"],
        "recurringIssues": counts["recurring"],
        "reopenedIssues": counts["reopened"],
        "resolvedIssues": counts["resolved"],
        "resolvedByType": {k: v for k, v in resolved_by_type.items() if v > 0},
        "partiallyCorrected": counts["partial"],
        "carriedForwardOpen": carried_open,
        "totalOpen": open_total,
    }


def manual_resolve(db: Session, issue_key: str, user_id: int | None, note: str | None, docs: list[dict[str, Any]] | None) -> TrackedIssue | None:
    row = db.query(TrackedIssue).filter(TrackedIssue.issue_key == issue_key).first()
    if row is None:
        return None
    row.status = "resolved"
    row.resolution_type = "MANUAL"
    row.resolution_note = (note or "").strip() or "Resolved manually from Match SAP Rows."
    row.correction_docs = json.dumps(docs) if docs else row.correction_docs
    row.resolved_at = datetime.now(timezone.utc)
    row.resolved_by = user_id
    row.remaining_shortfall = None
    db.commit()
    return row


def tracked_issue_to_dict(row: TrackedIssue) -> dict[str, Any]:
    def as_float(value):
        return float(value) if value is not None else None

    try:
        docs = json.loads(row.correction_docs) if row.correction_docs else []
    except ValueError:
        docs = []
    return {
        "id": row.id,
        "issueKey": row.issue_key,
        "companyCode": row.company_code or None,
        "fiscalYear": row.fiscal_year or None,
        "docNo": row.doc_no,
        "lineItem": row.line_item or None,
        "docType": row.doc_type,
        "profitCenter": row.profit_center,
        "documentAmount": as_float(row.document_amount),
        "debitCredit": row.debit_credit,
        "category": row.category,
        "issueType": row.issue_type,
        "severity": row.severity,
        "vendor": row.vendor_name or row.vendor_code or "Unknown vendor",
        "vendorId": row.vendor_code,
        "vendorPan": row.vendor_pan,
        "section": row.section,
        "postingDate": row.posting_date.isoformat() if row.posting_date else None,
        "baseAmount": as_float(row.base_amount),
        "tdsAmount": as_float(row.tds_amount),
        "appliedRate": as_float(row.applied_rate),
        "expectedRate": as_float(row.expected_rate),
        "taxImpact": as_float(row.tax_impact),
        "description": row.description,
        "status": row.status,
        "resolutionType": row.resolution_type,
        "resolutionNote": row.resolution_note,
        "correctionDocs": docs,
        "correctedTds": as_float(row.corrected_tds),
        "remainingShortfall": as_float(row.remaining_shortfall),
        "resolvedAt": row.resolved_at.isoformat() if row.resolved_at else None,
        "firstSeenAt": row.first_seen_at.isoformat() if row.first_seen_at else None,
        "lastSeenAt": row.last_seen_at.isoformat() if row.last_seen_at else None,
        "timesSeen": row.times_seen,
        "reopenedCount": row.reopened_count,
    }
