"""add vendor master

Revision ID: c2e4f91a0b37
Revises: b7c1f3a92d64
Create Date: 2026-08-17 00:10:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "c2e4f91a0b37"
down_revision: Union[str, Sequence[str], None] = "b7c1f3a92d64"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "vendor_master",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("vendor_code", sa.String(length=50), nullable=False),
        sa.Column("vendor_name", sa.String(length=255), nullable=False),
        sa.Column("vendor_pan", sa.String(length=20), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("vendor_master_pkey")),
    )
    op.create_index(op.f("ix_vendor_master_id"), "vendor_master", ["id"], unique=False)
    op.create_index(op.f("ix_vendor_master_vendor_code"), "vendor_master", ["vendor_code"], unique=True)
    op.create_index(op.f("ix_vendor_master_vendor_pan"), "vendor_master", ["vendor_pan"], unique=False)

    op.bulk_insert(
        sa.table(
            "vendor_master",
            sa.column("vendor_code", sa.String),
            sa.column("vendor_name", sa.String),
            sa.column("vendor_pan", sa.String),
            sa.column("is_active", sa.Boolean),
        ),
        [
            {"vendor_code": "E5684", "vendor_name": "EVERGREEN MOTORS", "vendor_pan": "AAAFE3841P", "is_active": True},
            {"vendor_code": "E010081", "vendor_name": "EVERGREEN MOTORS", "vendor_pan": "AAAFE3841P", "is_active": True},
            {"vendor_code": "EBU23812", "vendor_name": "CAPITAL TRADERS & ENGINEE", "vendor_pan": "AAEPZ9355R", "is_active": True},
            {"vendor_code": "DIS02169AA", "vendor_name": "SITARA ENTERPRISES", "vendor_pan": "ABTPN5043J", "is_active": True},
            {"vendor_code": "SITAT105CH", "vendor_name": "SITARA ENTERPRISES", "vendor_pan": "ABTPN5043J", "is_active": True},
            {"vendor_code": "DDS00033AJ", "vendor_name": "STEEL STRIPS WHEELS LIMITED", "vendor_pan": "AACCS3003L", "is_active": True},
            {"vendor_code": "DS146", "vendor_name": "STEEL STRIPS WHEELS LIMITED", "vendor_pan": "AACCS3003L", "is_active": True},
            {"vendor_code": "DS146A", "vendor_name": "STEEL STRIPS WHEELS LIMITED", "vendor_pan": "AACCS3003L", "is_active": True},
            {"vendor_code": "DS146D", "vendor_name": "STEEL STRIPS WHEELS LIMITED", "vendor_pan": "AACCS3003L", "is_active": True},
        ],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_vendor_master_vendor_pan"), table_name="vendor_master")
    op.drop_index(op.f("ix_vendor_master_vendor_code"), table_name="vendor_master")
    op.drop_index(op.f("ix_vendor_master_id"), table_name="vendor_master")
    op.drop_table("vendor_master")
