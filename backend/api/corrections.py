"""Manual correction register (Match SAP Rows), kept in the database."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from core.dependencies import get_current_user, get_user_company_codes
from db.database import get_db
from db.models import CorrectionGroup, TrackedIssue, User
from services.correction_register import (
    LIST_LIMIT,
    CorrectionError,
    create_group,
    group_to_dict,
    import_legacy_groups,
    review_group,
    scoped_groups,
    undo_group,
    users_by_id,
)


router = APIRouter(prefix="/corrections", tags=["Correction Register"])


class CorrectionIssue(BaseModel):
    issueKey: str | None = None
    companyCode: str | None = None
    fiscalYear: str | None = None
    docNo: str
    lineItem: str | None = None
    category: str | None = None
    vendor: str | None = None
    vendorId: str | None = None
    vendorPan: str | None = None
    section: str | None = None
    baseAmount: float | None = None
    appliedRate: float | None = None
    expectedRate: float | None = None
    tdsAmount: float | None = None
    taxImpact: float | None = None


class CorrectionRow(BaseModel):
    role: str
    docNo: str
    companyCode: str | None = None
    fiscalYear: str | None = None
    lineItem: str | None = None
    docType: str | None = None
    postingDate: str | None = None
    vendor: str | None = None
    vendorId: str | None = None
    section: str | None = None
    baseAmount: float | None = None
    appliedRate: float | None = None
    tdsAmount: float | None = None


class CreateCorrectionRequest(BaseModel):
    issue: CorrectionIssue
    method: Literal["DIFFERENCE_ONLY", "FULL_REVERSAL"]
    remarks: str | None = None
    entries: list[CorrectionRow] = Field(min_length=1, max_length=200)


class StatusNoteRequest(BaseModel):
    note: str | None = None


class ImportLegacyRequest(BaseModel):
    groups: list[dict[str, Any]] = Field(default_factory=list, max_length=2000)


def _fail(error: CorrectionError):
    raise HTTPException(status_code=error.status_code, detail=str(error))


def _group_or_404(db: Session, user: User, group_id: int) -> CorrectionGroup:
    group = scoped_groups(db, user, get_user_company_codes(user, db)).filter(CorrectionGroup.id == group_id).first()
    if group is None:
        raise HTTPException(status_code=404, detail="Correction not found.")
    return group


def _response(db: Session, group: CorrectionGroup, viewer: User, **extra) -> dict[str, Any]:
    return {**group_to_dict(group, users_by_id(db, [group]), viewer), **extra}


@router.get("")
def list_corrections(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Every correction group the user may see, newest first (filters run in the page)."""
    rows = (
        scoped_groups(db, current_user, get_user_company_codes(current_user, db))
        .order_by(CorrectionGroup.created_at.desc(), CorrectionGroup.id.desc())
        .limit(LIST_LIMIT + 1)
        .all()
    )
    shown = rows[:LIST_LIMIT]
    users = users_by_id(db, shown)
    return {"items": [group_to_dict(group, users, current_user) for group in shown], "truncated": len(rows) > LIST_LIMIT}


@router.post("", status_code=status.HTTP_201_CREATED)
def create_correction(
    body: CreateCorrectionRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Save matched SAP rows as a correction group and resolve the issue in the issue history."""
    codes = get_user_company_codes(current_user, db)
    company = (body.issue.companyCode or "").strip()
    if current_user.role != "admin" and company and company not in codes:
        raise HTTPException(status_code=403, detail="You do not have access to this company code.")
    tracked = None
    if body.issue.issueKey:
        tracked = db.query(TrackedIssue).filter(TrackedIssue.issue_key == body.issue.issueKey).first()
        if tracked is not None and current_user.role != "admin" and tracked.company_code not in codes:
            raise HTTPException(status_code=403, detail="You do not have access to this company code.")
    try:
        group = create_group(
            db, current_user,
            issue=body.issue.model_dump(),
            method=body.method,
            remarks=body.remarks,
            entries=[row.model_dump() for row in body.entries],
            tracked_issue=tracked,
        )
    except CorrectionError as error:
        db.rollback()
        _fail(error)
    return _response(db, group, current_user, issueTracked=tracked is not None)


@router.post("/{group_id}/undo")
def undo_correction(
    group_id: int,
    body: StatusNoteRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Cancel a match made by mistake; the issue opens again."""
    group = _group_or_404(db, current_user, group_id)
    try:
        reopened = undo_group(db, current_user, group, body.note)
    except CorrectionError as error:
        db.rollback()
        _fail(error)
    return _response(db, group, current_user, issueReopened=reopened)


@router.post("/{group_id}/approve")
def approve_correction(
    group_id: int,
    body: StatusNoteRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    group = _group_or_404(db, current_user, group_id)
    try:
        review_group(db, current_user, group, approve=True, note=body.note)
    except CorrectionError as error:
        db.rollback()
        _fail(error)
    return _response(db, group, current_user)


@router.post("/{group_id}/reject")
def reject_correction(
    group_id: int,
    body: StatusNoteRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Reject a match; the issue opens again."""
    group = _group_or_404(db, current_user, group_id)
    try:
        reopened = review_group(db, current_user, group, approve=False, note=body.note)
    except CorrectionError as error:
        db.rollback()
        _fail(error)
    return _response(db, group, current_user, issueReopened=reopened)


@router.post("/import-legacy")
def import_legacy(
    body: ImportLegacyRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    """One-time move of the register the old UI kept in this browser."""
    return import_legacy_groups(db, current_user, body.groups)
