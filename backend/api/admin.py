import os
import logging
from hashlib import sha256
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List
from db.database import get_db
from db.models import User, CompanyCodeAccess, PasswordSetupToken, CompanyCode
from schemas.user import UserCreate, UserOut, UserCreateOut, UserUpdate, CompanyCodeAssign
from core.dependencies import require_admin
from services.email_service import send_invite_email
from datetime import datetime, timedelta, timezone
from core.security import create_invite_token

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["Admin - User Management"])


def _serialize_user(user: User, db: Session) -> User:
    """
    Refreshes the user's company_codes relationship so the response
    reflects any newly added/removed access.
    """
    db.refresh(user)
    return user


@router.post("/users", response_model=UserCreateOut, status_code=status.HTTP_201_CREATED)
def create_user(
    user_in: UserCreate,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    """
    Admin creates a new user (Admin or Accountant).
    No password is set here — user completes setup via an
    invite link sent to their email.
    """
    existing_email = db.query(User).filter(User.email == user_in.email).first()
    if existing_email:
        raise HTTPException(status_code=400, detail="Email already registered")

    existing_username = db.query(User).filter(User.username == user_in.username).first()
    if existing_username:
        raise HTTPException(status_code=400, detail="Username already taken")

    if user_in.role not in ["admin", "accountant"]:
        raise HTTPException(status_code=400, detail="Role must be 'admin' or 'accountant'")

    new_user = User(
        full_name=user_in.full_name,
        username=user_in.username,
        email=user_in.email,
        hashed_password=None,
        role=user_in.role,
        is_active=False,
        created_by=admin_user.id,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    # Generate invite token (self-contained JWT, no DB validation needed)
    invite_token = create_invite_token(new_user.id)

    # Optional audit log entry — not used for validation, just visibility.
    # The user account is already committed above; nothing below this point
    # may raise back to the client — a failure here or in the email send
    # must never turn a successful user creation into a 500.
    try:
        expiry_hours = int(os.getenv("INVITE_EXPIRE_HOURS", 48))
        audit_row = PasswordSetupToken(
            user_id=new_user.id,
            # Hash of the real token, so each row is unique (the column has
            # a UNIQUE constraint) — a fixed placeholder collides on the
            # second-plus invite ever issued.
            token_hash=sha256(invite_token.encode("utf-8")).hexdigest(),
            token_type="invite",
            expires_at=datetime.now(timezone.utc) + timedelta(hours=expiry_hours),
        )
        db.add(audit_row)
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("Failed to write invite audit log for user_id=%s", new_user.id)

    invite_email_sent = True
    try:
        send_invite_email(new_user.email, new_user.full_name, invite_token)
    except Exception:
        # SMTP not configured, send failed, or the recipient's mail server
        # silently dropped it (e.g. corporate spam/phishing filtering) —
        # user created successfully either way. Tell the admin so they can
        # share the link manually instead of the new user being stuck with
        # no visible error anywhere.
        invite_email_sent = False
        logger.exception("Failed to send invite email for user_id=%s", new_user.id)

    result = UserCreateOut.model_validate(_serialize_user(new_user, db))
    result.invite_email_sent = invite_email_sent
    return result


@router.get("/users", response_model=List[UserOut])
def list_users(
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    """Admin views all users in the system."""
    users = db.query(User).all()
    return [_serialize_user(u, db) for u in users]


@router.get("/users/{user_id}", response_model=UserOut)
def get_user(
    user_id: int,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    """Admin views a single user's details."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return _serialize_user(user, db)


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(
    user_id: int,
    update: UserUpdate,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    """Admin edits an existing user's name, email, and/or role. Only the
    fields present in the request body are changed."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if update.email is not None and update.email != user.email:
        existing_email = db.query(User).filter(User.email == update.email, User.id != user_id).first()
        if existing_email:
            raise HTTPException(status_code=400, detail="Email already registered")

    if update.role is not None and user.id == admin_user.id and update.role != "admin":
        raise HTTPException(status_code=400, detail="You cannot demote your own account")

    update_fields = update.model_dump(exclude_unset=True, exclude_none=True)
    for field, value in update_fields.items():
        setattr(user, field, value)

    db.commit()
    db.refresh(user)

    return _serialize_user(user, db)


def _valid_company_codes(db: Session) -> list[str]:
    return [row.code for row in db.query(CompanyCode).filter(CompanyCode.is_active == True).all()]


@router.post("/users/assign-company-code", response_model=UserOut)
def assign_company_code(
    assignment: CompanyCodeAssign,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    """
    Admin grants a user access to a specific company code.
    """
    user = db.query(User).filter(User.id == assignment.user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    valid_codes = _valid_company_codes(db)
    if assignment.company_code not in valid_codes:
        raise HTTPException(status_code=400, detail=f"Invalid company code. Must be one of {valid_codes}")

    existing = db.query(CompanyCodeAccess).filter(
        CompanyCodeAccess.user_id == assignment.user_id,
        CompanyCodeAccess.company_code == assignment.company_code,
    ).first()

    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"User already has access to company code {assignment.company_code}",
        )

    new_access = CompanyCodeAccess(
        user_id=assignment.user_id,
        company_code=assignment.company_code,
        granted_by=admin_user.id,
    )
    db.add(new_access)
    db.commit()
    db.refresh(user)

    return _serialize_user(user, db)


@router.delete("/users/{user_id}/company-code/{company_code}", response_model=UserOut)
def revoke_company_code(
    user_id: int,
    company_code: str,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    """
    Admin revokes a user's access to a specific company code.
    """
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    access_row = db.query(CompanyCodeAccess).filter(
        CompanyCodeAccess.user_id == user_id,
        CompanyCodeAccess.company_code == company_code,
    ).first()

    if not access_row:
        raise HTTPException(
            status_code=404,
            detail=f"User does not have access to company code {company_code}",
        )

    db.delete(access_row)
    db.commit()
    db.refresh(user)

    return _serialize_user(user, db)


@router.delete("/users/{user_id}", status_code=status.HTTP_200_OK)
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    """
    Admin permanently deletes a user account.

    A user can be referenced elsewhere purely for audit purposes —
    as the creator of other users (created_by) or the granter of
    someone else's company-code access (granted_by). Those links are
    informational only, so they're cleared rather than blocking the
    delete. Their own invite/reset tokens are removed outright, and
    their own company-code grants cascade via the ORM relationship.
    """
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if user.id == admin_user.id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")

    db.query(User).filter(User.created_by == user_id).update({"created_by": None})
    db.query(CompanyCodeAccess).filter(CompanyCodeAccess.granted_by == user_id).update({"granted_by": None})
    db.query(PasswordSetupToken).filter(PasswordSetupToken.user_id == user_id).delete()

    db.delete(user)
    db.commit()

    return {"detail": "User deleted successfully"}


@router.patch("/users/{user_id}/deactivate", response_model=UserOut)
def deactivate_user(
    user_id: int,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    """Admin deactivates a user account. User can no longer log in."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if user.id == admin_user.id:
        raise HTTPException(status_code=400, detail="You cannot deactivate your own account")

    user.is_active = False
    db.commit()
    db.refresh(user)

    return _serialize_user(user, db)


@router.patch("/users/{user_id}/activate", response_model=UserOut)
def activate_user(
    user_id: int,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    """Admin re-activates a previously deactivated user account."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.is_active = True
    db.commit()
    db.refresh(user)

    return _serialize_user(user, db)