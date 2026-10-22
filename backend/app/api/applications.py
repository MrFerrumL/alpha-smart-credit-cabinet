import asyncio
import json

from fastapi import APIRouter, Depends, File, Form, Header, Query, Request, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_client
from app.db import SessionLocal, get_db
from app.domain.statuses import STATUS_INFO, Status
from app.models import ApplicationEvent, CheckResult, ClientTask, Document, User
from app.pipeline.steps import SOURCE_TITLES, SOURCES
from app.schemas import (
    ApplicationCreate,
    ApplicationOut,
    ApplicationUpdate,
    CancelIn,
    CheckOut,
    DocumentOut,
    EventOut,
    StreamSnapshot,
    TaskAnswerIn,
    TaskOut,
)
from app.services import applications as svc
from app.services import tasks as tasks_svc

STREAM_POLL_S = 1.0
STREAM_PING_EVERY = 15

router = APIRouter(prefix="/applications", tags=["Заявки"])


@router.get("", response_model=list[ApplicationOut], summary="Заявки: клиенту — свои, аналитику — все отправленные")
def list_applications(
    status_filter: str | None = Query(default=None, alias="status"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ApplicationOut]:
    return [svc.to_out(a, user, db) for a in svc.list_for_user(db, user, status_filter)]


@router.post("", response_model=ApplicationOut, status_code=status.HTTP_201_CREATED, summary="Создать черновик заявки")
def create_application(
    data: ApplicationCreate, user: User = Depends(require_client), db: Session = Depends(get_db)
) -> ApplicationOut:
    return svc.to_out(svc.create_draft(db, user, data), user, db)


@router.get("/{application_id}", response_model=ApplicationOut, summary="Заявка")
def get_application(
    application_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> ApplicationOut:
    return svc.to_out(svc.get_for_user(db, user, application_id), user, db)


@router.patch("/{application_id}", response_model=ApplicationOut, summary="Изменить черновик")
def update_application(
    application_id: int,
    data: ApplicationUpdate,
    user: User = Depends(require_client),
    db: Session = Depends(get_db),
) -> ApplicationOut:
    app = svc.get_for_user(db, user, application_id)
    return svc.to_out(svc.update_draft(db, user, app, data), user, db)


@router.post("/{application_id}/submit", response_model=ApplicationOut, summary="Отправить заявку в банк")
def submit_application(
    application_id: int,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key", max_length=64),
    user: User = Depends(require_client),
    db: Session = Depends(get_db),
) -> ApplicationOut:
    app = svc.get_for_user(db, user, application_id)
    return svc.to_out(svc.submit(db, user, app, idempotency_key), user, db)


@router.post("/{application_id}/cancel", response_model=ApplicationOut, summary="Отозвать заявку")
def cancel_application(
    application_id: int,
    data: CancelIn | None = None,
    user: User = Depends(require_client),
    db: Session = Depends(get_db),
) -> ApplicationOut:
    app = svc.get_for_user(db, user, application_id)
    return svc.to_out(svc.cancel(db, user, app, data.comment if data else None), user, db)


@router.get("/{application_id}/events", response_model=list[EventOut], summary="История заявки")
def application_events(
    application_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[EventOut]:
    app = svc.get_for_user(db, user, application_id)
    return [svc.event_out(ev) for ev in app.events]


@router.get("/{application_id}/tasks", response_model=list[TaskOut], summary="Запросы банка по заявке")
def application_tasks(
    application_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[ClientTask]:
    return tasks_svc.list_tasks(db, svc.get_for_user(db, user, application_id))


@router.post(
    "/{application_id}/tasks/{task_id}/answer", response_model=TaskOut, summary="Ответить на запрос банка"
)
def answer_task(
    application_id: int,
    task_id: int,
    data: TaskAnswerIn,
    user: User = Depends(require_client),
    db: Session = Depends(get_db),
) -> ClientTask:
    app = svc.get_for_user(db, user, application_id)
    return tasks_svc.answer_task(db, user, app, task_id, data.answer)


@router.get("/{application_id}/documents", response_model=list[DocumentOut], summary="Документы по заявке")
def application_documents(
    application_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[Document]:
    return tasks_svc.list_documents(db, svc.get_for_user(db, user, application_id))


@router.post(
    "/{application_id}/documents",
    response_model=DocumentOut,
    status_code=status.HTTP_201_CREATED,
    summary="Приложить документ (к черновику или по запросу банка)",
)
def upload_document(
    application_id: int,
    file: UploadFile = File(...),
    kind: str = Form("other"),
    task_id: int | None = Form(None),
    user: User = Depends(require_client),
    db: Session = Depends(get_db),
) -> Document:
    app = svc.get_for_user(db, user, application_id)
    return tasks_svc.upload_document(db, user, app, file, kind, task_id)


@router.get("/{application_id}/checks", response_model=list[CheckOut], summary="Ход проверок во внешних источниках")
def application_checks(
    application_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[CheckOut]:
    app = svc.get_for_user(db, user, application_id)
    rows = {
        c.source: c
        for c in db.scalars(select(CheckResult).where(CheckResult.application_id == app.id).order_by(CheckResult.id))
    }
    result = []
    for source in SOURCES:
        row = rows.get(source)
        result.append(
            CheckOut(
                source=source,
                title=SOURCE_TITLES[source],
                status=row.status if row else "pending",
                attempts=row.attempts if row else 0,
                data=row.data if row and user.role == "analyst" else None,
            )
        )
    return result


def _snapshot(user: User, application_id: int) -> dict:
    with SessionLocal() as db:
        app = svc.get_for_user(db, user, application_id)
        info = STATUS_INFO[Status(app.status)]
        last_event = db.scalar(select(func.max(ApplicationEvent.id)).where(ApplicationEvent.application_id == app.id))
        return StreamSnapshot(
            status=app.status,
            title=info.title,
            tone=info.tone,
            terminal=info.terminal,
            last_event_id=last_event or 0,
            open_tasks=svc.open_tasks_count(db, app),
        ).model_dump()


@router.get(
    "/{application_id}/stream",
    summary="Живой статус заявки (Server-Sent Events)",
    response_description="Поток событий `update` с данными StreamSnapshot; комментарий-пинг раз в 15 секунд",
)
async def application_stream(
    application_id: int, request: Request, user: User = Depends(get_current_user)
) -> StreamingResponse:
    # Доступ проверяется до начала потока, чтобы чужая заявка давала обычный 404.
    first = await asyncio.to_thread(_snapshot, user, application_id)

    async def events():
        last, idle = None, 0
        snap = first
        while True:
            if snap != last:
                yield f"event: update\ndata: {json.dumps(snap, ensure_ascii=False)}\n\n"
                last, idle = snap, 0
                if snap["terminal"]:
                    return
            elif idle >= STREAM_PING_EVERY:
                yield ": ping\n\n"
                idle = 0
            await asyncio.sleep(STREAM_POLL_S)
            idle += 1
            if await request.is_disconnected():
                return
            snap = await asyncio.to_thread(_snapshot, user, application_id)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
