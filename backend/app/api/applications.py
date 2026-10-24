import asyncio
import json

from fastapi import APIRouter, Depends, File, Form, Header, Query, Request, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_stream_user, require_analyst, require_client
from app.config import get_settings
from app.db import SessionLocal, get_db
from app.domain.statuses import STATUS_INFO, Status
from app.explanation import jobs as explanation_jobs
from app.models import ApplicationEvent, ClientTask, Document, User
from app.pipeline.steps import SOURCE_TITLES, SOURCES, checks_by_source
from app.schemas import (
    AnalystDecisionIn,
    AssessmentOut,
    ReplayOut,
    ApplicationCreate,
    ApplicationOut,
    ApplicationUpdate,
    CancelIn,
    CheckOut,
    ContractOut,
    DocumentOut,
    EventOut,
    ExplanationOut,
    SignConfirmIn,
    SigningCodeOut,
    StreamSnapshot,
    TaskAnswerIn,
    TaskOut,
)
from app.services import applications as svc
from app.services import decisions as decisions_svc
from app.services import signing as signing_svc
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
    return [svc.event_out(ev, for_bank=user.role == "analyst") for ev in app.events]


@router.get(
    "/{application_id}/explanation",
    response_model=ExplanationOut,
    summary="Пояснение решения простыми словами (если функция включена)",
)
def application_explanation(
    application_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> ExplanationOut:
    return explanation_jobs.for_client(db, svc.get_for_user(db, user, application_id))


@router.get(
    "/{application_id}/assessment",
    response_model=AssessmentOut,
    summary="Карточка аналитика: почему заявка у специалиста, оценка, стоп-факторы, рекомендация",
)
def application_assessment(
    application_id: int, user: User = Depends(require_analyst), db: Session = Depends(get_db)
) -> AssessmentOut:
    return decisions_svc.assessment(db, user, svc.get_for_user(db, user, application_id))


@router.post(
    "/{application_id}/assessment/replay",
    response_model=ReplayOut,
    summary="Воспроизвести решение конвейера на сохранённых признаках (ничего не меняет)",
)
def replay_decision(
    application_id: int, user: User = Depends(require_analyst), db: Session = Depends(get_db)
) -> ReplayOut:
    return decisions_svc.replay(db, svc.get_for_user(db, user, application_id))


@router.post(
    "/{application_id}/decision",
    response_model=ApplicationOut,
    summary="Решение аналитика: одобрить, контрпредложение, запросить информацию, отказать, повторить проверки",
)
def analyst_decision(
    application_id: int,
    data: AnalystDecisionIn,
    user: User = Depends(require_analyst),
    db: Session = Depends(get_db),
) -> ApplicationOut:
    app = svc.get_for_user(db, user, application_id)
    return svc.to_out(decisions_svc.decide(db, user, app, data), user, db)


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
    rows = checks_by_source(db, app)
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
    application_id: int, request: Request, user: User = Depends(get_stream_user)
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



# --- Предложение, договор, подписание -----------------------------------------------------------


@router.post("/{application_id}/offer/accept", response_model=ApplicationOut, summary="Принять предложение банка")
def accept_offer(
    application_id: int, user: User = Depends(require_client), db: Session = Depends(get_db)
) -> ApplicationOut:
    app = svc.get_for_user(db, user, application_id)
    signing_svc.accept_offer(db, user, app)
    return svc.to_out(app, user, db)


@router.post(
    "/{application_id}/offer/handoff",
    response_model=ApplicationOut,
    summary="Передать предложение руководителю на подпись (для сотрудника без права подписи)",
)
def handoff_offer(
    application_id: int, user: User = Depends(require_client), db: Session = Depends(get_db)
) -> ApplicationOut:
    app = svc.get_for_user(db, user, application_id)
    return svc.to_out(signing_svc.handoff_to_signer(db, user, app), user, db)


@router.post("/{application_id}/offer/decline", response_model=ApplicationOut, summary="Отказаться от предложения")
def decline_offer(
    application_id: int,
    data: CancelIn | None = None,
    user: User = Depends(require_client),
    db: Session = Depends(get_db),
) -> ApplicationOut:
    app = svc.get_for_user(db, user, application_id)
    signing_svc.decline_offer(db, user, app, data.comment if data else None)
    return svc.to_out(app, user, db)


@router.get("/{application_id}/contract", response_model=ContractOut, summary="Кредитный договор")
def get_contract(
    application_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> ContractOut:
    return signing_svc.contract(db, svc.get_for_user(db, user, application_id))


@router.post(
    "/{application_id}/signing/code",
    response_model=SigningCodeOut,
    summary="Запросить код для подписания (показывается в окне подписания)",
)
def request_signing_code(
    application_id: int, user: User = Depends(require_client), db: Session = Depends(get_db)
) -> SigningCodeOut:
    app = svc.get_for_user(db, user, application_id)
    challenge, code = signing_svc.request_code(db, user, app)
    return SigningCodeOut(
        challenge_id=challenge.id, expires_at=challenge.expires_at, attempts_left=challenge.attempts_left,
        demo_code=code if get_settings().demo_mode else None,
    )


@router.post("/{application_id}/signing/confirm", response_model=ApplicationOut, summary="Подписать договор кодом")
def confirm_signing(
    application_id: int,
    data: SignConfirmIn,
    user: User = Depends(require_client),
    db: Session = Depends(get_db),
) -> ApplicationOut:
    app = svc.get_for_user(db, user, application_id)
    signing_svc.confirm(db, user, app, data.challenge_id, data.code)
    return svc.to_out(app, user, db)
