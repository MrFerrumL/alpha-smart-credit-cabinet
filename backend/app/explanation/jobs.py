"""Фоновая генерация пояснения решения простыми словами (необязательная функция).

Своя таблица `decision_explanations` — она же очередь: решение в той же транзакции ставит туда строку, отдельный
поток воркера берёт её, спрашивает модель и записывает итог. Строку заявки генерация только читает и никогда не
меняет: у заявки оптимистическая блокировка, и фоновая запись конфликтовала бы с действиями клиента (например,
принятием предложения). Вызов модели идёт без открытой сессии и транзакции — медленная модель не держит соединение.
В лог попадает только исход и время, ни фактов, ни ответа модели.
"""

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.domain.statuses import Status
from app.explanation import facts, prompt, validate
from app.models import Application, ApplicationEvent, DecisionExplanation, utcnow
from app.schemas import ExplanationOut
from app.services.llm import LLM_TIMEOUT_S, ChatClient, LLMError

log = logging.getLogger("app.explanation")

POLL_S = 0.5  # поток опрашивает таблицу не реже раза в секунду
QUEUED_WINDOW_S = 600  # сколько ждущая (ещё не начатая) строка считается «готовим»
RUNNING_GRACE_S = 15  # к LLM_TIMEOUT_S для начатой строки (окно от started_at)
WARMUP_RETRY_S = 60  # прогрев, который не удался, повторяется не чаще раза в минуту и только в простое
RAW_RESPONSE_CHARS = 2000
# Статусы, в которые заявка переходит по решению: новое такое событие делает прежнее пояснение неактуальным.
DECISION_EVENT_STATUSES = {
    s.value for s in (Status.APPROVED, Status.COUNTER_OFFER, Status.REJECTED, Status.NEEDS_INFO, Status.MANUAL_REVIEW)
}

SessionFactory = Callable[[], Session]


@dataclass(frozen=True)
class _Claim:
    row_id: int
    data: facts.Facts | None  # None — строку пропустили, модель спрашивать не нужно


def schedule(db: Session, app: Application, event: ApplicationEvent) -> None:
    """Ставит пояснение в очередь в той же транзакции, что и решение. Функция выключена или решение
    не подходит (см. facts.eligible) — ничего не делает."""
    if get_settings().llm_active and facts.eligible(app.decision):
        db.add(DecisionExplanation(application_id=app.id, decision_event=event))


def _utc(value: datetime) -> datetime:
    # SQLite не хранит часовой пояс: все времена в БД — UTC.
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _older_than(moment: datetime | None, seconds: float) -> bool:
    return moment is None or utcnow() - _utc(moment) > timedelta(seconds=seconds)


def _current(db: Session, application_id: int) -> DecisionExplanation | None:
    """Текущее пояснение заявки: после его события решения у заявки не было нового такого события."""
    newer = exists().where(
        ApplicationEvent.application_id == DecisionExplanation.application_id,
        ApplicationEvent.id > DecisionExplanation.decision_event_id,
        ApplicationEvent.to_status.in_(DECISION_EVENT_STATUSES),
    )
    query = select(DecisionExplanation).where(DecisionExplanation.application_id == application_id, ~newer)
    return db.scalar(query.order_by(DecisionExplanation.id.desc()).limit(1))


def _skip(row: DecisionExplanation, reason: str) -> None:
    row.status, row.error, row.finished_at = "skipped", reason, utcnow()
    log.info("explanation skipped", extra={"outcome": reason})


def _claim(db: Session) -> _Claim | None:
    """Самая старая ждущая строка: лишнюю помечает пропущенной, годную — начатой. Нет ждущих — None.
    Заявку только читает. В PostgreSQL строка блокируется до коммита, так что воркеры не берут одну и ту же."""
    query = select(DecisionExplanation).where(DecisionExplanation.status == "queued")
    query = query.order_by(DecisionExplanation.id).limit(1)
    if db.get_bind().dialect.name == "postgresql":
        query = query.with_for_update(skip_locked=True)
    row = db.scalar(query)
    if row is None:
        db.rollback()
        return None
    found = None
    app = db.get(Application, row.application_id)
    if _older_than(row.created_at, QUEUED_WINDOW_S):
        _skip(row, "expired")
    elif app.status != row.decision_event.to_status or _current(db, app.id) is not row:
        _skip(row, "moved_on")
    else:
        found = facts.build_facts(db, app)
        if found is None:
            _skip(row, "ineligible")
        else:
            row.status, row.started_at = "running", utcnow()
            row.facts, row.prompt_version = found.as_dict(), prompt.PROMPT_VERSION
            row.model = get_settings().llm_model
    db.commit()
    return _Claim(row.id, found)


