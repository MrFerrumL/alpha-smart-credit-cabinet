"""initial schema

Revision ID: 0001
Revises: 
Create Date: 2026-10-22 17:17:58.562448
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0001'
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('companies',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('inn', sa.String(length=12), nullable=False),
    sa.Column('name', sa.String(length=255), nullable=False),
    sa.Column('short_name', sa.String(length=255), nullable=False),
    sa.Column('legal_form', sa.String(length=16), nullable=False),
    sa.Column('ogrn', sa.String(length=15), nullable=True),
    sa.Column('registered_at', sa.Date(), nullable=True),
    sa.Column('okved', sa.String(length=16), nullable=True),
    sa.Column('okved_name', sa.String(length=255), nullable=True),
    sa.Column('address', sa.String(length=512), nullable=True),
    sa.Column('director', sa.String(length=255), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('companies', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_companies_inn'), ['inn'], unique=True)

    op.create_table('users',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('email', sa.String(length=255), nullable=False),
    sa.Column('full_name', sa.String(length=255), nullable=False),
    sa.Column('position', sa.String(length=255), nullable=False),
    sa.Column('role', sa.String(length=16), nullable=False),
    sa.Column('can_sign', sa.Boolean(), nullable=False),
    sa.Column('password_hash', sa.String(length=255), nullable=False),
    sa.Column('company_id', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['company_id'], ['companies.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_users_email'), ['email'], unique=True)

    op.create_table('applications',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('number', sa.String(length=32), nullable=True),
    sa.Column('company_id', sa.Integer(), nullable=False),
    sa.Column('created_by_id', sa.Integer(), nullable=False),
    sa.Column('product_code', sa.String(length=32), nullable=False),
    sa.Column('purpose', sa.String(length=32), nullable=False),
    sa.Column('amount', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('term_months', sa.Integer(), nullable=False),
    sa.Column('status', sa.String(length=32), nullable=False),
    sa.Column('form', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('submit_key', sa.String(length=64), nullable=True),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('submitted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['company_id'], ['companies.id'], ),
    sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('number'),
    sa.UniqueConstraint('submit_key')
    )
    with op.batch_alter_table('applications', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_applications_company_id'), ['company_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_applications_status'), ['status'], unique=False)

    op.create_table('application_events',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('application_id', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('actor_type', sa.String(length=16), nullable=False),
    sa.Column('actor_id', sa.Integer(), nullable=True),
    sa.Column('event', sa.String(length=64), nullable=False),
    sa.Column('from_status', sa.String(length=32), nullable=True),
    sa.Column('to_status', sa.String(length=32), nullable=True),
    sa.Column('comment', sa.Text(), nullable=True),
    sa.Column('payload', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.ForeignKeyConstraint(['actor_id'], ['users.id'], ),
    sa.ForeignKeyConstraint(['application_id'], ['applications.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('application_events', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_application_events_application_id'), ['application_id'], unique=False)

    op.create_table('check_results',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('application_id', sa.Integer(), nullable=False),
    sa.Column('source', sa.String(length=16), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('data', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('attempts', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['application_id'], ['applications.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('check_results', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_check_results_application_id'), ['application_id'], unique=False)

    op.create_table('client_tasks',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('application_id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('title', sa.String(length=255), nullable=False),
    sa.Column('description', sa.Text(), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('answer', sa.Text(), nullable=True),
    sa.Column('created_by_type', sa.String(length=16), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['application_id'], ['applications.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('client_tasks', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_client_tasks_application_id'), ['application_id'], unique=False)

    op.create_table('documents',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('company_id', sa.Integer(), nullable=False),
    sa.Column('application_id', sa.Integer(), nullable=True),
    sa.Column('kind', sa.String(length=32), nullable=False),
    sa.Column('filename', sa.String(length=255), nullable=False),
    sa.Column('content_type', sa.String(length=128), nullable=False),
    sa.Column('size_bytes', sa.Integer(), nullable=False),
    sa.Column('storage_key', sa.String(length=512), nullable=False),
    sa.Column('uploaded_by_id', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['application_id'], ['applications.id'], ),
    sa.ForeignKeyConstraint(['company_id'], ['companies.id'], ),
    sa.ForeignKeyConstraint(['uploaded_by_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('documents', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_documents_application_id'), ['application_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_documents_company_id'), ['company_id'], unique=False)

    op.create_table('jobs',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=32), nullable=False),
    sa.Column('application_id', sa.Integer(), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('attempts', sa.Integer(), nullable=False),
    sa.Column('run_after', sa.DateTime(timezone=True), nullable=False),
    sa.Column('last_error', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['application_id'], ['applications.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('jobs', schema=None) as batch_op:
        batch_op.create_index('ix_jobs_status_run_after', ['status', 'run_after'], unique=False)

    op.create_table('offers',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('application_id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('product_code', sa.String(length=32), nullable=False),
    sa.Column('amount', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('term_months', sa.Integer(), nullable=False),
    sa.Column('rate', sa.Numeric(precision=5, scale=2), nullable=False),
    sa.Column('monthly_payment', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('explanation', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('valid_until', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('accepted_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['application_id'], ['applications.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('offers', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_offers_application_id'), ['application_id'], unique=False)

    op.create_table('scoring_results',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('application_id', sa.Integer(), nullable=False),
    sa.Column('method', sa.String(length=16), nullable=False),
    sa.Column('model_version', sa.String(length=64), nullable=False),
    sa.Column('probability_default', sa.Numeric(precision=6, scale=4), nullable=True),
    sa.Column('score', sa.Integer(), nullable=True),
    sa.Column('grade', sa.String(length=2), nullable=False),
    sa.Column('factors', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['application_id'], ['applications.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('scoring_results', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_scoring_results_application_id'), ['application_id'], unique=False)



def downgrade() -> None:
    with op.batch_alter_table('scoring_results', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_scoring_results_application_id'))

    op.drop_table('scoring_results')
    with op.batch_alter_table('offers', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_offers_application_id'))

    op.drop_table('offers')
    with op.batch_alter_table('jobs', schema=None) as batch_op:
        batch_op.drop_index('ix_jobs_status_run_after')

    op.drop_table('jobs')
    with op.batch_alter_table('documents', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_documents_company_id'))
        batch_op.drop_index(batch_op.f('ix_documents_application_id'))

    op.drop_table('documents')
    with op.batch_alter_table('client_tasks', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_client_tasks_application_id'))

    op.drop_table('client_tasks')
    with op.batch_alter_table('check_results', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_check_results_application_id'))

    op.drop_table('check_results')
    with op.batch_alter_table('application_events', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_application_events_application_id'))

    op.drop_table('application_events')
    with op.batch_alter_table('applications', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_applications_status'))
        batch_op.drop_index(batch_op.f('ix_applications_company_id'))

    op.drop_table('applications')
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_users_email'))

    op.drop_table('users')
    with op.batch_alter_table('companies', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_companies_inn'))

    op.drop_table('companies')
