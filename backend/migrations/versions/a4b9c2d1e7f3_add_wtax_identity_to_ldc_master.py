"""add wtax identity to ldc master

Revision ID: a4b9c2d1e7f3
Revises: f6a1c3d9e8b2
Create Date: 2026-09-11 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "a4b9c2d1e7f3"
down_revision: Union[str, Sequence[str], None] = "f6a1c3d9e8b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Preserve SAP WTax type/code rows even when they map to one section."""
    op.add_column("ldc_certificate_master", sa.Column("wtax_type", sa.String(length=20), nullable=True))
    op.add_column("ldc_certificate_master", sa.Column("wtx_code", sa.String(length=20), nullable=True))
    op.create_index("ix_ldc_certificate_master_wtax_type", "ldc_certificate_master", ["wtax_type"], unique=False)
    op.create_index("ix_ldc_certificate_master_wtx_code", "ldc_certificate_master", ["wtx_code"], unique=False)

    op.drop_constraint("uq_ldc_certificate_scope", "ldc_certificate_master", type_="unique")
    op.create_unique_constraint(
        "uq_ldc_certificate_scope",
        "ldc_certificate_master",
        [
            "certificate_number",
            "vendor_pan",
            "vendor_code",
            "company_code",
            "deductor_tan",
            "wtax_type",
            "wtx_code",
            "applicable_tds_section",
        ],
    )


def downgrade() -> None:
    """Remove WTax type/code from LDC certificate identity."""
    op.drop_constraint("uq_ldc_certificate_scope", "ldc_certificate_master", type_="unique")
    op.create_unique_constraint(
        "uq_ldc_certificate_scope",
        "ldc_certificate_master",
        [
            "certificate_number",
            "vendor_pan",
            "vendor_code",
            "company_code",
            "deductor_tan",
            "applicable_tds_section",
        ],
    )

    op.drop_index("ix_ldc_certificate_master_wtx_code", table_name="ldc_certificate_master")
    op.drop_index("ix_ldc_certificate_master_wtax_type", table_name="ldc_certificate_master")
    op.drop_column("ldc_certificate_master", "wtx_code")
    op.drop_column("ldc_certificate_master", "wtax_type")
