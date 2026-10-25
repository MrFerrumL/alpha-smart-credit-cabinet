"""Применение переходов статуса к заявке с записью в журнал аудита."""

from sqlalchemy import update
from sqlalchemy.orm import Session

from app.domain.statuses import STATUS_INFO, Actor, Status, StatusInfo, can_transition
from app.errors import InvalidTransition
from app.models import Application, ApplicationEvent, ClientTask, utcnow
from app.services.notifications import notify_company

DECISION_STATUSES = frozenset({Status.APPROVED, Status.COUNTER_OFFER, Status.REJECTED})

# О каких изменениях, сделанных банком, клиент получает уведомление в кабинете.
NOTIFY_CLIENT = frozenset(
    {
        Status.NEEDS_INFO,
        Status.MANUAL_REVIEW,
        Status.APPROVED,
        Status.COUNTER_OFFER,
        Status.REJECTED,
        Status.ISSUED,
        Status.EXPIRED,
    }
)


def apply_transition(
    db: Session,
    application: Application,
    to: Status,
    actor: Actor,
    *,
    actor_id: int | None = None,
    event: str = "status_changed",
    comment: str | None = None,
    payload: dict | None = None,
    info: StatusInfo | None = None,
) -> ApplicationEvent:
    """info — текст статуса для уведомления клиенту, если он зависит от заявки (например, у овердрафта)."""
    src = Status(application.status)
    if not can_transition(src, to, actor):
        raise InvalidTransition(f"Заявка уже в статусе «{STATUS_INFO[src].title}» — показали актуальное состояние")
    now = utcnow()
    application.status = to.value
    if to == Status.SUBMITTED:
        application.submitted_at = now
    if to in DECISION_STATUSES:
        application.decided_at = now
    ev = ApplicationEvent(
        application=application,
        actor_type=actor.value,
        actor_id=actor_id,
        event=event,
        from_status=src.value,
        to_status=to.value,
        comment=comment,
        payload=payload or {},
    )
    db.add(ev)
    if src == Status.SIGNING and to in (Status.CANCELLED, Status.EXPIRED):
        # Заявка ушла с подписания — незакрытые условия выдачи больше не нужны.
        db.execute(
            update(ClientTask)
            .where(ClientTask.application_id == application.id, ClientTask.status == "open")
            .values(status="expired")
        )
    if actor != Actor.CLIENT and to in NOTIFY_CLIENT:
        info = info or STATUS_INFO[to]
        notify_company(
            db,
            application.company_id,
            kind="status",
            title=f"Заявка № {application.number}: {info.title.lower()}",
            body=info.hint,
            link=f"/applications/{application.id}",
        )
    return ev


def record_event(
    db: Session,
    application: Application,
    event: str,
    actor: Actor,
    *,
    actor_id: int | None = None,
    comment: str | None = None,
    payload: dict | None = None,
) -> ApplicationEvent:
    ev = ApplicationEvent(
        application=application,
        actor_type=actor.value,
        actor_id=actor_id,
        event=event,
        comment=comment,
        payload=payload or {},
    )
    db.add(ev)
    return ev
