"""Применение переходов статуса к заявке с записью в журнал аудита."""

from sqlalchemy.orm import Session

from app.domain.statuses import STATUS_INFO, Actor, Status, can_transition
from app.errors import InvalidTransition
from app.models import Application, ApplicationEvent, utcnow
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
) -> ApplicationEvent:
    src = Status(application.status)
    if not can_transition(src, to, actor):
        raise InvalidTransition(
            f"Нельзя перевести заявку из статуса «{STATUS_INFO[src].title}» в «{STATUS_INFO[to].title}»."
        )
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
    if actor != Actor.CLIENT and to in NOTIFY_CLIENT:
        info = STATUS_INFO[to]
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
