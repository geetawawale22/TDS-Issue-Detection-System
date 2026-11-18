"""Manual correction register: SAP rows a user matched to resolve an issue.

A group belongs to one issue (company + fiscal year + document + line item)
and lists the SAP rows that correct it, each with a role:

    REVERSAL              takes TDS back (reverses the wrong deduction, or refunds excess)
    FRESH_DEDUCTION       deducts again after a full reversal
    ADDITIONAL_DEDUCTION  deducts only the missing difference

TDS amounts arrive unsigned (see sap_translator), so the role gives the sign.
Saving a group resolves the tracked issue (MANUAL); undoing or rejecting it
puts the tracked issue back the way it was before.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Iterable

from sqlalchemy import false, or_
from sqlalchemy.orm import Session, selectinload

from db.models import CorrectionEntry, CorrectionGroup, TrackedIssue, User
from services.issue_tracker import manual_resolve
from services.ledger_store import refresh_issue_state


METHODS = ("DIFFERENCE_ONLY", "FULL_REVERSAL")
ROLE_SIGN = {"REVERSAL": -1, "FRESH_DEDUCTION": 1, "ADDITIONAL_DEDUCTION": 1}
ACTIVE_STATUSES = ("matched_in_sap", "approved")
# A difference up to this many rupees counts as reconciled (rounding in SAP).
RECONCILE_TOLERANCE = 1.0
LIST_LIMIT = 5000

# Tracked-issue fields a manual resolve overwrites; saved so an undo can restore them.
_ISSUE_STATE_FIELDS = (
    "status", "resolution_type", "resolution_note", "correction_docs",
    "corrected_tds", "remaining_shortfall", "resolved_at", "resolved_by", "resolved_run_id",
)


class CorrectionError(Exception):
    """A request the register refuses; `status_code` is the HTTP status to answer with."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


# ── small helpers ────────────────────────────────────────────

def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _clean(value: Any) -> str:
    """Placeholder values from the upload ('—') count as empty."""
    text = _text(value)
    return "" if text in {"—", "-", "None", "null"} else text


def _number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _money(value: Any) -> float:
    return round(float(value or 0), 2)


def _date(value: Any) -> date | None:
    text = _text(value)[:10]
    if not text:
        return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def _datetime(value: Any) -> datetime | None:
    text = _text(value)
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _strip_zeros(value: str) -> str:
    return value.lstrip("0") or value


def expected_tds_for(base: float | None, expected_rate: float | None, applied_tds: float, tax_impact: float | None) -> float:
    """TDS the issue should have carried: base × expected rate, else applied + tax impact."""
    if base is not None and expected_rate is not None:
        return round(abs(base) * expected_rate / 100, 2)
    return round(applied_tds + abs(tax_impact or 0), 2)


def entry_effect(role: str, tds_amount: Any) -> float:
    """Signed change one SAP row makes to the TDS deducted on the issue."""
    return round(ROLE_SIGN.get(role, 0) * abs(float(tds_amount or 0)), 2)


def group_amounts(group: CorrectionGroup) -> dict[str, float]:
    """Real SAP effect of the group and how far it is from the expected TDS."""
    applied = _money(group.applied_tds)
    expected = _money(group.expected_tds)
    net = round(sum(entry_effect(entry.role, entry.tds_amount) for entry in group.entries), 2)
    corrected = round(applied + net, 2)
    return {
        "appliedTdsAmount": applied,
        "expectedTdsAmount": expected,
        "requiredCorrection": round(expected - applied, 2),
        "netAmount": net,
        "correctedTdsAmount": corrected,
        "unreconciledAmount": round(expected - corrected, 2),
    }


def is_reconciled(amounts: dict[str, float]) -> bool:
    return abs(amounts["unreconciledAmount"]) <= RECONCILE_TOLERANCE


def _same_key_part(group_value: str, issue_value: str) -> bool:
    """An empty part on either side (old data) does not block a match."""
    return not group_value or not issue_value or group_value == issue_value


# ── scope and lookups ────────────────────────────────────────

def scoped_groups(db: Session, user: User, company_codes: Iterable[str]):
    """Admins see every group; others see their company codes and groups they made."""
    query = db.query(CorrectionGroup).options(selectinload(CorrectionGroup.entries))
    if user.role == "admin":
        return query
    return query.filter(or_(
        CorrectionGroup.company_code.in_(list(company_codes)),
        CorrectionGroup.created_by == user.id,
    ))


