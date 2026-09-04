"""add vendor code to ldc certificate master

Revision ID: e3b7c41a9d22
Revises: d8f4a6b2c901
Create Date: 2026-09-03 00:10:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "e3b7c41a9d22"
down_revision: Union[str, Sequence[str], None] = "d8f4a6b2c901"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Store SAP supplier code with each LDC row for exact transaction matching."""
    op.add_column("ldc_certificate_master", sa.Column("vendor_code", sa.String(length=50), nullable=True))
    op.create_index("ix_ldc_certificate_master_vendor_code", "ldc_certificate_master", ["vendor_code"], unique=False)


def downgrade() -> None:
    """Remove SAP supplier code from LDC master."""
    op.drop_index("ix_ldc_certificate_master_vendor_code", table_name="ldc_certificate_master")
    op.drop_column("ldc_certificate_master", "vendor_code")
