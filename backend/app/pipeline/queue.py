"""Очередь задач конвейера в основной БД (transactional outbox).

Задача ставится в той же транзакции, что и смена статуса заявки, поэтому шаг не теряется, даже если
воркер упадёт сразу после коммита. В PostgreSQL несколько воркеров разбирают очередь параллельно
благодаря SELECT … FOR UPDATE SKIP LOCKED.
"""

import logging
from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Job, utcnow

log = logging.getLogger("app.pipeline")

WORKER_STOPPED = "worker stopped during the step"


def enqueue(db: Session, kind: str, application_id: int, *, delay_s: float = 0) -> Job:
    job = Job(kind=kind, application_id=application_id, run_after=utcnow() + timedelta(seconds=delay_s))
    db.add(job)
    return job


def claim_next(db: Session, now: datetime | None = None) -> Job | None:
    now = now or utcnow()
    query = (
        select(Job)
        .where(Job.status == "pending", Job.run_after <= now)
        .order_by(Job.run_after, Job.id)
        .limit(1)
    )
    if db.get_bind().dialect.name == "postgresql":
        query = query.with_for_update(skip_locked=True)
    job = db.scalar(query)
    if job is None:
        db.rollback()
        return None
    job.status = "running"
    job.attempts += 1
    db.commit()
    return job


def stale_after() -> timedelta:
    """Сколько задача может быть в running, прежде чем её сочтут брошенной упавшим воркером."""
    from app.pipeline.steps import SOURCES  # steps сам импортирует очередь

    s = get_settings()
    # Самый долгий шаг — обогащение: источники опрашиваются подряд, у каждого до integration_retries попыток по
    # integration_timeout_s с паузами 0,2·2ⁿ с между ними (ExternalSources), плюс pipeline_step_delay_s. По
    # умолчанию это около 30 с. Порог втрое больше (таймаут httpx действует на каждую фазу запроса отдельно) и не
    # меньше двух минут; если шаг всё же задержится дольше, его итог отбросит проверка в runner._finish.
    backoff = sum(0.2 * 2**n for n in range(s.integration_retries - 1))
    worst = len(SOURCES) * (s.integration_retries * s.integration_timeout_s + backoff) + s.pipeline_step_delay_s
    return timedelta(seconds=max(120.0, 3 * worst))


def recover_stale(db: Session) -> int:
    """Задачи, которые «застряли» в running (воркер упал посреди шага), возвращаются в очередь. Если упала
    последняя попытка, задача сразу идёт по пути исчерпания, как в runner: шаг, который каждый раз роняет
    воркер, не крутится по кругу."""
    max_attempts = get_settings().pipeline_max_attempts
    stale = (Job.status == "running", Job.updated_at < utcnow() - stale_after())
    # Условие проверяется в момент UPDATE: задачу, которую воркер успел закрыть, оно уже не пропустит.
    requeued = db.execute(
        update(Job).where(*stale, Job.attempts < max_attempts).values(status="pending", run_after=utcnow())
    ).rowcount or 0
    db.commit()
    exhausted = 0
    for job_id, kind, seen in db.execute(
        select(Job.id, Job.kind, Job.updated_at).where(*stale, Job.attempts >= max_attempts).order_by(Job.id)
    ).all():
        try:
            exhausted += exhaust_stale(db, job_id, seen)
        except Exception as exc:  # noqa: BLE001 — сбой на одной задаче не мешает остальным
            db.rollback()
            log.exception("stale job recovery failed", extra={"path": kind, "status": f"job {job_id}"})
            _take(db, job_id, seen, status="failed", last_error=f"recovery failed: {exc.__class__.__name__}: {exc}")
            db.commit()
    return requeued + exhausted


def _take(db: Session, job_id: int, seen: datetime, **values) -> bool:
    """Меняет задачу, только если с момента чтения её никто не трогал: она всё ещё running с тем же updated_at."""
    taken = update(Job).where(Job.id == job_id, Job.status == "running", Job.updated_at == seen).values(**values)
    return db.execute(taken).rowcount == 1


def exhaust_stale(db: Session, job_id: int, seen: datetime) -> int:
    """Брошенная задача с исчерпанными попытками — по пути исчерпания. 1 — обработана, 0 — её уже кто-то обновил."""
    from app.pipeline.runner import exhaust  # runner сам импортирует очередь

    if not _take(db, job_id, seen, status="failed"):
        db.rollback()
        return 0
    job = db.get(Job, job_id)
    # Ошибка прошлой попытки сохраняется: по ней выдача решает, повторять ли перевод через АБС.
    exhaust(db, job, f"{job.last_error}; {WORKER_STOPPED}" if job.last_error else WORKER_STOPPED)
    db.commit()
    return 1
