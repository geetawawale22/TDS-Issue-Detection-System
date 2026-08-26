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


class VendorMaster(Base):
    __tablename__ = "vendor_master"

    id = Column(Integer, primary_key=True, index=True)
    vendor_code = Column(String(50), nullable=False, unique=True, index=True)
    vendor_name = Column(String(255), nullable=False)
    vendor_pan = Column(String(20), nullable=False, index=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class CompanyCodeTanMapping(Base):
    __tablename__ = "company_code_tan_mapping"

    id = Column(Integer, primary_key=True, index=True)
    company_code = Column(String(10), nullable=False, index=True)
    legal_entity_name = Column(String(255), nullable=True)
    deductor_tan = Column(String(20), nullable=False, index=True)
    deductor_pan = Column(String(20), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("company_code", "deductor_tan", name="uq_company_code_tan_mapping_company_tan"),
    )


class LDCCertificateMaster(Base):
    __tablename__ = "ldc_certificate_master"

    id = Column(Integer, primary_key=True, index=True)
    certificate_number = Column(String(100), nullable=False, index=True)
    certificate_type = Column(String(20), nullable=False)
    vendor_pan = Column(String(20), nullable=False, index=True)
    vendor_name = Column(String(255), nullable=True)

    company_code = Column(String(10), nullable=True, index=True)
    deductor_tan = Column(String(20), nullable=True, index=True)
    applicable_tds_section = Column(String(50), nullable=False, index=True)
    approved_tds_rate = Column(Numeric(7, 4), nullable=False)

    valid_from = Column(Date, nullable=False)
    valid_to = Column(Date, nullable=False)
    tax_year = Column(String(20), nullable=True)

    approved_amount_limit = Column(Numeric(18, 2), nullable=True)
    amount_utilized = Column(Numeric(18, 2), nullable=False, default=0)
    status = Column(String(20), nullable=False, default="ACTIVE", index=True)
    is_verified = Column(Boolean, nullable=False, default=False)
    last_verified_date = Column(Date, nullable=True)

    parent_certificate_number = Column(String(100), nullable=True, index=True)
    is_child_certificate = Column(Boolean, nullable=False, default=False)
    certificate_file_path = Column(String(500), nullable=True)
    remarks = Column(Text, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint(
            "certificate_number",
            "vendor_pan",
            "deductor_tan",
            "applicable_tds_section",
            name="uq_ldc_certificate_scope",
        ),
        Index(
            "ix_ldc_lookup_scope",
            "vendor_pan",
            "company_code",
            "deductor_tan",
            "applicable_tds_section",
            "valid_from",
            "valid_to",
            "status",
        ),
    )
