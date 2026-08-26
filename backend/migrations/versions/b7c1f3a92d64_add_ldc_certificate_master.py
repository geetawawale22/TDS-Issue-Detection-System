"""add ldc certificate master

Revision ID: b7c1f3a92d64
Revises: 9e4a2c7f1d08
Create Date: 2026-08-17 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "b7c1f3a92d64"
down_revision: Union[str, Sequence[str], None] = "9e4a2c7f1d08"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "company_code_tan_mapping",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("company_code", sa.String(length=10), nullable=False),
        sa.Column("legal_entity_name", sa.String(length=255), nullable=True),
        sa.Column("deductor_tan", sa.String(length=20), nullable=False),
        sa.Column("deductor_pan", sa.String(length=20), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("company_code_tan_mapping_pkey")),
        sa.UniqueConstraint("company_code", "deductor_tan", name="uq_company_code_tan_mapping_company_tan"),
    )
    op.create_index(op.f("ix_company_code_tan_mapping_id"), "company_code_tan_mapping", ["id"], unique=False)
    op.create_index(op.f("ix_company_code_tan_mapping_company_code"), "company_code_tan_mapping", ["company_code"], unique=False)
    op.create_index(op.f("ix_company_code_tan_mapping_deductor_tan"), "company_code_tan_mapping", ["deductor_tan"], unique=False)

    op.create_table(
        "ldc_certificate_master",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("certificate_number", sa.String(length=100), nullable=False),
        sa.Column("certificate_type", sa.String(length=20), nullable=False),
        sa.Column("vendor_pan", sa.String(length=20), nullable=False),
        sa.Column("vendor_name", sa.String(length=255), nullable=True),
        sa.Column("company_code", sa.String(length=10), nullable=True),
        sa.Column("deductor_tan", sa.String(length=20), nullable=True),
        sa.Column("applicable_tds_section", sa.String(length=50), nullable=False),
        sa.Column("approved_tds_rate", sa.Numeric(precision=7, scale=4), nullable=False),
        sa.Column("valid_from", sa.Date(), nullable=False),
        sa.Column("valid_to", sa.Date(), nullable=False),
        sa.Column("tax_year", sa.String(length=20), nullable=True),
        sa.Column("approved_amount_limit", sa.Numeric(precision=18, scale=2), nullable=True),
        sa.Column("amount_utilized", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("is_verified", sa.Boolean(), nullable=False),
        sa.Column("last_verified_date", sa.Date(), nullable=True),
        sa.Column("parent_certificate_number", sa.String(length=100), nullable=True),
        sa.Column("is_child_certificate", sa.Boolean(), nullable=False),
        sa.Column("certificate_file_path", sa.String(length=500), nullable=True),
        sa.Column("remarks", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("ldc_certificate_master_pkey")),
        sa.UniqueConstraint(
            "certificate_number",
            "vendor_pan",
            "deductor_tan",
            "applicable_tds_section",
            name="uq_ldc_certificate_scope",
        ),
    )
    op.create_index(op.f("ix_ldc_certificate_master_id"), "ldc_certificate_master", ["id"], unique=False)
    op.create_index(op.f("ix_ldc_certificate_master_certificate_number"), "ldc_certificate_master", ["certificate_number"], unique=False)
    op.create_index(op.f("ix_ldc_certificate_master_vendor_pan"), "ldc_certificate_master", ["vendor_pan"], unique=False)
    op.create_index(op.f("ix_ldc_certificate_master_company_code"), "ldc_certificate_master", ["company_code"], unique=False)
    op.create_index(op.f("ix_ldc_certificate_master_deductor_tan"), "ldc_certificate_master", ["deductor_tan"], unique=False)
    op.create_index(op.f("ix_ldc_certificate_master_applicable_tds_section"), "ldc_certificate_master", ["applicable_tds_section"], unique=False)
    op.create_index(op.f("ix_ldc_certificate_master_status"), "ldc_certificate_master", ["status"], unique=False)
    op.create_index(op.f("ix_ldc_certificate_master_parent_certificate_number"), "ldc_certificate_master", ["parent_certificate_number"], unique=False)
    op.create_index(
        "ix_ldc_lookup_scope",
        "ldc_certificate_master",
        ["vendor_pan", "company_code", "deductor_tan", "applicable_tds_section", "valid_from", "valid_to", "status"],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_ldc_lookup_scope", table_name="ldc_certificate_master")
    op.drop_index(op.f("ix_ldc_certificate_master_parent_certificate_number"), table_name="ldc_certificate_master")
    op.drop_index(op.f("ix_ldc_certificate_master_status"), table_name="ldc_certificate_master")
    op.drop_index(op.f("ix_ldc_certificate_master_applicable_tds_section"), table_name="ldc_certificate_master")
    op.drop_index(op.f("ix_ldc_certificate_master_deductor_tan"), table_name="ldc_certificate_master")
    op.drop_index(op.f("ix_ldc_certificate_master_company_code"), table_name="ldc_certificate_master")
    op.drop_index(op.f("ix_ldc_certificate_master_vendor_pan"), table_name="ldc_certificate_master")
    op.drop_index(op.f("ix_ldc_certificate_master_certificate_number"), table_name="ldc_certificate_master")
    op.drop_index(op.f("ix_ldc_certificate_master_id"), table_name="ldc_certificate_master")
    op.drop_table("ldc_certificate_master")

    op.drop_index(op.f("ix_company_code_tan_mapping_deductor_tan"), table_name="company_code_tan_mapping")
    op.drop_index(op.f("ix_company_code_tan_mapping_company_code"), table_name="company_code_tan_mapping")
    op.drop_index(op.f("ix_company_code_tan_mapping_id"), table_name="company_code_tan_mapping")
    op.drop_table("company_code_tan_mapping")