def active_group_for_issue(db: Session, issue: dict[str, Any]) -> CorrectionGroup | None:
    """An active group already saved for this issue (same issue key, or same document line)."""
    key = _text(issue.get("issueKey"))
    doc_no = _clean(issue.get("docNo"))
    candidates = db.query(CorrectionGroup).filter(
        CorrectionGroup.status.in_(ACTIVE_STATUSES),
        or_(
            CorrectionGroup.issue_key == key if key else false(),
            CorrectionGroup.original_doc_no == doc_no,
        ),
    ).all()
    for group in candidates:
        if key and group.issue_key == key:
            return group
        if (
            _strip_zeros(group.original_doc_no) == _strip_zeros(doc_no)
            and _same_key_part(group.company_code, _clean(issue.get("companyCode")))
            and _same_key_part(group.fiscal_year, _clean(issue.get("fiscalYear")))
            and _same_key_part(group.original_line_item, _clean(issue.get("lineItem")))
            and (not key or not group.issue_key)
        ):
            return group
    return None


def _snapshot_issue(row: TrackedIssue) -> str:
    state: dict[str, Any] = {}
    for field in _ISSUE_STATE_FIELDS:
        value = getattr(row, field)
        if isinstance(value, Decimal):
            value = str(value)
        elif isinstance(value, datetime):
            value = value.isoformat()
        state[field] = value
    return json.dumps(state)


def _restore_issue(row: TrackedIssue, snapshot: str | None) -> None:
    try:
        state = json.loads(snapshot) if snapshot else None
    except ValueError:
        state = None
    if not state or state.get("status") == "resolved" and state.get("resolution_type") == "MANUAL":
        # Nothing usable saved: reopen plainly; the next run re-checks it.
        state = {"status": "open"}
    row.status = state.get("status") or "open"
    row.resolution_type = state.get("resolution_type")
    row.resolution_note = state.get("resolution_note")
    row.correction_docs = state.get("correction_docs")
    row.corrected_tds = state.get("corrected_tds")
    row.remaining_shortfall = state.get("remaining_shortfall")
    row.resolved_at = _datetime(state.get("resolved_at"))
    row.resolved_by = state.get("resolved_by")
    row.resolved_run_id = state.get("resolved_run_id")


# ── create ───────────────────────────────────────────────────

