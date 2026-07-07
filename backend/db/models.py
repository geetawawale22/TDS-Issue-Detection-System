from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, ForeignKey, Table
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from db.database import Base


# ============================================================
# ASSOCIATION TABLE — Many-to-Many between Users and Company Codes
# One user can have access to multiple company codes.
# One company code can have multiple users.
# ============================================================

user_company_access = Table(
    "user_company_access",
    Base.metadata,
    Column("user_id", Integer, ForeignKey("users.id"), primary_key=True),
    Column("company_code", String(10), primary_key=True),
    Column("granted_at", DateTime(timezone=True), server_default=func.now()),
)


# ============================================================
# USERS TABLE
# ============================================================

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    full_name = Column(String(100), nullable=False)
    email = Column(String(150), unique=True, nullable=False, index=True)
    hashed_password = Column(String(255), nullable=False)

    role = Column(String(20), nullable=False, default="accountant")
    # role values: "admin" or "accountant"

    is_active = Column(Boolean, default=True)

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