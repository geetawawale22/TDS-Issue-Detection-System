"""add profit center to tracked_issues

Revision ID: c3f8a1d6e4b7
Revises: b8e4f6a2d3c1
Create Date: 2026-11-16

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "c3f8a1d6e4b7"
down_revision: Union[str, Sequence[str], None] = "b8e4f6a2d3c1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("tracked_issues", sa.Column("profit_center", sa.String(length=50), nullable=True))


def downgrade() -> None:
    op.drop_column("tracked_issues", "profit_center")
