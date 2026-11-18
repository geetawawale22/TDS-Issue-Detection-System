"""add rule runs and tracked issues

Revision ID: a7d3e5f9c1b2
Revises: f1a7c3e9b2d4
Create Date: 2026-11-16 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "a7d3e5f9c1b2"
down_revision: Union[str, Sequence[str], None] = "f1a7c3e9b2d4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "rule_runs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(length=20), nullable=False),
        sa.Column("file_name", sa.Text(), nullable=True),
        sa.Column("company_codes", sa.String(length=255), nullable=True),
        sa.Column("period_from", sa.Date(), nullable=True),
        sa.Column("period_to", sa.Date(), nullable=True),
        sa.Column("transactions", sa.Integer(), nullable=False),
        sa.Column("issues_found", sa.Integer(), nullable=False),
        sa.Column("new_issues", sa.Integer(), nullable=False),
        sa.Column("recurring_issues", sa.Integer(), nullable=False),
        sa.Column("reopened_issues", sa.Integer(), nullable=False),
        sa.Column("resolved_issues", sa.Integer(), nullable=False),
        sa.Column("partially_corrected", sa.Integer(), nullable=False),
        sa.Column("run_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.ForeignKeyConstraint(["run_by"], ["users.id"], name=op.f("rule_runs_run_by_fkey")),
        sa.PrimaryKeyConstraint("id", name=op.f("rule_runs_pkey")),
    )
    op.create_index(op.f("ix_rule_runs_id"), "rule_runs", ["id"], unique=False)
    op.create_index(op.f("ix_rule_runs_created_at"), "rule_runs", ["created_at"], unique=False)

    op.create_table(
        "tracked_issues",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("issue_key", sa.String(length=64), nullable=False),
        sa.Column("company_code", sa.String(length=10), nullable=False),
        sa.Column("fiscal_year", sa.String(length=10), nullable=False),
        sa.Column("doc_no", sa.String(length=50), nullable=False),
        sa.Column("line_item", sa.String(length=20), nullable=False),
        sa.Column("doc_type", sa.String(length=10), nullable=True),
        sa.Column("category", sa.String(length=150), nullable=False),
        sa.Column("issue_type", sa.String(length=60), nullable=True),
        sa.Column("severity", sa.String(length=10), nullable=True),
        sa.Column("vendor_code", sa.String(length=50), nullable=True),
        sa.Column("vendor_name", sa.String(length=255), nullable=True),
        sa.Column("vendor_pan", sa.String(length=20), nullable=True),
        sa.Column("section", sa.String(length=50), nullable=True),
        sa.Column("posting_date", sa.Date(), nullable=True),
        sa.Column("base_amount", sa.Numeric(18, 2), nullable=True),
        sa.Column("tds_amount", sa.Numeric(18, 2), nullable=True),
        sa.Column("applied_rate", sa.Numeric(9, 4), nullable=True),
        sa.Column("expected_rate", sa.Numeric(9, 4), nullable=True),
        sa.Column("tax_impact", sa.Numeric(18, 2), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("resolution_type", sa.String(length=30), nullable=True),
        sa.Column("resolution_note", sa.Text(), nullable=True),
        sa.Column("correction_docs", sa.Text(), nullable=True),
        sa.Column("corrected_tds", sa.Numeric(18, 2), nullable=True),
        sa.Column("remaining_shortfall", sa.Numeric(18, 2), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_run_id", sa.Integer(), nullable=True),
        sa.Column("resolved_by", sa.Integer(), nullable=True),
        sa.Column("first_seen_run_id", sa.Integer(), nullable=True),
        sa.Column("last_seen_run_id", sa.Integer(), nullable=True),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("times_seen", sa.Integer(), nullable=False),
        sa.Column("reopened_count", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["resolved_run_id"], ["rule_runs.id"], name=op.f("tracked_issues_resolved_run_id_fkey")),
        sa.ForeignKeyConstraint(["resolved_by"], ["users.id"], name=op.f("tracked_issues_resolved_by_fkey")),
        sa.ForeignKeyConstraint(["first_seen_run_id"], ["rule_runs.id"], name=op.f("tracked_issues_first_seen_run_id_fkey")),
        sa.ForeignKeyConstraint(["last_seen_run_id"], ["rule_runs.id"], name=op.f("tracked_issues_last_seen_run_id_fkey")),
        sa.PrimaryKeyConstraint("id", name=op.f("tracked_issues_pkey")),
    )
    op.create_index(op.f("ix_tracked_issues_id"), "tracked_issues", ["id"], unique=False)
    op.create_index(op.f("ix_tracked_issues_issue_key"), "tracked_issues", ["issue_key"], unique=True)
    op.create_index(op.f("ix_tracked_issues_company_code"), "tracked_issues", ["company_code"], unique=False)
    op.create_index(op.f("ix_tracked_issues_doc_no"), "tracked_issues", ["doc_no"], unique=False)
    op.create_index(op.f("ix_tracked_issues_status"), "tracked_issues", ["status"], unique=False)
    op.create_index(op.f("ix_tracked_issues_vendor_code"), "tracked_issues", ["vendor_code"], unique=False)
    op.create_index("ix_tracked_issues_status_company", "tracked_issues", ["status", "company_code"], unique=False)
    op.create_index("ix_tracked_issues_company_doc", "tracked_issues", ["company_code", "doc_no"], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_tracked_issues_company_doc", table_name="tracked_issues")
    op.drop_index("ix_tracked_issues_status_company", table_name="tracked_issues")
    op.drop_index(op.f("ix_tracked_issues_vendor_code"), table_name="tracked_issues")
    op.drop_index(op.f("ix_tracked_issues_status"), table_name="tracked_issues")
    op.drop_index(op.f("ix_tracked_issues_doc_no"), table_name="tracked_issues")
    op.drop_index(op.f("ix_tracked_issues_company_code"), table_name="tracked_issues")
    op.drop_index(op.f("ix_tracked_issues_issue_key"), table_name="tracked_issues")
    op.drop_index(op.f("ix_tracked_issues_id"), table_name="tracked_issues")
    op.drop_table("tracked_issues")
    op.drop_index(op.f("ix_rule_runs_created_at"), table_name="rule_runs")
    op.drop_index(op.f("ix_rule_runs_id"), table_name="rule_runs")
    op.drop_table("rule_runs")
