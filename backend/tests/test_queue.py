"""Задачи упавшего воркера: возвращаются в очередь быстро, а последняя попытка не крутится по кругу."""

from datetime import timedelta

from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal
from app.models import Job, utcnow
from app.pipeline.queue import STALE_AFTER, WORKER_STOPPED, recover_stale
from app.pipeline.runner import process_next
from app.pipeline.steps import SOURCES
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


def _job(app_id: int, kind: str, status: str = "pending") -> Job:
    with SessionLocal() as db:
        query = select(Job).where(Job.application_id == app_id, Job.kind == kind, Job.status == status)
        return db.scalar(query.order_by(Job.id.desc()).limit(1))


def _in_validation(client, mocks) -> tuple[int, dict, int]:
    run_pipeline(mocks)  # готовые задачи других тестов не должны попасть под process_next
    app_id, headers = submit(client, "bakery@demo.local")
    process_next(SessionLocal, ExternalSources(mocks, timeout=2, retries=1, backoff=0))  # submitted → validation
    return app_id, headers, _job(app_id, "pipeline.validate").id


def test_stale_threshold_outlasts_the_slowest_step():
    s = get_settings()
    backoff = sum(0.2 * 2**i for i in range(s.integration_retries - 1))
    slowest = len(SOURCES) * (s.integration_retries * s.integration_timeout_s + backoff)  # обогащение, ≈29 с
    assert slowest * 4 <= STALE_AFTER.total_seconds() < 5 * 60


def test_job_of_a_crashed_worker_returns_to_the_queue_after_the_threshold(client, mocks):
    app_id, headers, job_id = _in_validation(client, mocks)
    _stuck(job_id, attempts=1, for_=STALE_AFTER - timedelta(seconds=30))
    _recover()
    assert _job(app_id, "pipeline.validate", "running").id == job_id  # шаг ещё может идти — не трогаем

    _stuck(job_id, attempts=1, for_=STALE_AFTER + timedelta(seconds=1))
    _recover()
    assert _job(app_id, "pipeline.validate").id == job_id
    run_pipeline(mocks)
    assert get(client, app_id, headers)["status"]["code"] == "approved"


def test_lost_last_attempt_goes_straight_to_the_exhausted_path(client, mocks):
    app_id, headers, job_id = _in_validation(client, mocks)
    _stuck(job_id, attempts=get_settings().pipeline_max_attempts, for_=STALE_AFTER * 2)
    _recover()
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        assert (job.status, job.last_error) == ("failed", WORKER_STOPPED)
    run_pipeline(mocks)  # шаг больше не запускается: заявка у специалиста, как после последней неудачной попытки
    assert get(client, app_id, headers)["status"]["code"] == "manual_review"
    card = client.get(f"/api/applications/{app_id}/assessment", headers=auth(client, "analyst@demo.local")).json()
    assert card["review_reason"] == "pipeline_failure"


def test_lost_last_disbursement_attempt_after_bank_outage_is_retried_later(client, mocks):
    app_id, headers = approved(client, mocks)
    client.post(f"/api/applications/{app_id}/offer/accept", headers=headers)
    sign(client, app_id, headers)
    job_id = _job(app_id, "pipeline.disburse").id
    _stuck(job_id, attempts=get_settings().pipeline_max_attempts, for_=STALE_AFTER * 2, last_error="abs: timeout")
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
