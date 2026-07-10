import os
from hashlib import sha256
from datetime import datetime, timedelta, timezone
from passlib.context import CryptContext
from jose import jwt, JWTError
from dotenv import load_dotenv

load_dotenv()

JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
JWT_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", 480))
PASSWORD_RESET_EXPIRE_MINUTES = int(os.getenv("PASSWORD_RESET_EXPIRE_MINUTES", 30))
PASSWORD_RESET_SECRET_KEY = os.getenv("PASSWORD_RESET_SECRET_KEY", JWT_SECRET_KEY)

# bcrypt context — used to hash and verify passwords
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(plain_password: str) -> str:
    """
    Converts a plain password into a bcrypt hash before storing in DB.
    Never store plain_password anywhere.
    """
    return pwd_context.hash(plain_password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """
    Checks a login attempt's password against the stored hash.
    Returns True if they match, False otherwise.
    """
    return pwd_context.verify(plain_password, hashed_password)


def create_access_token(data: dict) -> str:
    """
    Creates a JWT token containing the given data (usually user id, email, role).
    Token expires after JWT_EXPIRE_MINUTES.
    """
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)
    return encoded_jwt


def decode_access_token(token: str) -> dict | None:
    """
    Decodes and validates a JWT token.
    Returns the payload dict if valid, None if invalid or expired.
    """
    try:
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
        return payload
    except JWTError:
        return None


def create_password_reset_token(user_id: int, hashed_password: str) -> str:
    """Create a short-lived token that becomes invalid after a password change."""
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=PASSWORD_RESET_EXPIRE_MINUTES)
    password_fingerprint = sha256(hashed_password.encode("utf-8")).hexdigest()
    return jwt.encode(
        {
            "sub": str(user_id),
            "purpose": "password_reset",
            "password_fingerprint": password_fingerprint,
            "exp": expires_at,
        },
        PASSWORD_RESET_SECRET_KEY,
        algorithm=JWT_ALGORITHM,
    )


def decode_password_reset_token(token: str) -> dict | None:
    """Return a valid password-reset token payload, or ``None`` for any invalid token."""
    try:
        payload = jwt.decode(token, PASSWORD_RESET_SECRET_KEY, algorithms=[JWT_ALGORITHM])
        if payload.get("purpose") != "password_reset" or not payload.get("sub"):
            return None
        return payload
    except JWTError:
        return None


def password_fingerprint(hashed_password: str) -> str:
    """Fingerprint used to invalidate reset links once the password changes."""
    return sha256(hashed_password.encode("utf-8")).hexdigest()
