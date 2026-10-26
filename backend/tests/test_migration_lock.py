"""Миграции под рекомендательной блокировкой PostgreSQL: две реплики не применяют их одновременно."""

import os
import runpy
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest
from alembic import context as alembic_context
from sqlalchemy import inspect, text

from app.db import engine

BACKEND = Path(__file__).resolve().parents[1]
ENV = BACKEND / "migrations" / "env.py"
LOCK = "SELECT pg_advisory_xact_lock(727001)"


def run_env(monkeypatch, dialect_name: str) -> list[str]:
    """Выполняет migrations/env.py с подставным alembic и подставным соединением; возвращает порядок вызовов."""
    calls: list[str] = []

    class Connection:
        dialect = SimpleNamespace(name=dialect_name)

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, statement):
            calls.append(str(statement))

    @contextmanager
    def transaction():
        calls.append("begin")
        yield
        calls.append("commit")

    fake_context = {
        "config": SimpleNamespace(
            config_file_name=None,
            config_ini_section="alembic",
            set_main_option=lambda *args: None,
            get_section=lambda *args: {},
            get_main_option=lambda *args: "",
        ),
        "is_offline_mode": lambda: False,
        "configure": lambda **kwargs: calls.append("configure"),
        "begin_transaction": transaction,
        "run_migrations": lambda: calls.append("migrate"),
    }
    for name, value in fake_context.items():
        monkeypatch.setattr(alembic_context, name, value, raising=False)
    monkeypatch.setattr("sqlalchemy.engine_from_config", lambda *args, **kwargs: SimpleNamespace(connect=Connection))
    runpy.run_path(str(ENV))
    return calls


def test_postgresql_takes_the_advisory_lock_inside_the_transaction_before_migrating(monkeypatch):
    assert run_env(monkeypatch, "postgresql") == ["configure", "begin", LOCK, "migrate", "commit"]


def test_other_databases_migrate_without_the_lock(monkeypatch):
    assert run_env(monkeypatch, "sqlite") == ["configure", "begin", "migrate", "commit"]


@pytest.mark.skipif(engine.dialect.name != "postgresql", reason="рекомендательные блокировки есть только в PostgreSQL")
def test_second_migration_run_waits_until_the_first_one_commits():
    with engine.connect() as probe:
        if not inspect(probe).has_table("alembic_version"):
            pytest.skip("схема создана не миграциями (alembic upgrade head)")
    waiting = "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = 727001"
    holder = engine.connect()
    process = None
    try:
        holder.execute(text(LOCK))  # «первая реплика» держит блокировку, пока её транзакция не завершена
        process = subprocess.Popen(
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            cwd=BACKEND, env=os.environ, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        deadline = time.monotonic() + 30
        with engine.connect() as probe:
            while not probe.execute(text(waiting)).scalar():
                assert process.poll() is None, f"alembic завершился, не дожидаясь блокировки: {process.stdout.read()}"
                assert time.monotonic() < deadline, "alembic не дошёл до ожидания блокировки"
                time.sleep(0.2)
            probe.rollback()
        assert process.poll() is None  # вторая реплика стоит на блокировке и ничего не применяет
    finally:
        holder.rollback()  # конец транзакции снимает блокировку
        holder.close()
    output, _ = process.communicate(timeout=60)
    assert process.returncode == 0, output
