"""Применение переходов статуса к заявке с записью в журнал аудита."""

from sqlalchemy.orm import Session

from app.domain.statuses import STATUS_INFO, Actor, Status, can_transition
from app.errors import InvalidTransition
from app.models import Application, ApplicationEvent, utcnow

DECISION_STATUSES = frozenset({Status.APPROVED, Status.COUNTER_OFFER, Status.REJECTED})


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
