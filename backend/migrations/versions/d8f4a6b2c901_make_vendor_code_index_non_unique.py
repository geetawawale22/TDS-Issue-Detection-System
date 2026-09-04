"""make vendor code index non unique

Revision ID: d8f4a6b2c901
Revises: c2e4f91a0b37
Create Date: 2026-09-03 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "d8f4a6b2c901"
down_revision: Union[str, Sequence[str], None] = "c2e4f91a0b37"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Allow repeated supplier codes in the temporary vendor master."""
    op.drop_index("ix_vendor_master_vendor_code", table_name="vendor_master")
    op.create_index("ix_vendor_master_vendor_code", "vendor_master", ["vendor_code"], unique=False)


def downgrade() -> None:
    """Restore the old unique index after duplicate vendor codes are removed."""
    op.drop_index("ix_vendor_master_vendor_code", table_name="vendor_master")
    op.create_index("ix_vendor_master_vendor_code", "vendor_master", ["vendor_code"], unique=True)
