from fastapi import APIRouter, Depends, Header, Query, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_client
from app.db import get_db
from app.models import User
from app.schemas import ApplicationCreate, ApplicationOut, ApplicationUpdate, CancelIn, EventOut
from app.services import applications as svc

router = APIRouter(prefix="/applications", tags=["Заявки"])


@router.get("", response_model=list[ApplicationOut], summary="Заявки: клиенту — свои, аналитику — все отправленные")
def list_applications(
    status_filter: str | None = Query(default=None, alias="status"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ApplicationOut]:
    return [svc.to_out(a, user) for a in svc.list_for_user(db, user, status_filter)]


@router.post("", response_model=ApplicationOut, status_code=status.HTTP_201_CREATED, summary="Создать черновик заявки")
def create_application(
    data: ApplicationCreate, user: User = Depends(require_client), db: Session = Depends(get_db)
) -> ApplicationOut:
    return svc.to_out(svc.create_draft(db, user, data), user)


@router.get("/{application_id}", response_model=ApplicationOut, summary="Заявка")
def get_application(
    application_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> ApplicationOut:
    return svc.to_out(svc.get_for_user(db, user, application_id), user)


@router.patch("/{application_id}", response_model=ApplicationOut, summary="Изменить черновик")
def update_application(
    application_id: int,
    data: ApplicationUpdate,
    user: User = Depends(require_client),
    db: Session = Depends(get_db),
) -> ApplicationOut:
    app = svc.get_for_user(db, user, application_id)
    return svc.to_out(svc.update_draft(db, user, app, data), user)


@router.post("/{application_id}/submit", response_model=ApplicationOut, summary="Отправить заявку в банк")
def submit_application(
    application_id: int,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key", max_length=64),
    user: User = Depends(require_client),
    db: Session = Depends(get_db),
) -> ApplicationOut:
    app = svc.get_for_user(db, user, application_id)
    return svc.to_out(svc.submit(db, user, app, idempotency_key), user)


@router.post("/{application_id}/cancel", response_model=ApplicationOut, summary="Отозвать заявку")
def cancel_application(
    application_id: int,
    data: CancelIn | None = None,
    user: User = Depends(require_client),
    db: Session = Depends(get_db),
) -> ApplicationOut:
    app = svc.get_for_user(db, user, application_id)
    return svc.to_out(svc.cancel(db, user, app, data.comment if data else None), user)


@router.get("/{application_id}/events", response_model=list[EventOut], summary="История заявки")
def application_events(
    application_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[EventOut]:
    app = svc.get_for_user(db, user, application_id)
    return [svc.event_out(ev) for ev in app.events]
