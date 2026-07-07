from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from core.dependencies import require_admin
from db.database import get_db
from db.models import User, CompanyCodeAccess
from schemas.auth import LoginRequest, TokenResponse
from schemas.user import UserCreate, UserOut
from core.security import hash_password, verify_password, create_access_token

router = APIRouter(prefix="/auth", tags=["Authentication"])


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def register_user(user_in: UserCreate, db: Session = Depends(get_db), admin_user: User = Depends(require_admin)):
    """
    Creates a new user. In production this should be restricted to Admin only
    (we'll lock this down once role-checking middleware is built).
    """
    existing_user = db.query(User).filter(User.email == user_in.email).first()
    if existing_user:
        raise HTTPException(status_code=400, detail="Email already registered")

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

    # attach empty company_codes list for response shape
    new_user.company_codes = []


@router.post("/login", response_model=TokenResponse)
def login(login_data: LoginRequest, db: Session = Depends(get_db)):
    """
    Validates email/password and returns a JWT token on success.
    """
    user = db.query(User).filter(User.email == login_data.email).first()

    if not user or not verify_password(login_data.password, user.hashed_password):
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