def create_group(
    db: Session,
    user: User,
    issue: dict[str, Any],
    method: str,
    remarks: str | None,
    entries: list[dict[str, Any]],
    tracked_issue: TrackedIssue | None,
) -> CorrectionGroup:
    """Save one matched group and resolve its tracked issue, in one commit."""
    method = _text(method).upper()
    if method not in METHODS:
        raise CorrectionError("Unknown correction method.")
    if not entries:
        raise CorrectionError("Select at least one SAP row.")
    doc_no = _clean(issue.get("docNo"))
    if not doc_no:
        raise CorrectionError("The issue has no document number.")
    for entry in entries:
        if _text(entry.get("role")).upper() not in ROLE_SIGN:
            raise CorrectionError(f"Choose a role for SAP row {_clean(entry.get('docNo')) or '?'}.")
        if not _clean(entry.get("docNo")):
            raise CorrectionError("Every selected SAP row needs a document number.")

    existing = active_group_for_issue(db, issue)
    if existing is not None:
        raise CorrectionError(
            f"This issue already has correction {existing.group_code}. Undo it first to match different rows.",
            status_code=409,
        )

    applied = round(abs(_number(issue.get("tdsAmount")) or 0), 2)
    base = _number(issue.get("baseAmount"))
    expected_rate = _number(issue.get("expectedRate"))
    group = CorrectionGroup(
        issue_key=_text(issue.get("issueKey")) or None,
        company_code=_clean(issue.get("companyCode")),
        fiscal_year=_clean(issue.get("fiscalYear")),
        original_doc_no=doc_no,
        original_line_item=_clean(issue.get("lineItem")),
        category=_text(issue.get("category"))[:150] or None,
        vendor_code=_clean(issue.get("vendorId")) or None,
        vendor_name=_clean(issue.get("vendor")) or None,
        vendor_pan=_clean(issue.get("vendorPan")) or None,
        section=_clean(issue.get("section")) or None,
        base_amount=base,
        applied_rate=_number(issue.get("appliedRate")),
        expected_rate=expected_rate,
        applied_tds=applied,
        expected_tds=expected_tds_for(base, expected_rate, applied, _number(issue.get("taxImpact"))),
        method=method,
        status="matched_in_sap",
        remarks=_text(remarks) or None,
        created_by=user.id,
    )
    for position, entry in enumerate(entries):
        group.entries.append(CorrectionEntry(
            position=position,
            role=_text(entry.get("role")).upper(),
            company_code=_clean(entry.get("companyCode")),
            fiscal_year=_clean(entry.get("fiscalYear")),
            doc_no=_clean(entry.get("docNo")),
            line_item=_clean(entry.get("lineItem")),
            doc_type=_clean(entry.get("docType"))[:10] or None,
            posting_date=_date(entry.get("postingDate") or entry.get("date")),
            vendor_code=_clean(entry.get("vendorId")) or None,
            vendor_name=_clean(entry.get("vendor")) or None,
            section=_clean(entry.get("section")) or None,
            base_amount=_number(entry.get("baseAmount")),
            applied_rate=_number(entry.get("appliedRate")),
            tds_amount=round(abs(_number(entry.get("tdsAmount")) or 0), 2),
        ))

    amounts = group_amounts(group)
    if not is_reconciled(amounts) and not group.remarks:
        raise CorrectionError(
            "The selected rows do not bring TDS to the expected amount "
            f"(difference ₹{amounts['unreconciledAmount']:,.2f}). Explain why in Remarks.",
            status_code=422,
        )

    db.add(group)
    db.flush()
    group.group_code = f"CG-{group.id:05d}"

    if tracked_issue is not None:
        if not group.company_code:
            group.company_code = tracked_issue.company_code or ""
        group.previous_issue_state = _snapshot_issue(tracked_issue)
        docs = [{
            "docNo": entry.doc_no,
            "docType": entry.doc_type,
            "postingDate": entry.posting_date.isoformat() if entry.posting_date else None,
            "tdsAmount": float(entry.tds_amount or 0),
            "tdsEffect": entry_effect(entry.role, entry.tds_amount),
            "role": entry.role,
            "link": "MANUAL",
        } for entry in group.entries]
        note = f"{group.group_code}: {group.remarks}" if group.remarks else f"Matched SAP rows ({group.group_code})."
        manual_resolve(db, tracked_issue.issue_key, user.id, note, docs)  # commits
        refresh_issue_state(db, [tracked_issue.company_code])
    else:
        db.commit()
    db.refresh(group)
    return group


# ── status changes ───────────────────────────────────────────

def _reopen_tracked_issue(db: Session, group: CorrectionGroup) -> bool:
    """Put the tracked issue back as it was, unless another active group still covers it."""
    if not group.issue_key:
        return False
    other = db.query(CorrectionGroup).filter(
        CorrectionGroup.issue_key == group.issue_key,
        CorrectionGroup.id != group.id,
        CorrectionGroup.status.in_(ACTIVE_STATUSES),
    ).first()
    if other is not None:
        return False
    row = db.query(TrackedIssue).filter(TrackedIssue.issue_key == group.issue_key).first()
    # Only a manual resolution belongs to this group; leave any other outcome alone.
    if row is None or row.status != "resolved" or row.resolution_type != "MANUAL":
        return False
    _restore_issue(row, group.previous_issue_state)
    return True


def _set_status(group: CorrectionGroup, user: User, status: str, note: str | None) -> None:
    group.status = status
    group.status_changed_by = user.id
    group.status_changed_at = datetime.now(timezone.utc)
    group.status_note = _text(note) or None


def undo_group(db: Session, user: User, group: CorrectionGroup, reason: str | None) -> bool:
    """Cancel a match (made by mistake). Returns True when the issue was reopened."""
    if group.status not in ACTIVE_STATUSES:
        raise CorrectionError("Only an active correction can be undone.", status_code=409)
    if user.role != "admin":
        if group.created_by != user.id:
            raise CorrectionError("Only the user who made this match, or an admin, can undo it.", status_code=403)
        if group.status == "approved":
            raise CorrectionError("This correction is approved; ask an admin to undo it.", status_code=403)
    if not _text(reason):
        raise CorrectionError("Give a reason for undoing the match.")
    _set_status(group, user, "undone", reason)
    reopened = _reopen_tracked_issue(db, group)
    db.commit()
    if reopened:
        refresh_issue_state(db, [group.company_code])
    db.refresh(group)
    return reopened


