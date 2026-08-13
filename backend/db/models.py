from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, ForeignKey,
    Numeric, Text, Date, UniqueConstraint, Index
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from db.database import Base


# ============================================================
# USERS TABLE
# ============================================================

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    full_name = Column(String(100), nullable=False)
    username = Column(String(50), unique=True, nullable=False, index=True)
    email = Column(String(150), unique=True, nullable=False, index=True)
    hashed_password = Column(String(255), nullable=True)
    # Nullable now — user has no password until they complete
    # the "set your password" flow via the invite link.

    role = Column(String(20), nullable=False, default="accountant")
    # role values: "admin" or "accountant"

    is_active = Column(Boolean, default=False)
    # Starts False — becomes True only after user sets their
    # password for the first time via the invite link.

    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    # Which admin created this user account — audit trail.

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationship: which company codes this user can access
    company_codes = relationship(
        "CompanyCodeAccess",
        back_populates="user",
        cascade="all, delete-orphan",
        foreign_keys="CompanyCodeAccess.user_id"
    )


# ============================================================
# COMPANY CODE ACCESS TABLE
# Explicit table (instead of plain association table) so we can
# store extra info later - e.g. who granted access, when, notes.
# ============================================================

class CompanyCodeAccess(Base):
    __tablename__ = "company_code_access"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    company_code = Column(String(10), nullable=False)
    # valid values as per project: "1001", "1079", "1081"

    granted_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    granted_at = Column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User", back_populates="company_codes", foreign_keys=[user_id])



# ============================================================
# PASSWORD SETUP TOKENS TABLE
# Handles both first-time password setup (invite) and
# forgot-password (reset) flows using the same mechanism.
# ============================================================

class PasswordSetupToken(Base):
    __tablename__ = "password_setup_tokens"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    token_hash = Column(String(255), unique=True, nullable=False, index=True)
    # We store a HASH of the token, never the raw token itself —
    # same principle as password storage.

    token_type = Column(String(20), nullable=False)
    # "invite" — first-time password setup (longer expiry)
    # "reset"  — forgot password (shorter expiry)

    expires_at = Column(DateTime(timezone=True), nullable=False)
    used = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class CompanyCode(Base):
    __tablename__ = "company_codes"

    id = Column(Integer, primary_key=True, index=True)
    code = Column(String(10), unique=True, nullable=False, index=True)
    name = Column(String(255), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())