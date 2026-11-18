"""add ledger lines and groups

Revision ID: d5e2b7c9a1f3
Revises: c3f8a1d6e4b7
Create Date: 2026-11-16 13:33:12.590563

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd5e2b7c9a1f3'
down_revision: Union[str, Sequence[str], None] = 'c3f8a1d6e4b7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Saved SAP lines and Document Ledger groups across runs (daily feed)."""
    op.create_table('ledger_groups',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('group_key', sa.String(length=200), nullable=False),
    sa.Column('company_code', sa.String(length=10), nullable=False),
    sa.Column('fiscal_year', sa.String(length=10), nullable=False),
    sa.Column('anchor_doc', sa.String(length=100), nullable=False),
    sa.Column('group_type', sa.String(length=30), nullable=False),
    sa.Column('open_item', sa.Boolean(), nullable=False),
    sa.Column('clearing_document', sa.String(length=50), nullable=True),
    sa.Column('assignment_number', sa.String(length=100), nullable=True),
    sa.Column('vendor_name', sa.String(length=255), nullable=True),
    sa.Column('vendor_code', sa.String(length=50), nullable=True),
    sa.Column('vendor_pan', sa.String(length=20), nullable=True),
    sa.Column('section', sa.String(length=100), nullable=True),
    sa.Column('invoice_amount', sa.Numeric(precision=18, scale=2), nullable=False),
    sa.Column('advance_amount', sa.Numeric(precision=18, scale=2), nullable=False),
    sa.Column('payment_amount', sa.Numeric(precision=18, scale=2), nullable=False),
    sa.Column('base_amount', sa.Numeric(precision=18, scale=2), nullable=False),
    sa.Column('adjustment_amount', sa.Numeric(precision=18, scale=2), nullable=False),
    sa.Column('debit_amount', sa.Numeric(precision=18, scale=2), nullable=False),
    sa.Column('credit_amount', sa.Numeric(precision=18, scale=2), nullable=False),
    sa.Column('net_amount', sa.Numeric(precision=18, scale=2), nullable=False),
    sa.Column('open_amount', sa.Numeric(precision=18, scale=2), nullable=False),
    sa.Column('tds_amount', sa.Numeric(precision=18, scale=2), nullable=False),
    sa.Column('event_count', sa.Integer(), nullable=False),
    sa.Column('issue_count', sa.Integer(), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('min_posting_date', sa.Date(), nullable=True),
    sa.Column('max_posting_date', sa.Date(), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('group_key')
    )
    op.create_index(op.f('ix_ledger_groups_company_code'), 'ledger_groups', ['company_code'], unique=False)
    op.create_index(op.f('ix_ledger_groups_status'), 'ledger_groups', ['status'], unique=False)
    op.create_table('ledger_lines',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('company_code', sa.String(length=10), nullable=False),
    sa.Column('fiscal_year', sa.String(length=10), nullable=False),
    sa.Column('doc_no', sa.String(length=50), nullable=False),
    sa.Column('line_item', sa.String(length=20), nullable=False),
    sa.Column('group_key', sa.String(length=200), nullable=False),
    sa.Column('clearing_document', sa.String(length=50), nullable=True),
    sa.Column('clearing_fiscal_year', sa.String(length=10), nullable=True),
    sa.Column('inferred_clearing_document', sa.String(length=50), nullable=True),
    sa.Column('inferred_clearing_fiscal_year', sa.String(length=10), nullable=True),
    sa.Column('reference_document', sa.String(length=50), nullable=True),
    sa.Column('assignment_number', sa.String(length=100), nullable=True),
    sa.Column('vendor_code', sa.String(length=50), nullable=True),
    sa.Column('vendor_name', sa.String(length=255), nullable=True),
    sa.Column('vendor_pan', sa.String(length=20), nullable=True),
    sa.Column('doc_type', sa.String(length=10), nullable=True),
    sa.Column('event_type', sa.String(length=30), nullable=True),
    sa.Column('posting_date', sa.Date(), nullable=True),
    sa.Column('gl_account', sa.String(length=30), nullable=True),
    sa.Column('profit_center', sa.String(length=50), nullable=True),
    sa.Column('section', sa.String(length=100), nullable=True),
    sa.Column('section_label', sa.String(length=150), nullable=True),
    sa.Column('amount', sa.Numeric(precision=18, scale=2), nullable=False),
    sa.Column('base_amount', sa.Numeric(precision=18, scale=2), nullable=True),
    sa.Column('tds_amount', sa.Numeric(precision=18, scale=2), nullable=False),
    sa.Column('sap_rate', sa.Numeric(precision=9, scale=4), nullable=True),
    sa.Column('ldc_certificate', sa.String(length=100), nullable=True),
    sa.Column('ldc_rate', sa.Numeric(precision=9, scale=4), nullable=True),
    sa.Column('ldc_expected_rate', sa.Numeric(precision=9, scale=4), nullable=True),
    sa.Column('rate_check_na', sa.Boolean(), nullable=False),
    sa.Column('self_clearing', sa.Boolean(), nullable=False),
    sa.Column('has_open_issue', sa.Boolean(), nullable=False),
    sa.Column('event', sa.Text(), nullable=False),
    sa.Column('first_run_id', sa.Integer(), nullable=True),
    sa.Column('last_run_id', sa.Integer(), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
    sa.ForeignKeyConstraint(['first_run_id'], ['rule_runs.id'], ),
    sa.ForeignKeyConstraint(['last_run_id'], ['rule_runs.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('company_code', 'fiscal_year', 'doc_no', 'line_item', name='uq_ledger_lines_identity')
    )
    op.create_index('ix_ledger_lines_company_doc', 'ledger_lines', ['company_code', 'doc_no'], unique=False)
    op.create_index('ix_ledger_lines_company_reference', 'ledger_lines', ['company_code', 'reference_document'], unique=False)
    op.create_index(op.f('ix_ledger_lines_group_key'), 'ledger_lines', ['group_key'], unique=False)
    op.create_index(op.f('ix_ledger_lines_posting_date'), 'ledger_lines', ['posting_date'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_ledger_lines_posting_date'), table_name='ledger_lines')
    op.drop_index(op.f('ix_ledger_lines_group_key'), table_name='ledger_lines')
    op.drop_index('ix_ledger_lines_company_reference', table_name='ledger_lines')
    op.drop_index('ix_ledger_lines_company_doc', table_name='ledger_lines')
    op.drop_table('ledger_lines')
    op.drop_index(op.f('ix_ledger_groups_status'), table_name='ledger_groups')
    op.drop_index(op.f('ix_ledger_groups_company_code'), table_name='ledger_groups')
    op.drop_table('ledger_groups')
