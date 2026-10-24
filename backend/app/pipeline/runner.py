"""Выполнение задач конвейера: взять задачу, выполнить шаг, при сбое — повторить с паузой."""

import logging
from collections.abc import Callable
from datetime import timedelta

from sqlalchemy.orm import Session

from app.config import get_settings
from app.domain.statuses import Actor
from app.models import Application, Job, utcnow
from app.pipeline.queue import claim_next
from app.pipeline.steps import ON_EXHAUSTED, STEPS, RetryLater
from app.services.integrations import ExternalSources
from app.services.state_machine import record_event

log = logging.getLogger("app.pipeline")

SessionFactory = Callable[[], Session]


def _finish(db: Session, job_id: int, status: str, error: str | None = None) -> None:
    job = db.get(Job, job_id)
    job.status = status
    job.last_error = error
    db.commit()


def _retry_or_fail(session_factory: SessionFactory, job_id: int, error: str) -> None:
    settings = get_settings()
    with session_factory() as db:
        job = db.get(Job, job_id)
        if job.attempts < settings.pipeline_max_attempts:
            job.status = "pending"
            job.last_error = error
            job.run_after = utcnow() + timedelta(seconds=settings.pipeline_retry_base_s * 2 ** (job.attempts - 1))
            db.commit()
            log.warning(
                "pipeline step postponed",
                extra={"job": job.kind, "application_id": job.application_id, "error": error},
            )
            return
        app = db.get(Application, job.application_id)
        handler = ON_EXHAUSTED.get(job.kind)
        expected, _ = STEPS[job.kind]
        if handler and app is not None and app.status == expected.value:
            handler(db, app, error)
        elif app is not None:
            record_event(db, app, "pipeline_failed", Actor.SYSTEM, payload={"step": job.kind, "error": error})
        job.status = "failed"
        job.last_error = error
        db.commit()
        log.error("pipeline step failed", extra={"job": job.kind, "application_id": job.application_id, "error": error})


def process_next(session_factory: SessionFactory, sources: ExternalSources) -> bool:
    """Выполняет одну задачу. Возвращает False, если выполнять нечего."""
    with session_factory() as db:
        job = claim_next(db)
        if job is None:
            return False
        job_id, kind, application_id = job.id, job.kind, job.application_id

    with session_factory() as db:
        app = db.get(Application, application_id)
        expected, step = STEPS[kind]
        if app is None or app.status != expected.value:
            # Заявка уже ушла с этого этапа (например, клиент её отозвал) — шаг не нужен.
            _finish(db, job_id, "done", f"skipped: status {app.status if app else 'missing'}")
            return True
        try:
            step(db, app, sources)
            db.commit()
        except RetryLater as exc:
            db.rollback()
            _retry_or_fail(session_factory, job_id, str(exc))
            return True
        except Exception as exc:  # noqa: BLE001 — любой сбой шага не должен ронять воркер
            db.rollback()
            log.exception("pipeline step crashed")
            _retry_or_fail(session_factory, job_id, f"{exc.__class__.__name__}: {exc}")
            return True
        _finish(db, job_id, "done")
    return True


def run_until_idle(session_factory: SessionFactory, sources: ExternalSources, limit: int = 200) -> int:
    """Выполняет задачи, пока они есть и готовы к запуску. Используется в тестах."""
    done = 0
    while done < limit and process_next(session_factory, sources):
        done += 1
    return done

