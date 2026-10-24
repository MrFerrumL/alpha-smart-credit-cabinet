"""Очередь задач конвейера в основной БД (transactional outbox).

Задача ставится в той же транзакции, что и смена статуса заявки, поэтому шаг не теряется, даже если
воркер упадёт сразу после коммита. В PostgreSQL несколько воркеров разбирают очередь параллельно
благодаря SELECT … FOR UPDATE SKIP LOCKED.
"""

from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Job, utcnow

# Самый долгий шаг — обогащение: три источника подряд, у каждого до INTEGRATION_RETRIES (3) попыток по
# INTEGRATION_TIMEOUT_S (3 с) с паузами 0,2 и 0,4 с, итого около 30 с. Две минуты — запас больше чем вчетверо;
# при больших таймаутах или числе попыток порог нужно поднять.
STALE_AFTER = timedelta(minutes=2)
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


def recover_stale(db: Session) -> int:
    """Задачи, которые «застряли» в running (воркер упал посреди шага), возвращаются в очередь. Если упала
    последняя попытка, задача сразу идёт по пути исчерпания, как в runner: шаг, который каждый раз роняет
    воркер, не крутится по кругу."""
    from app.pipeline.runner import exhaust  # runner сам импортирует очередь

    max_attempts = get_settings().pipeline_max_attempts
    stale = (Job.status == "running", Job.updated_at < utcnow() - STALE_AFTER)
    requeued = db.execute(
        update(Job).where(*stale, Job.attempts < max_attempts).values(status="pending", run_after=utcnow())
    ).rowcount or 0
    query = select(Job).where(*stale, Job.attempts >= max_attempts).order_by(Job.id)
    if db.get_bind().dialect.name == "postgresql":
        query = query.with_for_update(skip_locked=True)
    exhausted = db.scalars(query).all()
    for job in exhausted:
        # Ошибка прошлой попытки сохраняется: по ней выдача решает, повторять ли перевод через АБС.
        exhaust(db, job, f"{job.last_error}; {WORKER_STOPPED}" if job.last_error else WORKER_STOPPED)
    db.commit()
    return requeued + len(exhausted)
