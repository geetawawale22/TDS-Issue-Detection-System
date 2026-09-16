"""add ldc upload issue rows

Revision ID: e9f1a2b3c4d5
Revises: c8d2e5f4a6b7
Create Date: 2026-09-15 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "e9f1a2b3c4d5"
down_revision: Union[str, Sequence[str], None] = "c8d2e5f4a6b7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "ldc_upload_issue_rows",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("row_number", sa.Integer(), nullable=False),
        sa.Column("certificate_number", sa.String(length=100), nullable=True),
        sa.Column("certificate_type", sa.String(length=20), nullable=True),
        sa.Column("vendor_pan", sa.String(length=20), nullable=True),
        sa.Column("vendor_code", sa.String(length=50), nullable=True),
        sa.Column("vendor_name", sa.String(length=255), nullable=True),
        sa.Column("company_code", sa.String(length=10), nullable=True),
        sa.Column("deductor_tan", sa.String(length=20), nullable=True),
        sa.Column("wtax_type", sa.String(length=20), nullable=True),
        sa.Column("wtx_code", sa.String(length=20), nullable=True),
        sa.Column("applicable_tds_section", sa.String(length=50), nullable=True),
        sa.Column("approved_tds_rate", sa.Numeric(precision=7, scale=4), nullable=True),
        sa.Column("valid_from", sa.Date(), nullable=True),
        sa.Column("valid_to", sa.Date(), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=True),
        sa.Column("is_verified", sa.Boolean(), nullable=True),
        sa.Column("saved_to_master", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("issues", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_ldc_upload_issue_rows_row_number", "ldc_upload_issue_rows", ["row_number"], unique=False)
    op.create_index("ix_ldc_upload_issue_rows_certificate_number", "ldc_upload_issue_rows", ["certificate_number"], unique=False)
    op.create_index("ix_ldc_upload_issue_rows_vendor_pan", "ldc_upload_issue_rows", ["vendor_pan"], unique=False)
    op.create_index("ix_ldc_upload_issue_rows_vendor_code", "ldc_upload_issue_rows", ["vendor_code"], unique=False)
    op.create_index("ix_ldc_upload_issue_rows_company_code", "ldc_upload_issue_rows", ["company_code"], unique=False)
    op.create_index("ix_ldc_upload_issue_rows_deductor_tan", "ldc_upload_issue_rows", ["deductor_tan"], unique=False)
    op.create_index("ix_ldc_upload_issue_rows_saved_to_master", "ldc_upload_issue_rows", ["saved_to_master"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_ldc_upload_issue_rows_saved_to_master", table_name="ldc_upload_issue_rows")
    op.drop_index("ix_ldc_upload_issue_rows_deductor_tan", table_name="ldc_upload_issue_rows")
    op.drop_index("ix_ldc_upload_issue_rows_company_code", table_name="ldc_upload_issue_rows")
    op.drop_index("ix_ldc_upload_issue_rows_vendor_code", table_name="ldc_upload_issue_rows")
    op.drop_index("ix_ldc_upload_issue_rows_vendor_pan", table_name="ldc_upload_issue_rows")
    op.drop_index("ix_ldc_upload_issue_rows_certificate_number", table_name="ldc_upload_issue_rows")
    op.drop_index("ix_ldc_upload_issue_rows_row_number", table_name="ldc_upload_issue_rows")
    op.drop_table("ldc_upload_issue_rows")
