import logging
from datetime import timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app import __version__
from app.db import SessionLocal, engine
from app.models import Job, utcnow
from app.services.integrations import CIRCUIT_OPEN, SOURCE_NAMES, CircuitBreaker, get_breaker

router = APIRouter(prefix="/health", tags=["Служебное"])
log = logging.getLogger("app.health")

# Воркер — отдельный процесс, его предохранитель отсюда не виден. Признак паузы — недавние задачи, отложенные
# с ошибкой «источник: circuit open» (её пишет в last_error runner).
PAUSE_WINDOW = timedelta(minutes=5)


class QueueOut(BaseModel):
    pending: int = Field(description="Сколько задач ждут запуска, включая отложенные повторы")
    running: int = Field(description="Сколько задач выполняется сейчас")
    oldest_ready_age_s: float = Field(description="Сколько ждёт самая старая задача, которой уже пора выполняться, с")
    failed_last_hour: int = Field(description="Сколько задач завершились сбоем за последний час")


class DepsOut(BaseModel):
    version: str
    queue: QueueOut | None = Field(description="null — база данных недоступна")
    sources: dict[str, Literal["ok", "paused"]] = Field(
        description="paused — источник не опрашивается после серии сбоев, конвейер повторит запрос сам"
    )


@router.get("/live", summary="Процесс жив")
def live() -> dict:
    return {"status": "ok"}


@router.get("/ready", summary="Сервис готов принимать запросы (БД доступна)")
def ready() -> JSONResponse:
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        return JSONResponse({"status": "unavailable", "db": "down"}, status_code=503)
    return JSONResponse({"status": "ok", "db": "up"})


def _queue(db: Session) -> QueueOut:
    now = utcnow()
    counts = dict(
        db.execute(
            select(Job.status, func.count()).where(Job.status.in_(("pending", "running"))).group_by(Job.status)
        ).all()
    )
    oldest = db.scalar(select(func.min(Job.run_after)).where(Job.status == "pending", Job.run_after <= now))
    failed = db.scalar(
        select(func.count()).select_from(Job).where(Job.status == "failed", Job.updated_at >= now - timedelta(hours=1))
    )
    age = 0.0
    if oldest is not None:  # SQLite отдаёт время без пояса, в БД всё в UTC
        age = max(0.0, (now - (oldest if oldest.tzinfo else oldest.replace(tzinfo=timezone.utc))).total_seconds())
    return QueueOut(
        pending=counts.get("pending", 0),
        running=counts.get("running", 0),
        oldest_ready_age_s=round(age, 1),
        failed_last_hour=failed or 0,
    )


def _paused_by_jobs(db: Session) -> set[str]:
    errors = db.scalars(
        select(Job.last_error).where(
            Job.status.in_(("pending", "running")),
            Job.last_error.like(f"%: {CIRCUIT_OPEN}%"),
            Job.updated_at >= utcnow() - PAUSE_WINDOW,
        )
    )
    return {error.split(":", 1)[0] for error in errors}


@router.get(
    "/deps",
    response_model=DepsOut,
    summary="Очередь конвейера и внешние источники (всегда 200, на готовность не влияет)",
)
def deps(breaker: CircuitBreaker | None = Depends(get_breaker)) -> DepsOut:
    queue, paused = None, set()
    try:
        with SessionLocal() as db:
            queue = _queue(db)
            paused = _paused_by_jobs(db)
    except Exception as exc:  # noqa: BLE001 — состояние БД показывает /health/ready, здесь ответ есть всегда
        log.warning("health deps without queue", extra={"error": exc.__class__.__name__})
    if breaker is not None:
        paused |= {source for source in SOURCE_NAMES if breaker.is_open(source)}
    return DepsOut(
        version=__version__,
        queue=queue,
        sources={source: "paused" if source in paused else "ok" for source in SOURCE_NAMES},
    )
