"""PAN verification endpoints — Government PAN status check and its cache."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy.sql import func

from core.dependencies import get_current_user, require_admin
from db.database import get_db
from db.models import PanVerification, User
from services.pan_verification_service import (
    ERROR,
    INVALID,
    INOPERATIVE,
    NOT_VERIFIED,
    VERIFIED,
    is_valid_pan_format,
    normalise_pan,
    pan_verification_service,
)


router = APIRouter(prefix="/pan", tags=["PAN Verification"])

MAX_PANS_PER_REQUEST = 5000

# Results that are final until someone asks for a re-check. NOT_VERIFIED and
# ERROR are always retried, so PANs get checked once the API is connected.
FINAL_STATUSES = {VERIFIED, INVALID, INOPERATIVE}


class PanListRequest(BaseModel):
    pans: list[str] = Field(default_factory=list)


class PanVerifyRequest(PanListRequest):
    force: bool = False  # re-check PANs that already have a final result


class PanStatusOverride(BaseModel):
    status: Literal["VERIFIED", "INVALID", "INOPERATIVE"]
    message: str | None = None


def _unique_pans(pans: list[str]) -> list[str]:
    unique = list(dict.fromkeys(pan for pan in (normalise_pan(p) for p in pans) if pan))
    if len(unique) > MAX_PANS_PER_REQUEST:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"At most {MAX_PANS_PER_REQUEST} PANs can be sent in one request.",
        )
    return unique


def _payload(row: PanVerification) -> dict[str, Any]:
    return {
        "pan": row.pan,
        "status": row.status,
        "source": row.source,
        "nameOnRecord": row.name_on_record,
        "message": row.message,
        "checkedAt": row.checked_at.isoformat() if row.checked_at else None,
    }


def _upsert(db: Session, existing: dict[str, PanVerification], pan: str, **values: Any) -> PanVerification:
    row = existing.get(pan)
    if row is None:
        row = PanVerification(pan=pan)
        db.add(row)
        existing[pan] = row
    for key, value in values.items():
        setattr(row, key, value)
    row.checked_at = func.now()
    return row


@router.get("/config")
def pan_verification_config(current_user: User = Depends(get_current_user)):
    """Tells the UI whether the Government PAN API is connected yet."""
    return {"apiConfigured": pan_verification_service.is_configured}


@router.post("/statuses")
def list_pan_statuses(
    request: PanListRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Saved verification results for the given PANs (no API calls)."""
    pans = _unique_pans(request.pans)
    if not pans:
        return {"results": []}
    rows = db.query(PanVerification).filter(PanVerification.pan.in_(pans)).all()
    return {"results": [_payload(row) for row in rows]}


@router.post("/verify")
def verify_pans(
    request: PanVerifyRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Checks PANs with the Government API (format-only until it is configured)."""
    pans = _unique_pans(request.pans)
    existing = {
        row.pan: row
        for row in db.query(PanVerification).filter(PanVerification.pan.in_(pans)).all()
    } if pans else {}

    checked = 0
    for pan in pans:
        row = existing.get(pan)
        if row is not None and row.status in FINAL_STATUSES and not request.force:
            continue
        result = pan_verification_service.verify_pan(pan)
        _upsert(
            db, existing, pan,
            status=result.status,
            source=result.source,
            name_on_record=result.name_on_record,
            message=result.message,
            checked_by=current_user.id,
        )
        checked += 1

    db.commit()
    rows = [existing[pan] for pan in pans if pan in existing]
    return {
        "apiConfigured": pan_verification_service.is_configured,
        "checked": checked,
        "failed": sum(row.status == ERROR for row in rows),
        "notVerified": sum(row.status == NOT_VERIFIED for row in rows),
        "results": [_payload(row) for row in rows],
    }


@router.put("/{pan}/status")
def override_pan_status(
    pan: str,
    request: PanStatusOverride,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Admin override — e.g. a PAN confirmed invalid on the e-filing portal."""
    pan = normalise_pan(pan)
    if not is_valid_pan_format(pan):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Only a correctly formatted PAN can be marked manually.",
        )
    existing = {row.pan: row for row in db.query(PanVerification).filter(PanVerification.pan == pan).all()}
    row = _upsert(
        db, existing, pan,
        status=request.status,
        source="manual",
        message=request.message or f"Marked {request.status.lower()} manually by {current_user.username}.",
        checked_by=current_user.id,
    )
    db.commit()
    db.refresh(row)
    return _payload(row)
