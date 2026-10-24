"""Задачи упавшего воркера: возвращаются в очередь быстро, не выполняются дважды и не крутятся по кругу."""

from datetime import timedelta

from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal
from app.models import Job, utcnow
from app.pipeline import runner
from app.pipeline.queue import WORKER_STOPPED, exhaust_stale, recover_stale, stale_after
from app.pipeline.runner import process_next
from app.pipeline.steps import SOURCES, STEPS
from app.services.integrations import ExternalSources
from tests.conftest import auth, run_pipeline
from tests.test_pipeline import events, get, submit
from tests.test_signing import approved, sign


def _stuck(job_id: int, *, attempts: int, for_: timedelta, last_error: str | None = None) -> None:
    """Воркер взял задачу и упал посреди шага: она так и осталась running."""
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        job.status, job.attempts, job.last_error, job.updated_at = "running", attempts, last_error, utcnow() - for_
        db.commit()


def _recover() -> None:
    with SessionLocal() as db:
        recover_stale(db)


def _job(app_id: int, kind: str, status: str = "pending") -> Job | None:
    with SessionLocal() as db:
        query = select(Job).where(Job.application_id == app_id, Job.kind == kind, Job.status == status)
        return db.scalar(query.order_by(Job.id.desc()).limit(1))


def _in_validation(client, mocks) -> tuple[int, dict, int]:
    run_pipeline(mocks)  # готовые задачи других тестов не должны попасть под process_next
    app_id, headers = submit(client, "bakery@demo.local")
    _process_one(mocks)  # submitted → validation
    return app_id, headers, _job(app_id, "pipeline.validate").id


def _process_one(mocks) -> None:
    process_next(SessionLocal, ExternalSources(mocks, timeout=2, retries=1, backoff=0))


def test_stale_threshold_outlasts_the_slowest_step(monkeypatch):
    assert stale_after() == timedelta(minutes=2)  # по умолчанию самый долгий шаг — около 30 с
    settings = get_settings()
    monkeypatch.setattr(settings, "integration_timeout_s", 30.0)
    slowest = len(SOURCES) * (settings.integration_retries * 30.0 + 0.6) + settings.pipeline_step_delay_s
    assert stale_after().total_seconds() >= 3 * slowest


def test_job_of_a_crashed_worker_returns_to_the_queue_after_the_threshold(client, mocks):
    app_id, headers, job_id = _in_validation(client, mocks)
    _stuck(job_id, attempts=1, for_=stale_after() - timedelta(seconds=30))
    _recover()
    assert _job(app_id, "pipeline.validate", "running").id == job_id  # шаг ещё может идти — не трогаем

    _stuck(job_id, attempts=1, for_=stale_after() + timedelta(seconds=1))
    _recover()
    assert _job(app_id, "pipeline.validate").id == job_id
    run_pipeline(mocks)
    assert get(client, app_id, headers)["status"]["code"] == "approved"


def test_lost_last_attempt_goes_straight_to_the_exhausted_path(client, mocks):
    app_id, headers, job_id = _in_validation(client, mocks)
    _stuck(job_id, attempts=get_settings().pipeline_max_attempts, for_=stale_after() * 2)
    _recover()
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        assert (job.status, job.last_error) == ("failed", WORKER_STOPPED)
    run_pipeline(mocks)  # шаг больше не запускается: заявка у специалиста, как после последней неудачной попытки
    assert get(client, app_id, headers)["status"]["code"] == "manual_review"
    card = client.get(f"/api/applications/{app_id}/assessment", headers=auth(client, "analyst@demo.local")).json()
    assert card["review_reason"] == "pipeline_failure"


