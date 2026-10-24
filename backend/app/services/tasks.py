"""Запросы банка к клиенту и документы по заявке.

Когда клиент закрывает последний открытый запрос, заявка сама возвращается на проверку —
конвейер продолжает работу без участия сотрудника.
"""

from fastapi import UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_by_id
from app.domain.statuses import Actor, Status
from app.errors import BusinessValidationError, Conflict, Forbidden, NotFound, max_value_message
from app.models import Application, ClientTask, Document, User, utcnow
from app.pipeline.queue import enqueue
from app.schemas import MAX_MONEY
from app.services import storage
from app.services.applications import require_owner
from app.services.state_machine import apply_transition, record_event

DOCUMENT_KINDS = {
    "bank_statement": "Выписка по расчётному счёту",
    "financial_report": "Бухгалтерская отчётность",
    "collateral": "Документы по залогу",
    "other": "Другой документ",
}
MAX_DOCUMENTS = 20  # на одну заявку


def list_tasks(db: Session, app: Application) -> list[ClientTask]:
    return list(db.scalars(select(ClientTask).where(ClientTask.application_id == app.id).order_by(ClientTask.id)))


def list_documents(db: Session, app: Application) -> list[Document]:
    return list(db.scalars(select(Document).where(Document.application_id == app.id).order_by(Document.id)))


def _own_task(db: Session, app: Application, task_id: int) -> ClientTask:
    task = get_by_id(db, ClientTask, task_id)
    if task is None or task.application_id != app.id:
        raise NotFound("Запрос не найден")
    if task.status != "open":
        raise Conflict("На этот запрос уже ответили")
    return task


def _set_form_field(app: Application, path: str, value) -> None:
    form = dict(app.form or {})
    section, _, key = path.partition(".")
    nested = dict(form.get(section) or {})
    nested[key] = value
    form[section] = nested
    app.form = form  # новый объект, чтобы SQLAlchemy увидел изменение JSON


def _resolve(db: Session, app: Application, task: ClientTask, user: User, answer: str | None) -> None:
    task.status = "done"
    task.answer = answer
    task.resolved_at = utcnow()
    # Версия заявки растёт: истечение срока запроса не перезапишет только что данный ответ.
    app.updated_at = utcnow()
    record_event(db, app, "task_answered", Actor.CLIENT, actor_id=user.id, payload={"task": task.title})


BEFORE_ISSUE = "before_issue"  # задача-условие выдачи: закрывается при подписании, до перевода денег


def is_issue_condition(task: ClientTask) -> bool:
    return (task.payload or {}).get("condition") == BEFORE_ISSUE


def open_issue_conditions(db: Session, app: Application) -> list[ClientTask]:
    tasks = db.scalars(select(ClientTask).where(ClientTask.application_id == app.id, ClientTask.status == "open"))
    return [t for t in tasks if is_issue_condition(t)]


def _accepts_answers(app: Application, task: ClientTask | None) -> bool:
    """Ответ принимается на запрос банка (нужна информация) и на условия выдачи (подписание)."""
    if app.status == Status.NEEDS_INFO.value:
        return True
    return app.status == Status.SIGNING.value and task is not None and is_issue_condition(task)


def _resume_if_complete(db: Session, app: Application, user: User) -> None:
    if app.status == Status.SIGNING.value:
        # Последнее условие выдачи закрыто, а договор уже подписан — конвейер переводит деньги.
        from app.services.applications import latest_offer

        offer = latest_offer(db, app)
        if offer is not None and offer.status == "signed" and not open_issue_conditions(db, app):
            record_event(db, app, "issue_conditions_met", Actor.CLIENT, actor_id=user.id)
            enqueue(db, "pipeline.disburse", app.id)
        return
    if app.status != Status.NEEDS_INFO.value:
        return
    open_left = db.scalar(
        select(ClientTask.id).where(ClientTask.application_id == app.id, ClientTask.status == "open").limit(1)
    )
    if open_left is None:
        apply_transition(db, app, Status.VALIDATION, Actor.CLIENT, actor_id=user.id)
        enqueue(db, "pipeline.validate", app.id)


def answer_task(db: Session, user: User, app: Application, task_id: int, answer: str) -> ClientTask:
    require_owner(app, user)
    task = _own_task(db, app, task_id)
    if not _accepts_answers(app, task):
        raise Conflict("Сейчас банк ничего не запрашивает по этой заявке")
    if is_issue_condition(task) and task.kind == "question":
        from app.services.applications import user_may_sign

        if not user_may_sign(user, app):
            raise Forbidden("Подтвердить поручительство может только руководитель компании")
    if not answer.strip():
        raise BusinessValidationError(errors=[{"field": "answer", "message": "Напишите ответ"}])
    if task.kind == "document":
        raise BusinessValidationError("Для этого запроса нужно загрузить документ")
    field = (task.payload or {}).get("field")
    if task.kind == "field" and (task.payload or {}).get("input") == "money":
        # Только цифры 0–9 (isdigit() пропускает «²», на котором int() падает); длина проверяется до int().
        digits = "".join(ch for ch in answer if ch in "0123456789").lstrip("0")
        if not digits:
            raise BusinessValidationError(errors=[{"field": "answer", "message": "Укажите сумму в рублях"}])
        if len(digits) > len(str(MAX_MONEY)) or int(digits) > MAX_MONEY:
            raise BusinessValidationError(errors=[{"field": "answer", "message": max_value_message(field, MAX_MONEY)}])
        _set_form_field(app, field, int(digits))
    elif field:
        _set_form_field(app, field, answer.strip())
    _resolve(db, app, task, user, answer.strip())
    db.flush()
    _resume_if_complete(db, app, user)
    db.commit()
    return task


def upload_document(
    db: Session, user: User, app: Application, upload: UploadFile, kind: str, task_id: int | None
) -> Document:
    require_owner(app, user)
    if kind not in DOCUMENT_KINDS:
        raise BusinessValidationError(errors=[{"field": "kind", "message": "Неизвестный тип документа"}])
    task = _own_task(db, app, task_id) if task_id is not None else None
    if app.status != Status.DRAFT.value and not _accepts_answers(app, task):
        raise Conflict("Документы можно приложить к черновику, по запросу банка или к условиям выдачи")
    db.refresh(app, with_for_update=True)  # параллельные загрузки не обойдут лимит документов
    if db.scalar(select(func.count(Document.id)).where(Document.application_id == app.id)) >= MAX_DOCUMENTS:
        raise Conflict(f"К заявке можно приложить не больше {MAX_DOCUMENTS} документов")
    key, size = storage.save(upload, app.company_id)
    try:
        doc = Document(
            company_id=app.company_id,
            application_id=app.id,
            kind=kind,
            filename=(upload.filename or "document")[:255],
            content_type=(upload.content_type or "application/octet-stream")[:128],
            size_bytes=size,
            storage_key=key,
            uploaded_by_id=user.id,
        )
        db.add(doc)
        record_event(db, app, "document_uploaded", Actor.CLIENT, actor_id=user.id, payload={"filename": doc.filename})
        if task is not None:
            _resolve(db, app, task, user, doc.filename)
        db.flush()
        _resume_if_complete(db, app, user)
        db.commit()
    except Exception:
        storage.delete(key)  # записи о документе в БД нет — файл без неё никому не нужен
        raise
    return doc
