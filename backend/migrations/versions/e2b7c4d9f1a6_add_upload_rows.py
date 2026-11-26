"""Add upload_rows: the analysed rows of a large SAP data API pull

A pull too large to send to the browser keeps its rows here, so the Issues
page (Issues · This Upload) shows the same cards and table, worked out and
paged by the server. Only the latest few runs are kept.

Revision ID: e2b7c4d9f1a6
Revises: d4e9b1f7a3c2
Create Date: 2026-11-26
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.mysql import MEDIUMTEXT

revision: str = "e2b7c4d9f1a6"
down_revision: Union[str, Sequence[str], None] = "d4e9b1f7a3c2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "upload_rows",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("run_id", sa.Integer(), sa.ForeignKey("rule_runs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("company_code", sa.String(10), nullable=False, server_default=""),
        sa.Column("posting_date", sa.Date(), nullable=True),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("tds_deducted", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("report_category", sa.String(30), nullable=True),
        sa.Column("issue_tab", sa.String(20), nullable=True),
        sa.Column("vendor", sa.String(255), nullable=True),
        sa.Column("vendor_code", sa.String(50), nullable=True),
        sa.Column("vendor_pan", sa.String(20), nullable=True),
        sa.Column("doc_no", sa.String(50), nullable=True),
        sa.Column("doc_type", sa.String(10), nullable=True),
        sa.Column("section", sa.String(100), nullable=True),
        sa.Column("profit_center", sa.String(50), nullable=True),
        sa.Column("section_keys", sa.String(500), nullable=False, server_default=""),
        sa.Column("has_section", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("issue_severities", sa.String(100), nullable=False, server_default=""),
        sa.Column("issue_statuses", sa.String(200), nullable=False, server_default=""),
        sa.Column("issue_types", sa.Text(), nullable=True),
        sa.Column("data", sa.Text().with_variant(MEDIUMTEXT(), "mysql"), nullable=False),
    )
    op.create_index("ix_upload_rows_run_seq", "upload_rows", ["run_id", "seq"])
    op.create_index("ix_upload_rows_run_status", "upload_rows", ["run_id", "status"])


def downgrade() -> None:
    op.drop_index("ix_upload_rows_run_status", table_name="upload_rows")
    op.drop_index("ix_upload_rows_run_seq", table_name="upload_rows")
    op.drop_table("upload_rows")
