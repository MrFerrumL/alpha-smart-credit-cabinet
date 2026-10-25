"""/health/deps: версия, очередь конвейера и источники на паузе. Отвечает всегда, на готовность не влияет."""

from contextlib import contextmanager
from datetime import timedelta

from sqlalchemy import delete

from app import __version__
from app.api import health
from app.db import SessionLocal
from app.main import app
from app.models import Job, utcnow
from app.services.integrations import CircuitBreaker, get_breaker

SOURCES = {"egrul", "fns", "bki", "abs"}


@contextmanager
def jobs(*specs: dict):
    """Задачи в очереди на время проверки; без заявки, поэтому конвейер их не тронет, — и сразу убираются."""
    with SessionLocal() as db:
        rows = [Job(**({"kind": "pipeline.enrich"} | spec)) for spec in specs]
        db.add_all(rows)
        db.commit()
        ids = [row.id for row in rows]
    try:
        yield
    finally:
        with SessionLocal() as db:
            db.execute(delete(Job).where(Job.id.in_(ids)))
            db.commit()


def deps(client) -> dict:
    response = client.get("/health/deps")
    assert response.status_code == 200, response.text
    return response.json()


def test_deps_report_version_queue_and_sources(client):
    body = deps(client)
    assert body["version"] == __version__
    assert client.get("/api/openapi.json").json()["info"]["version"] == __version__
    assert set(body["queue"]) == {"pending", "running", "oldest_ready_age_s", "failed_last_hour"}
    assert set(body["sources"]) == SOURCES and set(body["sources"].values()) <= {"ok", "paused"}


def test_queue_counts_waiting_running_and_recently_failed_jobs(client):
    later = utcnow() + timedelta(hours=1)
    before = deps(client)["queue"]
    with jobs(
        {"status": "pending", "run_after": utcnow() - timedelta(seconds=90)},
        {"status": "pending", "run_after": later},  # отложенный повтор: ждёт, но ещё не пора
        {"status": "running"},
        {"status": "failed", "last_error": "bki: HTTP 503"},
        {"status": "failed", "updated_at": utcnow() - timedelta(hours=2)},  # давний сбой не считается
    ):
        after = deps(client)["queue"]
    assert after["pending"] == before["pending"] + 2
    assert after["running"] == before["running"] + 1
    assert after["failed_last_hour"] == before["failed_last_hour"] + 1
    assert after["oldest_ready_age_s"] >= 90


def test_open_breaker_of_this_process_pauses_its_source_but_not_readiness(client):
    breaker = CircuitBreaker(1, 60)
    breaker.record_failure("egrul")
    app.dependency_overrides[get_breaker] = lambda: breaker
    assert deps(client)["sources"] == {"egrul": "paused", "fns": "ok", "bki": "ok", "abs": "ok"}
    assert client.get("/health/ready").status_code == 200


def test_pause_in_the_worker_is_seen_through_its_postponed_jobs(client):
    app.dependency_overrides[get_breaker] = lambda: None  # предохранитель процесса API здесь ни при чём
    later = utcnow() + timedelta(hours=1)
    with jobs(
        {"status": "pending", "run_after": later, "last_error": "bki: circuit open"},
        {"kind": "pipeline.disburse", "status": "pending", "run_after": later, "last_error": "abs: circuit open"},
        # Давняя отложенная задача и задача, которая уже не ждёт повтора, о паузе не говорят.
        {"status": "pending", "run_after": later, "last_error": "fns: circuit open",
         "updated_at": utcnow() - timedelta(minutes=30)},
        {"status": "failed", "last_error": "egrul: circuit open"},
    ):
        sources = deps(client)["sources"]
    assert sources == {"egrul": "ok", "fns": "ok", "bki": "paused", "abs": "paused"}


def test_deps_answer_even_without_the_database(client, monkeypatch):
    def broken():
        raise RuntimeError("database is down")

    monkeypatch.setattr(health, "SessionLocal", broken)
    body = deps(client)
    assert body["queue"] is None
    assert body["version"] == __version__ and set(body["sources"]) == SOURCES
