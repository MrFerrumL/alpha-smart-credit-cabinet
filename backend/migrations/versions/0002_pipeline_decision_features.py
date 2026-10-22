"""pipeline decision, scoring features, task payload

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-22 19:01:45.585069
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0002'
down_revision: str | None = '0001'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table('applications', schema=None) as batch_op:
        batch_op.add_column(sa.Column('decision', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=True))

    with op.batch_alter_table('client_tasks', schema=None) as batch_op:
        batch_op.add_column(sa.Column('payload', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=True))

    with op.batch_alter_table('scoring_results', schema=None) as batch_op:
        batch_op.add_column(sa.Column('features', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=True))



def downgrade() -> None:
    with op.batch_alter_table('scoring_results', schema=None) as batch_op:
        batch_op.drop_column('features')

    with op.batch_alter_table('client_tasks', schema=None) as batch_op:
        batch_op.drop_column('payload')

    with op.batch_alter_table('applications', schema=None) as batch_op:
        batch_op.drop_column('decision')

