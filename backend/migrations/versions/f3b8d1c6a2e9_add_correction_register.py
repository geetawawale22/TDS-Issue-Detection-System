"""add correction register (correction_groups, correction_entries)

Revision ID: f3b8d1c6a2e9
Revises: e7a4c2f8b9d1
Create Date: 2026-11-18

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "f3b8d1c6a2e9"
down_revision: Union[str, Sequence[str], None] = "e7a4c2f8b9d1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Manual correction register, moved out of the browser into the database."""
    op.create_table(
        "correction_groups",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("group_code", sa.String(length=20), nullable=True),
        sa.Column("issue_key", sa.String(length=64), nullable=True),
        sa.Column("company_code", sa.String(length=10), nullable=False, server_default=""),
        sa.Column("fiscal_year", sa.String(length=10), nullable=False, server_default=""),
        sa.Column("original_doc_no", sa.String(length=50), nullable=False),
        sa.Column("original_line_item", sa.String(length=20), nullable=False, server_default=""),
        sa.Column("category", sa.String(length=150), nullable=True),
        sa.Column("vendor_code", sa.String(length=50), nullable=True),
        sa.Column("vendor_name", sa.String(length=255), nullable=True),
        sa.Column("vendor_pan", sa.String(length=20), nullable=True),
        sa.Column("section", sa.String(length=50), nullable=True),
        sa.Column("base_amount", sa.Numeric(precision=18, scale=2), nullable=True),
        sa.Column("applied_rate", sa.Numeric(precision=9, scale=4), nullable=True),
        sa.Column("expected_rate", sa.Numeric(precision=9, scale=4), nullable=True),
        sa.Column("applied_tds", sa.Numeric(precision=18, scale=2), nullable=False, server_default="0"),
        sa.Column("expected_tds", sa.Numeric(precision=18, scale=2), nullable=False, server_default="0"),
        sa.Column("method", sa.String(length=30), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="matched_in_sap"),
        sa.Column("remarks", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.Column("status_changed_by", sa.Integer(), nullable=True),
        sa.Column("status_changed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status_note", sa.Text(), nullable=True),
        sa.Column("previous_issue_state", sa.Text(), nullable=True),
        sa.Column("legacy_group_id", sa.String(length=30), nullable=True),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["status_changed_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_correction_groups_id"), "correction_groups", ["id"], unique=False)
    op.create_index(op.f("ix_correction_groups_group_code"), "correction_groups", ["group_code"], unique=True)
    op.create_index(op.f("ix_correction_groups_issue_key"), "correction_groups", ["issue_key"], unique=False)
    op.create_index(op.f("ix_correction_groups_company_code"), "correction_groups", ["company_code"], unique=False)
    op.create_index(op.f("ix_correction_groups_original_doc_no"), "correction_groups", ["original_doc_no"], unique=False)
    op.create_index(op.f("ix_correction_groups_status"), "correction_groups", ["status"], unique=False)
    op.create_index(op.f("ix_correction_groups_created_at"), "correction_groups", ["created_at"], unique=False)

    op.create_table(
        "correction_entries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("group_id", sa.Integer(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("role", sa.String(length=30), nullable=False),
        sa.Column("company_code", sa.String(length=10), nullable=False, server_default=""),
        sa.Column("fiscal_year", sa.String(length=10), nullable=False, server_default=""),
        sa.Column("doc_no", sa.String(length=50), nullable=False),
        sa.Column("line_item", sa.String(length=20), nullable=False, server_default=""),
        sa.Column("doc_type", sa.String(length=10), nullable=True),
        sa.Column("posting_date", sa.Date(), nullable=True),
        sa.Column("vendor_code", sa.String(length=50), nullable=True),
        sa.Column("vendor_name", sa.String(length=255), nullable=True),
        sa.Column("section", sa.String(length=50), nullable=True),
        sa.Column("base_amount", sa.Numeric(precision=18, scale=2), nullable=True),
        sa.Column("applied_rate", sa.Numeric(precision=9, scale=4), nullable=True),
        sa.Column("tds_amount", sa.Numeric(precision=18, scale=2), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(["group_id"], ["correction_groups.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_correction_entries_id"), "correction_entries", ["id"], unique=False)
    op.create_index(op.f("ix_correction_entries_group_id"), "correction_entries", ["group_id"], unique=False)
    op.create_index(op.f("ix_correction_entries_doc_no"), "correction_entries", ["doc_no"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_correction_entries_doc_no"), table_name="correction_entries")
    op.drop_index(op.f("ix_correction_entries_group_id"), table_name="correction_entries")
    op.drop_index(op.f("ix_correction_entries_id"), table_name="correction_entries")
    op.drop_table("correction_entries")
    op.drop_index(op.f("ix_correction_groups_created_at"), table_name="correction_groups")
    op.drop_index(op.f("ix_correction_groups_status"), table_name="correction_groups")
    op.drop_index(op.f("ix_correction_groups_original_doc_no"), table_name="correction_groups")
    op.drop_index(op.f("ix_correction_groups_company_code"), table_name="correction_groups")
    op.drop_index(op.f("ix_correction_groups_issue_key"), table_name="correction_groups")
    op.drop_index(op.f("ix_correction_groups_group_code"), table_name="correction_groups")
    op.drop_index(op.f("ix_correction_groups_id"), table_name="correction_groups")
    op.drop_table("correction_groups")
