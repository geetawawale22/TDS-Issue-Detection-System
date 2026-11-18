"""ledger_lines: one row per withholding tax of a SAP line

Revision ID: a9c4e2d7f1b3
Revises: f3b8d1c6a2e9
Create Date: 2026-11-18

A SAP line can carry two withholding taxes (e.g. 194Q and 194C). The ledger
kept only one of them; now each is its own row, and only the first counts the
line's amount in group totals. Existing rows keep '' for the new key columns
and are reused when their file is analysed again.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "a9c4e2d7f1b3"
down_revision: Union[str, Sequence[str], None] = "f3b8d1c6a2e9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("ledger_lines", sa.Column("withholding_tax_type", sa.String(length=10), nullable=False, server_default=""))
    op.add_column("ledger_lines", sa.Column("withholding_tax_code", sa.String(length=10), nullable=False, server_default=""))
    op.add_column("ledger_lines", sa.Column("is_primary_entry", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.drop_constraint("uq_ledger_lines_identity", "ledger_lines", type_="unique")
    op.create_unique_constraint(
        "uq_ledger_lines_identity", "ledger_lines",
        ["company_code", "fiscal_year", "doc_no", "line_item", "withholding_tax_type", "withholding_tax_code"],
    )


def downgrade() -> None:
    # Keep one row per SAP line again (the primary one) before restoring the old key.
    op.execute("DELETE FROM ledger_lines WHERE is_primary_entry = false")
    op.drop_constraint("uq_ledger_lines_identity", "ledger_lines", type_="unique")
    op.create_unique_constraint(
        "uq_ledger_lines_identity", "ledger_lines", ["company_code", "fiscal_year", "doc_no", "line_item"],
    )
    op.drop_column("ledger_lines", "is_primary_entry")
    op.drop_column("ledger_lines", "withholding_tax_code")
    op.drop_column("ledger_lines", "withholding_tax_type")
