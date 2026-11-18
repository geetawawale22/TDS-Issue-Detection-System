"""add document amount and debit/credit to tracked_issues

Revision ID: b8e4f6a2d3c1
Revises: a7d3e5f9c1b2
Create Date: 2026-11-16

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "b8e4f6a2d3c1"
down_revision: Union[str, Sequence[str], None] = "a7d3e5f9c1b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("tracked_issues", sa.Column("document_amount", sa.Numeric(18, 2), nullable=True))
    op.add_column("tracked_issues", sa.Column("debit_credit", sa.String(length=1), nullable=True))


def downgrade() -> None:
    op.drop_column("tracked_issues", "debit_credit")
    op.drop_column("tracked_issues", "document_amount")
