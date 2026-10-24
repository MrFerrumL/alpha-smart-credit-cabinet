"""decision explanations (LLM, optional)

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-23 12:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0005'
down_revision: str | None = '0004'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('decision_explanations',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('application_id', sa.Integer(), nullable=False),
    sa.Column('decision_event_id', sa.Integer(), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('facts', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=True),
    sa.Column('prompt_version', sa.String(length=32), nullable=True),
    sa.Column('model', sa.String(length=128), nullable=True),
    sa.Column('text', sa.Text(), nullable=True),
    sa.Column('error', sa.String(length=64), nullable=True),
    sa.Column('raw_response', sa.Text(), nullable=True),
    sa.Column('latency_ms', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['application_id'], ['applications.id'], ),
    sa.ForeignKeyConstraint(['decision_event_id'], ['application_events.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('decision_event_id')
    )
    with op.batch_alter_table('decision_explanations', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_decision_explanations_application_id'), ['application_id'], unique=False)
        batch_op.create_index('ix_decision_explanations_status_id', ['status', 'id'], unique=False)



def downgrade() -> None:
    with op.batch_alter_table('decision_explanations', schema=None) as batch_op:
        batch_op.drop_index('ix_decision_explanations_status_id')
        batch_op.drop_index(batch_op.f('ix_decision_explanations_application_id'))

    op.drop_table('decision_explanations')
