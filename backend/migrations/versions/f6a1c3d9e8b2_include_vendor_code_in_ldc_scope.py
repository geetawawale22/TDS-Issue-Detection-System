"""include vendor code in ldc certificate scope

Revision ID: f6a1c3d9e8b2
Revises: e3b7c41a9d22
Create Date: 2026-09-11 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "f6a1c3d9e8b2"
down_revision: Union[str, Sequence[str], None] = "e3b7c41a9d22"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Preserve supplier-level LDC rows for the same PAN/certificate/section."""
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


def downgrade() -> None:
    """Restore the previous PAN/certificate/section uniqueness."""
    op.drop_constraint("uq_ldc_certificate_scope", "ldc_certificate_master", type_="unique")
    op.create_unique_constraint(
        "uq_ldc_certificate_scope",
        "ldc_certificate_master",
        [
            "certificate_number",
            "vendor_pan",
            "deductor_tan",
            "applicable_tds_section",
        ],
    )
