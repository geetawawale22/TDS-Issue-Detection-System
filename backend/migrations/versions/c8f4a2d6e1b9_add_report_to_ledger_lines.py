"""add report row and category to ledger_lines

Revision ID: c8f4a2d6e1b9
Revises: b5d2e8f4a1c7
Create Date: 2026-11-20

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "c8f4a2d6e1b9"
down_revision: Union[str, Sequence[str], None] = "b5d2e8f4a1c7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """TDS Category Report from saved lines (all runs). Lines saved earlier stay empty until re-analysed."""
    op.add_column("ledger_lines", sa.Column("report_category", sa.String(length=30), nullable=True))
    op.add_column("ledger_lines", sa.Column("report", sa.Text(), nullable=True))
    op.create_index("ix_ledger_lines_report_category", "ledger_lines", ["report_category"])


def downgrade() -> None:
    op.drop_index("ix_ledger_lines_report_category", table_name="ledger_lines")
    op.drop_column("ledger_lines", "report")
    op.drop_column("ledger_lines", "report_category")
