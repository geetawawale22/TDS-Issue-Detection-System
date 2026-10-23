"""add pan verifications

Revision ID: f1a7c3e9b2d4
Revises: e9f1a2b3c4d5
Create Date: 2026-10-23 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "f1a7c3e9b2d4"
down_revision: Union[str, Sequence[str], None] = "e9f1a2b3c4d5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "pan_verifications",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("pan", sa.String(length=10), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("source", sa.String(length=20), nullable=False),
        sa.Column("name_on_record", sa.String(length=255), nullable=True),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("checked_by", sa.Integer(), nullable=True),
        sa.Column("checked_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.ForeignKeyConstraint(["checked_by"], ["users.id"], name=op.f("pan_verifications_checked_by_fkey")),
        sa.PrimaryKeyConstraint("id", name=op.f("pan_verifications_pkey")),
    )
    op.create_index(op.f("ix_pan_verifications_id"), "pan_verifications", ["id"], unique=False)
    op.create_index(op.f("ix_pan_verifications_pan"), "pan_verifications", ["pan"], unique=True)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_pan_verifications_pan"), table_name="pan_verifications")
    op.drop_index(op.f("ix_pan_verifications_id"), table_name="pan_verifications")
    op.drop_table("pan_verifications")