def _ask(client: ChatClient, f: facts.Facts) -> dict:
    """Спрашивает модель и проверяет ответ. Результат — поля строки: status, text | error, raw_response."""
    try:
        answer = client.complete(
            prompt.SYSTEM, prompt.user_message(f), max_tokens=prompt.MAX_TOKENS, temperature=prompt.TEMPERATURE
        )
    except LLMError as exc:
        return {"status": "failed", "error": exc.code}
    try:
        part = validate.check(answer.text, answer.finish_reason, f)
    except validate.Invalid as exc:
        return {"status": "failed", "error": f"invalid:{exc.rule}", "raw_response": answer.text[:RAW_RESPONSE_CHARS]}
    return {"status": "ready", "text": validate.compose(f, part)}


def process_next(session_factory: SessionFactory, client: ChatClient) -> bool:
    """Обрабатывает одну ждущую строку. Возвращает False, если ждущих нет."""
    with session_factory() as db:
        claim = _claim(db)
    if claim is None:
        return False
    if claim.data is None:
        return True
    # Модель вызывается без открытой сессии: ответ может идти до LLM_TIMEOUT_S.
    started = time.monotonic()
    try:
        result = _ask(client, claim.data)
    except Exception as exc:  # noqa: BLE001 — сбой не должен оставлять строку «начатой» навсегда
        log.warning("explanation crashed", extra={"error": type(exc).__name__})
        result = {"status": "failed", "error": "internal"}
    latency_ms = int((time.monotonic() - started) * 1000)
    with session_factory() as db:
        row = db.get(DecisionExplanation, claim.row_id)
        for name, value in result.items():
            setattr(row, name, value)
        row.latency_ms, row.finished_at = latency_ms, utcnow()
        db.commit()
    log.info("explanation", extra={"outcome": result.get("error", result["status"]), "duration_ms": latency_ms})
    return True


def _warm_up(client: ChatClient) -> bool:
    """Прогрев: то же системное сообщение и короткий вопрос — сервер модели загружает модель и разбирает промпт."""
    try:
        client.complete(prompt.SYSTEM, prompt.WARMUP_USER, max_tokens=1, temperature=0)
    except LLMError as exc:
        log.warning("llm warm-up failed", extra={"error": exc.code})
        return False
    except Exception as exc:  # noqa: BLE001 — прогрев необязателен
        log.warning("llm warm-up failed", extra={"error": type(exc).__name__})
        return False
    return True


def run_forever(session_factory: SessionFactory, client: ChatClient, stop: threading.Event) -> None:
    """Цикл потока воркера: прогрев, затем строки по одной; нет работы — пауза POLL_S. Останавливается по stop."""
    warmed = _warm_up(client)
    retry_at = time.monotonic() + WARMUP_RETRY_S
    while not stop.is_set():
        try:
            worked = process_next(session_factory, client)
            if not worked and not warmed and time.monotonic() >= retry_at:
                warmed, retry_at = _warm_up(client), time.monotonic() + WARMUP_RETRY_S
        except Exception:  # noqa: BLE001 — любая ошибка цикла не должна останавливать поток
            log.exception("explanation loop error, continuing")
            stop.wait(1)
            continue
        if not worked:
            stop.wait(POLL_S)


def for_client(db: Session, app: Application) -> ExplanationOut:
    """Что показать клиенту: готовый текст, «готовим» или ничего. Устаревшие и зависшие строки — ничего."""
    row = _current(db, app.id) if get_settings().llm_active else None
    if row is None:
        return ExplanationOut(status="none")
    if row.status == "ready" and row.text:
        return ExplanationOut(status="ready", text=row.text, generated_at=row.finished_at)
    if row.status == "queued" and not _older_than(row.created_at, QUEUED_WINDOW_S):
        return ExplanationOut(status="pending")
    if row.status == "running" and not _older_than(row.started_at, LLM_TIMEOUT_S + RUNNING_GRACE_S):
        return ExplanationOut(status="pending")
    return ExplanationOut(status="none")
