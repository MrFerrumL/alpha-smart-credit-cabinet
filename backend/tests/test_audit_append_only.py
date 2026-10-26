"""Журнал аудита только дописывается: событие нельзя изменить или удалить через ORM, а сохранения черновика
не переписывают историю — серия сохранений одного пользователя даёт одно событие «Анкета обновлена»."""

from datetime import datetime, timedelta

import pytest
from sqlalchemy import delete, select, update

from app.db import SessionLocal
from app.models import Application, ApplicationEvent, AuditLogImmutable, utcnow
from app.services import applications as applications_svc
from tests.conftest import auth, run_pipeline

BODY = {
    "product_code": "express",
    "purpose": "working_capital",
    "amount": 3_000_000,
    "term_months": 12,
    "form": {"finance": {"monthly_revenue": 4_000_000}, "consent_bki": True},
}
EVENTS = ApplicationEvent.__table__


def draft(client, headers: dict) -> int:
    created = client.post("/api/applications", json=BODY, headers=headers)
    assert created.status_code == 201, created.text
    return created.json()["id"]


def save(client, app_id: int, headers: dict, **changes) -> None:
    response = client.patch(f"/api/applications/{app_id}", json=changes, headers=headers)
    assert response.status_code == 200, response.text


def history(client, app_id: int, headers: dict) -> list[dict]:
    response = client.get(f"/api/applications/{app_id}/events", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def names(events: list[dict]) -> list[str]:
    return [e["event"] for e in events]


def stored(app_id: int) -> list[tuple]:
    """События заявки прямо из таблицы: всё, что могло бы измениться при переписывании."""
    query = select(ApplicationEvent).where(ApplicationEvent.application_id == app_id).order_by(ApplicationEvent.id)
    with SessionLocal() as db:
        return [(e.id, e.event, e.actor_id, e.comment, e.payload, e.created_at) for e in db.scalars(query)]


@pytest.mark.parametrize(
    ("field", "value"),
    [("comment", "переписано задним числом"), ("payload", {"fields": ["amount"]}), ("created_at", utcnow())],
)
def test_changing_an_event_through_the_orm_is_refused(client, field, value):
    headers = auth(client, "bakery@demo.local")
    app_id = draft(client, headers)
    before = stored(app_id)
    with SessionLocal() as db:
        ev = db.scalar(select(ApplicationEvent).where(ApplicationEvent.application_id == app_id))
        setattr(ev, field, value)
        with pytest.raises(AuditLogImmutable, match="только дописывается"):
            db.commit()
        db.rollback()
    assert stored(app_id) == before


def test_deleting_an_event_is_refused(client):
    headers = auth(client, "bakery@demo.local")
    app_id = draft(client, headers)
    before = stored(app_id)
    with SessionLocal() as db:
        db.delete(db.scalar(select(ApplicationEvent).where(ApplicationEvent.application_id == app_id)))
        with pytest.raises(AuditLogImmutable, match="только дописывается"):
            db.flush()
        db.rollback()
    assert stored(app_id) == before


def test_application_with_history_cannot_be_deleted(client):
    # Каскад заявка → события доходит до запрета: удаление заявки не уносит её историю.
    headers = auth(client, "bakery@demo.local")
    app_id = draft(client, headers)
    before = stored(app_id)
    with SessionLocal() as db:
        db.delete(db.get(Application, app_id))
        with pytest.raises(AuditLogImmutable):
            db.flush()
        db.rollback()
    assert stored(app_id) == before
    assert client.get(f"/api/applications/{app_id}", headers=headers).status_code == 200


BULK_CHANGES = {
    "orm_update": lambda db, app_id: db.execute(
        update(ApplicationEvent).where(ApplicationEvent.application_id == app_id).values(comment="x")
    ),
    "orm_delete": lambda db, app_id: db.execute(
        delete(ApplicationEvent).where(ApplicationEvent.application_id == app_id)
    ),
    "table_update": lambda db, app_id: db.execute(
        update(EVENTS).where(EVENTS.c.application_id == app_id).values(comment="x")
    ),
    "table_delete": lambda db, app_id: db.execute(delete(EVENTS).where(EVENTS.c.application_id == app_id)),
    "query_update": lambda db, app_id: db.query(ApplicationEvent).filter_by(application_id=app_id).update(
        {"comment": "x"}
    ),
    "query_delete": lambda db, app_id: db.query(ApplicationEvent).filter_by(application_id=app_id).delete(),
}


@pytest.mark.parametrize("change", list(BULK_CHANGES.values()), ids=list(BULK_CHANGES))
def test_bulk_update_and_delete_of_the_journal_are_refused(client, change):
    headers = auth(client, "bakery@demo.local")
    app_id = draft(client, headers)
    before = stored(app_id)
    with SessionLocal() as db:
        with pytest.raises(AuditLogImmutable, match="только дописывается"):
            change(db, app_id)
        db.rollback()
    assert stored(app_id) == before


def test_ten_saves_within_the_window_make_one_event(client):
    headers = auth(client, "bakery@demo.local")
    app_id = draft(client, headers)
    save(client, app_id, headers, amount=2_000_000)
    first = stored(app_id)
    for step in range(1, 10):
        save(client, app_id, headers, amount=2_000_000 + step * 10_000)
    # Ни одного нового события и ни одного переписанного: последнее состояние хранит сама анкета.
    assert stored(app_id) == first
    assert names(history(client, app_id, headers)) == ["created", "updated"]
    assert first[-1][4] == {"fields": ["amount"]}
    assert client.get(f"/api/applications/{app_id}", headers=headers).json()["amount"] == 2_090_000


def test_another_user_in_the_window_writes_own_event(client):
    owner, accountant = auth(client, "bakery@demo.local"), auth(client, "buh@demo.local")
    app_id = draft(client, owner)
    save(client, app_id, owner, amount=2_500_000)
    save(client, app_id, accountant, term_months=18)
    save(client, app_id, accountant, term_months=24)
    save(client, app_id, owner, amount=2_600_000)
    assert [(e["event"], e["actor_name"]) for e in history(client, app_id, owner)] == [
        ("created", "Ольга Северова"),
        ("updated", "Ольга Северова"),
        ("updated", "Елена Счётова"),
        ("updated", "Ольга Северова"),
    ]


def test_save_after_the_window_appends_a_new_event(client, monkeypatch):
    headers = auth(client, "bakery@demo.local")
    app_id = draft(client, headers)
    save(client, app_id, headers, amount=2_500_000)
    save(client, app_id, headers, amount=2_400_000)
    earlier = stored(app_id)
    later = utcnow() + applications_svc.DRAFT_SAVE_WINDOW + timedelta(minutes=1)
    monkeypatch.setattr(applications_svc, "utcnow", lambda: later)
    save(client, app_id, headers, term_months=18)
    now = stored(app_id)
    assert now[: len(earlier)] == earlier  # прежние события не тронуты, новое — дописано
    assert [row[1] for row in now] == ["created", "updated", "updated"]
    assert now[-1][4] == {"fields": ["term_months"]}


def test_history_stays_ordered_through_the_whole_pipeline(client, mocks):
    headers = auth(client, "bakery@demo.local")
    app_id = draft(client, headers)
    for amount in (2_800_000, 2_900_000, 3_000_000):
        save(client, app_id, headers, amount=amount)
    submitted = client.post(f"/api/applications/{app_id}/submit", headers=headers)
    assert submitted.status_code == 200, submitted.text
    run_pipeline(mocks)

    status = client.get(f"/api/applications/{app_id}", headers=headers).json()["status"]["code"]
    assert status in ("approved", "counter_offer")
    events = history(client, app_id, headers)
    ids = [e["id"] for e in events]
    assert ids == sorted(set(ids))
    stamps = [datetime.fromisoformat(e["created_at"]) for e in events]
    assert stamps == sorted(stamps)
    assert names(events)[:3] == ["created", "updated", "submitted"]
    assert names(events).count("updated") == 1
    assert names(events).count("check_completed") == 3 and "scored" in names(events)
    assert [e["to_status"] for e in events if e["to_status"]][-1] == status
