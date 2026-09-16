"""include dates and rate in ldc certificate scope

Revision ID: c8d2e5f4a6b7
Revises: a4b9c2d1e7f3
Create Date: 2026-09-15 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "c8d2e5f4a6b7"
down_revision: Union[str, Sequence[str], None] = "a4b9c2d1e7f3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Preserve rows that differ by validity period or exemption percentage."""
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
            "valid_from",
            "valid_to",
            "approved_tds_rate",
        ],
    )


def downgrade() -> None:
    """Remove dates and rate from the LDC certificate identity."""
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
