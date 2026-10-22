"""submit_key is scoped to its application, not globally unique

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-23 00:30:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0004'
down_revision: str | None = '0003'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if op.get_context().dialect.name == "postgresql":
        op.drop_constraint("applications_submit_key_key", "applications", type_="unique")
        return
    # SQLite: ограничение без имени снимается пересозданием колонки (значения ключей не нужны для старых заявок).
    with op.batch_alter_table("applications") as batch_op:
        batch_op.drop_column("submit_key")
    with op.batch_alter_table("applications") as batch_op:
        batch_op.add_column(sa.Column("submit_key", sa.String(length=64), nullable=True))


def downgrade() -> None:
    # После upgrade ключи могли повториться в разных заявках — оставляем ключ только у самой ранней.
    op.execute(
        "UPDATE applications SET submit_key = NULL WHERE submit_key IS NOT NULL AND id NOT IN "
        "(SELECT MIN(id) FROM applications WHERE submit_key IS NOT NULL GROUP BY submit_key)"
    )
    with op.batch_alter_table("applications") as batch_op:
        batch_op.create_unique_constraint("applications_submit_key_key", ["submit_key"])
