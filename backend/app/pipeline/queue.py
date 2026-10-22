"""Очередь задач конвейера в основной БД (transactional outbox).

Задача ставится в той же транзакции, что и смена статуса заявки, поэтому шаг не теряется, даже если
воркер упадёт сразу после коммита. В PostgreSQL несколько воркеров разбирают очередь параллельно
благодаря SELECT … FOR UPDATE SKIP LOCKED.
"""

from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.models import Job, utcnow

STALE_AFTER = timedelta(minutes=5)


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
    """Задачи, которые «застряли» в running (воркер упал посреди шага), возвращаются в очередь."""
    result = db.execute(
        update(Job)
        .where(Job.status == "running", Job.updated_at < utcnow() - STALE_AFTER)
        .values(status="pending", run_after=utcnow())
    )
    db.commit()
    return result.rowcount or 0
