import logging
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session
from core.dependencies import require_admin
from db.database import get_db
from db.models import User
from schemas.auth import ForgotPasswordRequest, LoginRequest,MessageResponse,ResetPasswordRequest,TokenResponse
from schemas.user import UserCreate, UserOut
from core.security import create_access_token,create_password_reset_token,decode_password_reset_token,hash_password,password_fingerprint,verify_password,decode_invite_token
from services.email_service import send_password_reset_email
from pydantic import BaseModel
from datetime import datetime, timezone


router = APIRouter(prefix="/auth", tags=["Authentication"])
logger = logging.getLogger(__name__)


@router.post("/login", response_model=TokenResponse)
def login(login_data: LoginRequest, db: Session = Depends(get_db)):
    """
    Validates email/password and returns a JWT token on success.
    """
    user = db.query(User).filter(User.email == login_data.email).first()

    if not user or user.hashed_password is None or not verify_password(login_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account has been deactivated",
        )

    token = create_access_token({
        "user_id": user.id,
        "email": user.email,
        "role": user.role,
    })

    return TokenResponse(
        access_token=token,
        role=user.role,
        full_name=user.full_name,
    )



class SetPasswordRequest(BaseModel):
    token: str
    new_password: str


@router.post("/set-password", response_model=MessageResponse)
def set_password(payload: SetPasswordRequest, db: Session = Depends(get_db)):
    """
    Completes first-time password setup for a newly invited user.
    """
    token_data = decode_invite_token(payload.token)
    if token_data is None:
        raise HTTPException(status_code=400, detail="Invalid or expired invite link")

    user = db.query(User).filter(User.id == int(token_data["sub"])).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if user.hashed_password is not None:
        raise HTTPException(status_code=400, detail="This invite link has already been used")

    user.hashed_password = hash_password(payload.new_password)
    user.is_active = True
    db.commit()

    return MessageResponse(message="Password set successfully. You can now log in.")


@router.post("/forgot-password", response_model=MessageResponse)
def forgot_password(request: ForgotPasswordRequest, db: Session = Depends(get_db)):
    """Email a reset link when an active account exists.

    The same response is returned for every address to avoid disclosing which
    email addresses belong to users.
    """
    user = db.query(User).filter(
        func.lower(User.email) == str(request.email).lower()
    ).first()
    if user and user.is_active:
        logger.info("Password reset requested for active user_id=%s", user.id)
        token = create_password_reset_token(user.id, user.hashed_password)
        try:
            send_password_reset_email(user.email, token)
            logger.info("Password reset email accepted by SMTP for user_id=%s", user.id)
        except Exception:
            # Do not expose delivery/configuration details to an unauthenticated caller.
            logger.exception("Unable to send password-reset email for user_id=%s", user.id)
    else:
        logger.info("Password reset requested for an unknown or inactive account")

    return MessageResponse(message="If an account exists for this email, a password reset link has been sent.")


@router.post("/reset-password", response_model=MessageResponse)
def reset_password(request: ResetPasswordRequest, db: Session = Depends(get_db)):
    """Validate a reset token and replace the account password."""
    payload = decode_password_reset_token(request.token)
    if payload is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired password reset link")

    try:
        user_id = int(payload["sub"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired password reset link")

    user = db.query(User).filter(User.id == user_id).first()
    if (
        user is None
        or not user.is_active
        or payload.get("password_fingerprint") != password_fingerprint(user.hashed_password)
    ):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired password reset link")

    user.hashed_password = hash_password(request.password)
    db.commit()

    return MessageResponse(message="Password reset successfully. Please sign in with your new password.")