def review_group(db: Session, user: User, group: CorrectionGroup, approve: bool, note: str | None) -> bool:
    """Checker step: an admin other than the maker approves or rejects a match."""
    if user.role != "admin":
        raise CorrectionError("Only an admin can approve or reject corrections.", status_code=403)
    if group.created_by == user.id:
        raise CorrectionError("You made this match, so another admin must review it.", status_code=403)
    if group.status != "matched_in_sap":
        raise CorrectionError("Only a correction awaiting approval can be reviewed.", status_code=409)
    if approve:
        _set_status(group, user, "approved", note)
        db.commit()
        db.refresh(group)
        return False
    if not _text(note):
        raise CorrectionError("Give a reason for rejecting the correction.")
    _set_status(group, user, "rejected", note)
    reopened = _reopen_tracked_issue(db, group)
    db.commit()
    if reopened:
        refresh_issue_state(db, [group.company_code])
    db.refresh(group)
    return reopened


# ── one-time import of the old browser register ──────────────

def import_legacy_groups(db: Session, user: User, groups: list[dict[str, Any]]) -> dict[str, int]:
    """Save groups the old UI kept in the browser. Each runs once per user (legacy id)."""
    imported = skipped = 0
    for legacy in groups or []:
        legacy_id = _text(legacy.get("groupId"))[:30]
        entries = [entry for entry in legacy.get("entries") or [] if _clean(entry.get("correctionDocumentNumber") or entry.get("docNo"))]
        doc_no = _clean(legacy.get("originalDocumentNumber"))
        method = _text(legacy.get("method")).upper()
        if (
            not legacy_id or not entries or not doc_no or method not in METHODS
            or _text(legacy.get("status")) == "draft"
        ):
            skipped += 1
            continue
        if db.query(CorrectionGroup.id).filter(
            CorrectionGroup.legacy_group_id == legacy_id, CorrectionGroup.created_by == user.id,
        ).first():
            skipped += 1
            continue

        # The old register saved no issue key; link the issue it resolved by hand when that is unambiguous.
        linked = db.query(TrackedIssue).filter(
            TrackedIssue.doc_no == doc_no,
            TrackedIssue.status == "resolved",
            TrackedIssue.resolution_type == "MANUAL",
        ).all()
        tracked = linked[0] if len(linked) == 1 else None
        first = entries[0]
        if tracked is not None:
            applied = round(abs(float(tracked.tds_amount or 0)), 2)
            base = _number(tracked.base_amount)
            expected_rate = _number(tracked.expected_rate)
            expected = expected_tds_for(base, expected_rate, applied, _number(tracked.tax_impact))
        else:
            applied = round(abs(_number(legacy.get("appliedTdsAmount")) or 0), 2)
            base = None
            expected_rate = _number(first.get("expectedRate"))
            expected = round(abs(_number(legacy.get("expectedTdsAmount") or first.get("expectedTdsAmount")) or 0), 2)

        actor = legacy.get("matchedBy") or legacy.get("createdBy") or {}
        when = _text(legacy.get("createdAt"))[:10]
        group = CorrectionGroup(
            issue_key=tracked.issue_key if tracked else None,
            company_code=(tracked.company_code if tracked else "") or "",
            fiscal_year=(tracked.fiscal_year if tracked else "") or "",
            original_doc_no=doc_no,
            original_line_item=(tracked.line_item if tracked else "") or "",
            category=tracked.category if tracked else None,
            vendor_code=_clean(first.get("vendorId")) or None,
            vendor_name=_clean(first.get("vendor")) or None,
            vendor_pan=_clean(first.get("vendorPan")) or None,
            section=_clean(first.get("section")) or None,
            base_amount=base,
            applied_rate=_number(tracked.applied_rate) if tracked else None,
            expected_rate=expected_rate,
            applied_tds=applied,
            expected_tds=expected,
            method=method,
            status="matched_in_sap",
            remarks=_text(legacy.get("remarks")) or None,
            created_by=user.id,
            created_at=_datetime(legacy.get("createdAt")) or datetime.now(timezone.utc),
            status_note=(
                f"Imported from the browser register (made by {_text(actor.get('name')) or 'unknown user'}"
                f"{' on ' + when if when else ''})."
                + ("" if tracked else " Original issue amounts were not saved there.")
            ),
            legacy_group_id=legacy_id,
        )
        for position, entry in enumerate(entries):
            role = _text(entry.get("role")).upper()
            group.entries.append(CorrectionEntry(
                position=position,
                role=role if role in ROLE_SIGN else "ADDITIONAL_DEDUCTION",
                doc_no=_clean(entry.get("correctionDocumentNumber") or entry.get("docNo")),
                doc_type=_clean(entry.get("docType"))[:10] or None,
                posting_date=_date(entry.get("postingDate")),
                vendor_code=_clean(entry.get("vendorId")) or None,
                vendor_name=_clean(entry.get("vendor")) or None,
                section=_clean(entry.get("section")) or None,
                base_amount=_number(entry.get("baseAmount")),
                applied_rate=_number(entry.get("appliedRate")),
                tds_amount=round(abs(_number(entry.get("appliedTdsAmount") if entry.get("appliedTdsAmount") is not None else entry.get("amount")) or 0), 2),
            ))
        db.add(group)
        db.flush()
        group.group_code = f"CG-{group.id:05d}"
        imported += 1
    db.commit()
    return {"imported": imported, "skipped": skipped}


