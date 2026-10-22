"""signing loans notifications

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-22 21:58:47.312189
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '0003'
down_revision: str | None = '0002'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('notifications',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=32), nullable=False),
    sa.Column('title', sa.String(length=255), nullable=False),
    sa.Column('body', sa.Text(), nullable=True),
    sa.Column('link', sa.String(length=255), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('read_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('notifications', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_notifications_user_id'), ['user_id'], unique=False)

    op.create_table('loans',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('application_id', sa.Integer(), nullable=False),
    sa.Column('company_id', sa.Integer(), nullable=False),
    sa.Column('contract_number', sa.String(length=32), nullable=False),
    sa.Column('product_code', sa.String(length=32), nullable=False),
    sa.Column('amount', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('rate', sa.Numeric(precision=5, scale=2), nullable=False),
    sa.Column('term_months', sa.Integer(), nullable=False),
    sa.Column('monthly_payment', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('repayment', sa.String(length=16), nullable=False),
    sa.Column('issued_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('first_payment_date', sa.Date(), nullable=False),
    sa.Column('payment_ref', sa.String(length=64), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['application_id'], ['applications.id'], ),
    sa.ForeignKeyConstraint(['company_id'], ['companies.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('application_id'),
    sa.UniqueConstraint('contract_number')
    )
    with op.batch_alter_table('loans', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_loans_company_id'), ['company_id'], unique=False)

    op.create_table('signing_challenges',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('application_id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('code_hash', sa.String(length=64), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('attempts_left', sa.Integer(), nullable=False),
    sa.Column('used_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['application_id'], ['applications.id'], ),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('signing_challenges', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_signing_challenges_application_id'), ['application_id'], unique=False)

    with op.batch_alter_table('offers', schema=None) as batch_op:
        batch_op.add_column(sa.Column('contract_number', sa.String(length=32), nullable=True))
        batch_op.add_column(sa.Column('signed_at', sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column('signed_by_id', sa.Integer(), nullable=True))
        batch_op.create_unique_constraint('uq_offers_contract_number', ['contract_number'])
        batch_op.create_foreign_key('fk_offers_signed_by_id_users', 'users', ['signed_by_id'], ['id'])



def downgrade() -> None:
    with op.batch_alter_table('offers', schema=None) as batch_op:
        # WARNING: constraint name is None; this directive will fail as
        # rendered.  Add a name, or use a naming convention; see
        # https://alembic.sqlalchemy.org/en/latest/naming.html
        batch_op.drop_constraint('fk_offers_signed_by_id_users', type_='foreignkey')
        # WARNING: constraint name is None; this directive will fail as
        # rendered.  Add a name, or use a naming convention; see
        # https://alembic.sqlalchemy.org/en/latest/naming.html
        batch_op.drop_constraint('uq_offers_contract_number', type_='unique')
        batch_op.drop_column('signed_by_id')
        batch_op.drop_column('signed_at')
        batch_op.drop_column('contract_number')

    with op.batch_alter_table('signing_challenges', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_signing_challenges_application_id'))

    op.drop_table('signing_challenges')
    with op.batch_alter_table('loans', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_loans_company_id'))

    op.drop_table('loans')
    with op.batch_alter_table('notifications', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_notifications_user_id'))

    op.drop_table('notifications')