def test_failing_recovery_of_one_job_does_not_block_the_others(client, mocks, monkeypatch):
    last = get_settings().pipeline_max_attempts
    broken_app, broken_headers, broken = _in_validation(client, mocks)
    _stuck(broken, attempts=last, for_=stale_after() * 2)
    exhausted_app, exhausted_headers, exhausted = _in_validation(client, mocks)
    _stuck(exhausted, attempts=last, for_=stale_after() * 2)
    requeued_app, requeued_headers, requeued = _in_validation(client, mocks)
    _stuck(requeued, attempts=1, for_=stale_after() * 2)

    real = runner.exhaust

    def exhaust(db, job, error):
        if job.id == broken:
            raise RuntimeError("handler misconfigured")
        real(db, job, error)

    monkeypatch.setattr(runner, "exhaust", exhaust)
    _recover()
    with SessionLocal() as db:
        job = db.get(Job, broken)
        # Сбойную задачу больше не подберут как брошенную: она закрыта с причиной.
        assert job.status == "failed" and job.last_error.startswith("recovery failed: RuntimeError")
        assert (db.get(Job, exhausted).status, db.get(Job, requeued).status) == ("failed", "pending")
    run_pipeline(mocks)
    assert get(client, exhausted_app, exhausted_headers)["status"]["code"] == "manual_review"
    assert get(client, requeued_app, requeued_headers)["status"]["code"] == "approved"
    assert get(client, broken_app, broken_headers)["status"]["code"] == "validation"


def test_job_touched_after_it_was_read_is_not_recovered(client, mocks):
    app_id, headers, job_id = _in_validation(client, mocks)
    _stuck(job_id, attempts=get_settings().pipeline_max_attempts, for_=stale_after() * 2)
    with SessionLocal() as db:
        seen = db.get(Job, job_id).updated_at
    # Между чтением и обработкой задачу обновил воркер — например, взял её снова и сейчас выполняет.
    _stuck(job_id, attempts=get_settings().pipeline_max_attempts, for_=timedelta(0))
    with SessionLocal() as db:
        assert exhaust_stale(db, job_id, seen) == 0
    assert _job(app_id, "pipeline.validate", "running").id == job_id
    assert get(client, app_id, headers)["status"]["code"] == "validation"

    with SessionLocal() as db:  # дальше задачу доводит «тот» воркер
        db.get(Job, job_id).status = "pending"
        db.commit()
    run_pipeline(mocks)
    assert get(client, app_id, headers)["status"]["code"] == "approved"


def test_slow_run_of_a_recovered_job_does_not_apply_its_result(client, mocks, monkeypatch):
    app_id, headers, job_id = _in_validation(client, mocks)
    expected, validate = STEPS["pipeline.validate"]

    def slow_validate(db, app, sources):
        # Пока шаг шёл, задачу сочли брошенной, вернули в очередь, и её взял другой воркер.
        with SessionLocal() as other:
            other.get(Job, job_id).attempts += 1
            other.commit()
        validate(db, app, sources)

    monkeypatch.setitem(STEPS, "pipeline.validate", (expected, slow_validate))
    _process_one(mocks)
    assert get(client, app_id, headers)["status"]["code"] == "validation"  # итог старого запуска не применён
    assert _job(app_id, "pipeline.enrich") is None
    assert _job(app_id, "pipeline.validate", "running").id == job_id  # задача осталась за другим запуском

    monkeypatch.setitem(STEPS, "pipeline.validate", (expected, validate))
    with SessionLocal() as db:
        db.get(Job, job_id).status = "pending"
        db.commit()
    run_pipeline(mocks)
    assert get(client, app_id, headers)["status"]["code"] == "approved"


def test_lost_last_disbursement_attempt_after_bank_outage_is_retried_later(client, mocks):
    app_id, headers = approved(client, mocks)
    client.post(f"/api/applications/{app_id}/offer/accept", headers=headers)
    sign(client, app_id, headers)
    job_id = _job(app_id, "pipeline.disburse").id
    _stuck(job_id, attempts=get_settings().pipeline_max_attempts, for_=stale_after() * 2, last_error="abs: timeout")
    _recover()
    # Договор подписан: выдача не бросается, а повторяется с длинной паузой, как после сбоя АБС.
    assert "disbursement_delayed" in events(client, app_id, headers)
    retry = _job(app_id, "pipeline.disburse")
    assert retry is not None and retry.id != job_id
    with SessionLocal() as db:
        db.get(Job, retry.id).run_after = utcnow()
        db.commit()
    run_pipeline(mocks)
    assert get(client, app_id, headers)["status"]["code"] == "issued"
