"""Предложение → договор → подписание кодом → выдача → кредит с графиком."""

import re
from datetime import timedelta

from sqlalchemy import select

from app.db import SessionLocal
from app.models import Offer, utcnow
from app.pipeline.steps import expire_offers
from tests.conftest import auth, run_pipeline
from tests.test_pipeline import get, submit


def approved(client, mocks, email: str = "bakery@demo.local", **params) -> tuple[int, dict]:
    app_id, headers = submit(client, email, **params)
    run_pipeline(mocks)
    assert get(client, app_id, headers)["status"]["code"] in ("approved", "counter_offer")
    return app_id, headers


def latest_code(client, headers: dict) -> str:
    items = client.get("/api/notifications", headers=headers).json()
    code_note = next(n for n in items if n["kind"] == "signing_code")
    return re.search(r"\d{6}", code_note["title"]).group()


def sign(client, app_id: int, headers: dict) -> dict:
    challenge = client.post(f"/api/applications/{app_id}/signing/code", headers=headers)
    assert challenge.status_code == 200, challenge.text
    response = client.post(
        f"/api/applications/{app_id}/signing/confirm",
        json={"challenge_id": challenge.json()["challenge_id"], "code": latest_code(client, headers)},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_full_path_from_offer_to_loan(client, mocks):
    app_id, headers = approved(client, mocks)
    app = get(client, app_id, headers)
    assert {"accept_offer", "decline_offer"} <= set(app["allowed_actions"])
    assert any(n["kind"] == "status" for n in client.get("/api/notifications", headers=headers).json())

    accepted = client.post(f"/api/applications/{app_id}/offer/accept", headers=headers).json()
    assert accepted["status"]["code"] == "signing"
    assert "sign" in accepted["allowed_actions"]

    contract = client.get(f"/api/applications/{app_id}/contract", headers=headers).json()
    assert contract["number"] == f"КД-{utcnow().year}-{app_id:06d}"
    assert contract["amount"] == 3_000_000
    assert contract["signed"] is False
    assert contract["total_payments"] > contract["amount"]

    challenge = client.post(f"/api/applications/{app_id}/signing/code", headers=headers).json()
    assert challenge["delivery"] == "in_app"
    wrong = client.post(
        f"/api/applications/{app_id}/signing/confirm",
        json={"challenge_id": challenge["challenge_id"], "code": "000000" if latest_code(client, headers) != "000000" else "111111"},
        headers=headers,
    )
    assert wrong.status_code == 422
    assert "Осталось попыток: 2" in wrong.json()["detail"]

    signed = client.post(
        f"/api/applications/{app_id}/signing/confirm",
        json={"challenge_id": challenge["challenge_id"], "code": latest_code(client, headers)},
        headers=headers,
    ).json()
    assert signed["offer"]["status"] == "signed"
    assert "cancel" not in signed["allowed_actions"]
    assert client.post(f"/api/applications/{app_id}/cancel", headers=headers).status_code == 409

    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "issued"
    assert app["loan_id"] is not None
    assert client.get(f"/api/applications/{app_id}/contract", headers=headers).json()["signed"] is True

    loans = client.get("/api/loans", headers=headers).json()
    loan = next(item for item in loans if item["id"] == app["loan_id"])
    assert loan["amount"] == 3_000_000
    assert loan["balance"] == 3_000_000
    detail = client.get(f"/api/loans/{loan['id']}", headers=headers).json()
    assert len(detail["schedule"]) == 12
    assert detail["schedule"][-1]["balance"] == 0
    assert detail["next_payment_date"] == detail["schedule"][0]["date"]
    months = [row["date"][:7] for row in detail["schedule"]]
    assert len(set(months)) == 12  # по одному платежу в месяц

    titles = [n["title"] for n in client.get("/api/notifications", headers=headers).json()]
    assert any("деньги зачислены" in t for t in titles)
    assert client.get(f"/api/loans/{loan['id']}", headers=auth(client, "sklad@demo.local")).status_code == 404


def test_counter_offer_is_issued_on_offered_terms(client, mocks):
    app_id, headers = approved(client, mocks, "sklad@demo.local", amount=10_000_000)
    assert client.post(f"/api/applications/{app_id}/offer/accept", headers=headers).status_code == 200
    sign(client, app_id, headers)
    run_pipeline(mocks)
    loan_id = get(client, app_id, headers)["loan_id"]
    assert client.get(f"/api/loans/{loan_id}", headers=headers).json()["amount"] == 4_500_000


def test_accountant_can_decline_but_not_accept_or_sign(client, mocks):
    app_id, _ = approved(client, mocks)
    accountant = auth(client, "buh@demo.local")
    app = get(client, app_id, accountant)
    assert "accept_offer" not in app["allowed_actions"]
    assert "decline_offer" in app["allowed_actions"]
    response = client.post(f"/api/applications/{app_id}/offer/accept", headers=accountant)
    assert response.status_code == 403
    assert "руководитель" in response.json()["detail"]


def test_declining_offer_closes_application(client, mocks):
    app_id, headers = approved(client, mocks)
    declined = client.post(
        f"/api/applications/{app_id}/offer/decline", json={"comment": "Дорого"}, headers=headers
    ).json()
    assert declined["status"]["code"] == "cancelled"
    assert declined["offer"]["status"] == "declined"
    assert client.post(f"/api/applications/{app_id}/offer/accept", headers=headers).status_code == 409


def test_code_attempts_run_out_and_new_code_replaces_old(client, mocks):
    app_id, headers = approved(client, mocks)
    client.post(f"/api/applications/{app_id}/offer/accept", headers=headers)
    first = client.post(f"/api/applications/{app_id}/signing/code", headers=headers).json()
    first_code = latest_code(client, headers)
    second = client.post(f"/api/applications/{app_id}/signing/code", headers=headers).json()
    stale = client.post(
        f"/api/applications/{app_id}/signing/confirm",
        json={"challenge_id": first["challenge_id"], "code": first_code},
        headers=headers,
    )
    assert stale.status_code == 409
    wrong = "000000" if latest_code(client, headers) != "000000" else "111111"
    for _ in range(3):
        client.post(
            f"/api/applications/{app_id}/signing/confirm",
            json={"challenge_id": second["challenge_id"], "code": wrong},
            headers=headers,
        )
    exhausted = client.post(
        f"/api/applications/{app_id}/signing/confirm",
        json={"challenge_id": second["challenge_id"], "code": latest_code(client, headers)},
        headers=headers,
    )
    assert exhausted.status_code == 409
    assert get(client, app_id, headers)["status"]["code"] == "signing"


def test_bank_system_outage_during_disbursement_is_retried(client, mocks):
    app_id, headers = approved(client, mocks)
    client.post(f"/api/applications/{app_id}/offer/accept", headers=headers)
    sign(client, app_id, headers)
    mocks.post("/admin/faults", json={"source": "abs", "mode": "error", "count": 1})
    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "issued"
    events = [e["event"] for e in client.get(f"/api/applications/{app_id}/events", headers=headers).json()]
    assert "disbursement_retry" in events
    assert events[-1] == "issued"


def test_expired_offer_cannot_be_accepted(client, mocks):
    app_id, headers = approved(client, mocks)
    with SessionLocal() as db:
        offer = db.scalar(select(Offer).where(Offer.application_id == app_id))
        offer.valid_until = utcnow() - timedelta(minutes=1)
        db.commit()
        assert expire_offers(db) >= 1
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "expired"
    assert app["offer"]["status"] == "expired"
    assert client.post(f"/api/applications/{app_id}/offer/accept", headers=headers).status_code == 409


def test_notifications_can_be_marked_read(client, mocks):
    _, headers = approved(client, mocks)
    assert any(n["read_at"] is None for n in client.get("/api/notifications", headers=headers).json())
    assert client.post("/api/notifications/read-all", headers=headers).status_code == 204
    assert all(n["read_at"] for n in client.get("/api/notifications", headers=headers).json())
