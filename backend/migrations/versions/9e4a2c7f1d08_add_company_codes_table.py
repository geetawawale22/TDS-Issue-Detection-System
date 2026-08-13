"""add company_codes table

Revision ID: 9e4a2c7f1d08
Revises: 4d140f3671b9
Create Date: 2026-08-14 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '9e4a2c7f1d08'
down_revision: Union[str, Sequence[str], None] = '4d140f3671b9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'company_codes',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('code', sa.String(length=10), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.PrimaryKeyConstraint('id', name=op.f('company_codes_pkey')),
    )
    op.create_index(op.f('ix_company_codes_id'), 'company_codes', ['id'], unique=False)
    op.create_index(op.f('ix_company_codes_code'), 'company_codes', ['code'], unique=True)

    # ---- seed the 3 in-scope company codes ----
    op.bulk_insert(
        sa.table(
            'company_codes',
            sa.column('code', sa.String),
            sa.column('name', sa.String),
            sa.column('is_active', sa.Boolean),
        ),
        [
            {"code": "1001", "name": None, "is_active": True},
            {"code": "1079", "name": None, "is_active": True},
            {"code": "1081", "name": None, "is_active": True},
        ],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_company_codes_code'), table_name='company_codes')
    op.drop_index(op.f('ix_company_codes_id'), table_name='company_codes')
    op.drop_table('company_codes')