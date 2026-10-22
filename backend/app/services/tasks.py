"""Запросы банка к клиенту и документы по заявке.

Когда клиент закрывает последний открытый запрос, заявка сама возвращается на проверку —
конвейер продолжает работу без участия сотрудника.
"""

from fastapi import UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.statuses import Actor, Status
from app.errors import BusinessValidationError, Conflict, NotFound
from app.models import Application, ClientTask, Document, User, utcnow
from app.pipeline.queue import enqueue
from app.services import storage
from app.services.state_machine import apply_transition, record_event

DOCUMENT_KINDS = {
    "bank_statement": "Выписка по расчётному счёту",
    "financial_report": "Бухгалтерская отчётность",
    "collateral": "Документы по залогу",
    "other": "Другой документ",
}


def list_tasks(db: Session, app: Application) -> list[ClientTask]:
    return list(db.scalars(select(ClientTask).where(ClientTask.application_id == app.id).order_by(ClientTask.id)))


def list_documents(db: Session, app: Application) -> list[Document]:
    return list(db.scalars(select(Document).where(Document.application_id == app.id).order_by(Document.id)))


def _own_task(db: Session, app: Application, task_id: int) -> ClientTask:
    task = db.get(ClientTask, task_id)
    if task is None or task.application_id != app.id:
        raise NotFound("Запрос не найден")
    if task.status != "open":
        raise Conflict("На этот запрос уже ответили")
    return task


def _require_owner(app: Application, user: User) -> None:
    if user.role != "client" or user.company_id != app.company_id:
        raise NotFound("Заявка не найдена")


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


def _resume_if_complete(db: Session, app: Application, user: User) -> None:
    if app.status != Status.NEEDS_INFO.value:
        return
    open_left = db.scalar(
        select(ClientTask.id).where(ClientTask.application_id == app.id, ClientTask.status == "open").limit(1)
    )
    if open_left is None:
        apply_transition(db, app, Status.VALIDATION, Actor.CLIENT, actor_id=user.id)
        enqueue(db, "pipeline.validate", app.id)


def answer_task(db: Session, user: User, app: Application, task_id: int, answer: str) -> ClientTask:
    _require_owner(app, user)
    if app.status != Status.NEEDS_INFO.value:
        raise Conflict("Сейчас банк ничего не запрашивает по этой заявке")
    task = _own_task(db, app, task_id)
    if task.kind == "document":
        raise BusinessValidationError("Для этого запроса нужно загрузить документ")
    field = (task.payload or {}).get("field")
    if task.kind == "field" and (task.payload or {}).get("input") == "money":
        digits = "".join(ch for ch in answer if ch.isdigit())
        if not digits or int(digits) <= 0:
            raise BusinessValidationError(errors=[{"field": "answer", "message": "Укажите сумму в рублях"}])
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
    _require_owner(app, user)
    if kind not in DOCUMENT_KINDS:
        raise BusinessValidationError(errors=[{"field": "kind", "message": "Неизвестный тип документа"}])
    if app.status not in (Status.DRAFT.value, Status.NEEDS_INFO.value):
        raise Conflict("Документы можно приложить к черновику или по запросу банка")
    task = _own_task(db, app, task_id) if task_id is not None else None
    key, size = storage.save(upload, app.company_id)
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
    return doc
