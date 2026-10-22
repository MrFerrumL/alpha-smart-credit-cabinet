"""Уведомления внутри кабинета: смена статуса заявки, код подписи, выдача кредита."""

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.models import Notification, User, utcnow


def notify_users(
    db: Session, user_ids: list[int], *, kind: str, title: str, body: str | None = None, link: str | None = None
) -> None:
    for user_id in user_ids:
        db.add(Notification(user_id=user_id, kind=kind, title=title, body=body, link=link))


def notify_company(
    db: Session, company_id: int, *, kind: str, title: str, body: str | None = None, link: str | None = None
) -> None:
    user_ids = list(db.scalars(select(User.id).where(User.company_id == company_id, User.role == "client")))
    notify_users(db, user_ids, kind=kind, title=title, body=body, link=link)


def list_for(db: Session, user: User, limit: int = 30) -> list[Notification]:
    query = (
        select(Notification)
        .where(Notification.user_id == user.id)
        .order_by(Notification.id.desc())
        .limit(limit)
    )
    return list(db.scalars(query))


def mark_all_read(db: Session, user: User) -> None:
    db.execute(
        update(Notification)
        .where(Notification.user_id == user.id, Notification.read_at.is_(None))
        .values(read_at=utcnow())
    )
    db.commit()
