"""Повторы и сбои шагов конвейера простыми словами — для страницы «Состояние системы» в кабинете банка.

Источник — очередь задач (Job): попытки, статус и последняя ошибка шага. Ошибка наружу не отдаётся как есть: в тексте
исключения может оказаться что угодно, вплоть до ИНН клиента, поэтому она сводится к короткой причине из списка.
"""

import re
from datetime import datetime, timezone

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Application, ApplicationEvent, Job
from app.pipeline.queue import WORKER_STOPPED
from app.schemas import SystemJobOut
from app.services.integrations import CIRCUIT_OPEN, SOURCE_NAMES

STEP_TITLES = {
    "pipeline.start": "Приём заявки",
    "pipeline.validate": "Проверка анкеты",
    "pipeline.enrich": "Запрос во внешние источники",
    "pipeline.score": "Оценка и решение",
    "pipeline.disburse": "Перевод денег через АБС",
}

# События, которые шаг пишет в журнал заявки при каждом повторе из-за источника (pipeline/steps.py).
RETRY_EVENTS = {"pipeline.enrich": "check_retry", "pipeline.disburse": "disbursement_retry"}

INTERNAL = "внутренняя ошибка шага — подробности в журнале сервиса"
STOPPED = "обработчик остановился посреди шага"


def _utc(value: datetime) -> datetime:
    # SQLite хранит время без пояса, в БД всё в UTC.
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _source_reason(reason: str) -> str:
    """Причина отказа источника (SourceUnavailable.reason). Без глаголов: «ЕГРЮЛ», «ФНС» и «бюро» разного рода."""
    if reason == CIRCUIT_OPEN:
        return "запросы на паузе после серии сбоев"
    if reason == "timeout":
        return "нет ответа за отведённое время"
    if code := re.fullmatch(r"HTTP (\d{3})", reason):
        return f"ошибка на стороне источника (код {code.group(1)})"
    if reason.startswith("transport error"):
        return "нет связи с источником"
    return "источник недоступен"


def explain(error: str) -> tuple[str | None, str]:
    """Последняя ошибка задачи → (источник или None, причина простыми словами)."""
    head, sep, rest = error.partition(": ")
    source = head if sep and head in SOURCE_NAMES else None
    if WORKER_STOPPED in error:
        return source, STOPPED
    if error.startswith("recovery failed"):
        return None, "шаг не удалось вернуть в очередь после остановки обработчика"
    if error.startswith("skipped:"):
        return None, "заявка ушла с этого этапа — повтор не понадобился"
    if source:
        return source, _source_reason(rest)
    return None, INTERNAL


def _retry_sources(db: Session, jobs: list[Job]) -> dict[int, str]:
    """Источник, из-за которого повторялся шаг, который в итоге выполнился (его ошибка уже стёрта): по последнему
    событию повтора в журнале заявки до завершения задачи."""
    wanted = [job for job in jobs if job.kind in RETRY_EVENTS and job.application_id is not None]
    if not wanted:
        return {}
    events = db.execute(
        select(ApplicationEvent.application_id, ApplicationEvent.event, ApplicationEvent.payload,
               ApplicationEvent.created_at)
        .where(
            ApplicationEvent.application_id.in_(sorted({job.application_id for job in wanted})),
            ApplicationEvent.event.in_(tuple(RETRY_EVENTS.values())),
        )
        .order_by(ApplicationEvent.id)
    ).all()
    found: dict[int, str] = {}
    for job in wanted:
        until = _utc(job.updated_at)
        for application_id, event, payload, created_at in events:
            if application_id != job.application_id or event != RETRY_EVENTS[job.kind] or _utc(created_at) > until:
                continue
            source = (payload or {}).get("source") if event == "check_retry" else "abs"
            if source in SOURCE_NAMES:
                found[job.id] = source
    return found


def _row(job: Job, number: str | None, max_attempts: int, retry_source: str | None) -> SystemJobOut:
    if job.last_error:
        source, reason = explain(job.last_error)
    elif job.status == "done":  # шаг выполнился не с первой попытки: ошибку прошлой попытки runner стирает
        source, reason = retry_source, f"сбой прошёл — шаг выполнен с {job.attempts}-й попытки"
    else:  # без ошибки повтор бывает, только если задачу вернули в очередь после остановки воркера
        source, reason = None, STOPPED
    return SystemJobOut(
        id=job.id,
        application_id=job.application_id,
        application_number=number,
        kind=job.kind,
        step=STEP_TITLES.get(job.kind, "Шаг конвейера"),
        status=job.status,
        attempts=job.attempts,
        max_attempts=max_attempts,
        source=source,
        reason=reason,
        next_attempt_at=job.run_after if job.status == "pending" else None,
        updated_at=job.updated_at,
    )


def recent_job_issues(db: Session, limit: int) -> list[SystemJobOut]:
    """Последние задачи, которые не выполнились с первой попытки: ждут повтора, повторяются, выполнились со второй
    и далее или исчерпали попытки. Свежие — сверху."""
    issue = or_(
        Job.status == "failed",
        Job.attempts > 1,
        and_(Job.status == "pending", Job.last_error.is_not(None)),
    )
    rows = db.execute(
        select(Job, Application.number)
        .outerjoin(Application, Application.id == Job.application_id)
        .where(issue)
        .order_by(Job.updated_at.desc(), Job.id.desc())
        .limit(limit)
    ).all()
    sources = _retry_sources(db, [job for job, _ in rows if job.status == "done" and not job.last_error])
    max_attempts = get_settings().pipeline_max_attempts
    return [_row(job, number, max_attempts, sources.get(job.id)) for job, number in rows]
