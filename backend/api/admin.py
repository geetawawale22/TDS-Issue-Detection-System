from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List

from db.database import get_db
from db.models import User, CompanyCodeAccess
from schemas.user import UserCreate, UserOut, CompanyCodeAssign
from core.security import hash_password
from core.dependencies import require_admin

router = APIRouter(prefix="/admin", tags=["Admin - User Management"])

VALID_COMPANY_CODES = ["1001", "1079", "1081"]


def _serialize_user(user: User, db: Session) -> User:
    """
    Refreshes the user's company_codes relationship so the response
    reflects any newly added/removed access.
    """
    db.refresh(user)
    return user


@router.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(
    user_in: UserCreate,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    """
    Admin creates a new user (Admin or Accountant).
    This replaces the open /auth/register endpoint for production use.
    """
    existing_user = db.query(User).filter(User.email == user_in.email).first()
    if existing_user:
        raise HTTPException(status_code=400, detail="Email already registered")

    if user_in.role not in ["admin", "accountant"]:
        raise HTTPException(status_code=400, detail="Role must be 'admin' or 'accountant'")

    new_user = User(
        full_name=user_in.full_name,
        email=user_in.email,
        hashed_password=hash_password(user_in.password),
        role=user_in.role,
        is_active=True,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    return _serialize_user(new_user, db)


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

    if assignment.company_code not in VALID_COMPANY_CODES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid company code. Must be one of {VALID_COMPANY_CODES}",
        )

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