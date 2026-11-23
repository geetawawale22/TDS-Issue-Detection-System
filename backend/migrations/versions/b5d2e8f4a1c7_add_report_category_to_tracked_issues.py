"""add report_category to tracked_issues

Revision ID: b5d2e8f4a1c7
Revises: a9c4e2d7f1b3
Create Date: 2026-11-20

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "b5d2e8f4a1c7"
down_revision: Union[str, Sequence[str], None] = "a9c4e2d7f1b3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Business sheet per saved issue (Short / Excess / Not Deducted / LDC / ...) for the Open Issues tabs."""
    op.add_column("tracked_issues", sa.Column("report_category", sa.String(length=30), nullable=True))
    op.create_index("ix_tracked_issues_report_category", "tracked_issues", ["report_category"])

    # Issues saved earlier: worked out from their saved category and amounts.
    # The next run that raises one again stores the exact value.
    from services.report_category import saved_issue_report_category

    bind = op.get_bind()
    rows = bind.execute(sa.text(
        "SELECT id, category, base_amount, expected_rate, tds_amount FROM tracked_issues"
    )).fetchall()
    if rows:
        bind.execute(
            sa.text("UPDATE tracked_issues SET report_category = :value WHERE id = :id"),
            [
                {"value": saved_issue_report_category(row.category, row.base_amount, row.expected_rate, row.tds_amount), "id": row.id}
                for row in rows
            ],
        )


def downgrade() -> None:
    op.drop_index("ix_tracked_issues_report_category", table_name="tracked_issues")
    op.drop_column("tracked_issues", "report_category")
