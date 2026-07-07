from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from db.database import get_db
from db.models import User, CompanyCodeAccess
from core.security import decode_access_token

# This tells FastAPI where the login endpoint is (used for /docs UI)
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/login")


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    """
    Decodes the JWT token from the request, fetches the user from DB.
    Raises 401 if token is invalid/expired or user no longer exists.
    Every protected route will depend on this function.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    payload = decode_access_token(token)
    if payload is None:
        raise credentials_exception

    user_id = payload.get("user_id")
    if user_id is None:
        raise credentials_exception

    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise credentials_exception

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account has been deactivated",
        )

    return user


def require_admin(current_user: User = Depends(get_current_user)) -> User:
    """
    Use this dependency on routes that only Admin should access.
    Example: user management, rule configuration.
    """
    if current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This action requires Admin privileges",
        )
    return current_user


def get_user_company_codes(user: User, db: Session) -> list[str]:
    """
    Returns the list of company codes a user has access to.
    Admin implicitly has access to ALL company codes.
    """
    if user.role == "admin":
        return ["1001", "1079", "1081"]  # all company codes in scope

    access_rows = db.query(CompanyCodeAccess).filter(
        CompanyCodeAccess.user_id == user.id
    ).all()
    return [row.company_code for row in access_rows]


def verify_company_code_access(
    company_code: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> User:
    """
    Use this on routes that accept a company_code parameter
    (like dashboard, issues, export). Ensures the logged-in user
    is actually allowed to see data for that company code.
    """
    allowed_codes = get_user_company_codes(current_user, db)

    if company_code not in allowed_codes:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"You do not have access to company code {company_code}",
        )

    return current_user