# ── output ───────────────────────────────────────────────────

def users_by_id(db: Session, groups: Iterable[CorrectionGroup]) -> dict[int, User]:
    ids = {uid for group in groups for uid in (group.created_by, group.status_changed_by) if uid}
    if not ids:
        return {}
    return {user.id: user for user in db.query(User).filter(User.id.in_(ids)).all()}


def _actor(user: User | None) -> dict[str, Any] | None:
    if user is None:
        return None
    return {"id": user.id, "name": user.full_name or user.email, "email": user.email, "role": user.role}


def allowed_actions(group: CorrectionGroup, viewer: User | None) -> dict[str, bool]:
    """What this viewer may do with the group (same rules undo_group / review_group enforce)."""
    if viewer is None:
        return {"canUndo": False, "canReview": False}
    active = group.status in ACTIVE_STATUSES
    is_admin = viewer.role == "admin"
    is_maker = group.created_by == viewer.id
    return {
        "canUndo": active and (is_admin or (is_maker and group.status != "approved")),
        "canReview": is_admin and not is_maker and group.status == "matched_in_sap",
    }


def group_to_dict(group: CorrectionGroup, users: dict[int, User], viewer: User | None = None) -> dict[str, Any]:
    amounts = group_amounts(group)
    creator = _actor(users.get(group.created_by))
    changer = _actor(users.get(group.status_changed_by))
    entries = []
    for entry in group.entries:
        effect = entry_effect(entry.role, entry.tds_amount)
        entries.append({
            "id": entry.id,
            "role": entry.role,
            "correctionDocumentNumber": entry.doc_no,
            "docNo": entry.doc_no,
            "companyCode": entry.company_code or None,
            "fiscalYear": entry.fiscal_year or None,
            "lineItem": entry.line_item or None,
            "docType": entry.doc_type,
            "postingDate": entry.posting_date.isoformat() if entry.posting_date else None,
            "vendor": entry.vendor_name,
            "vendorId": entry.vendor_code,
            "section": entry.section,
            "baseAmount": _number(entry.base_amount),
            "appliedRate": _number(entry.applied_rate),
            "tdsAmount": _money(entry.tds_amount),
            "amount": effect,
            "originalDocumentNumber": group.original_doc_no,
        })
    return {
        "id": group.id,
        "groupId": group.group_code,
        "issueKey": group.issue_key,
        "companyCode": group.company_code or None,
        "fiscalYear": group.fiscal_year or None,
        "originalDocumentNumber": group.original_doc_no,
        "originalLineItem": group.original_line_item or None,
        "category": group.category,
        "vendor": group.vendor_name or group.vendor_code or "Unknown vendor",
        "vendorId": group.vendor_code,
        "vendorPan": group.vendor_pan,
        "section": group.section,
        "baseAmount": _number(group.base_amount),
        "appliedRate": _number(group.applied_rate),
        "expectedRate": _number(group.expected_rate),
        **amounts,
        "reconciled": is_reconciled(amounts),
        "method": group.method,
        "status": group.status,
        "isActive": group.status in ACTIVE_STATUSES,
        "remarks": group.remarks,
        "createdBy": creator,
        "createdAt": group.created_at.isoformat() if group.created_at else None,
        "statusChangedBy": changer,
        "statusChangedAt": group.status_changed_at.isoformat() if group.status_changed_at else None,
        "statusNote": group.status_note,
        "imported": bool(group.legacy_group_id),
        **allowed_actions(group, viewer),
        "entries": entries,
    }
