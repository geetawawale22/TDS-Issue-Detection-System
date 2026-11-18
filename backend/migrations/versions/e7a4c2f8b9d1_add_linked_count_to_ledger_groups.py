"""add linked_count to ledger_groups (clearing-only groups)

Revision ID: e7a4c2f8b9d1
Revises: d5e2b7c9a1f3
Create Date: 2026-11-16

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "e7a4c2f8b9d1"
down_revision: Union[str, Sequence[str], None] = "d5e2b7c9a1f3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("ledger_groups", sa.Column("linked_count", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("ledger_groups", "linked_count")
