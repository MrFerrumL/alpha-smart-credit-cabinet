"""Предложение → договор → подписание кодом → выдача → кредит с графиком."""

from datetime import timedelta

from sqlalchemy import select

from app.db import SessionLocal
from app.models import Offer, SigningChallenge, utcnow
from app.pipeline.steps import expire_offers
from tests.conftest import auth, run_pipeline
from tests.test_pipeline import get, submit


def approved(client, mocks, email: str = "bakery@demo.local", **params) -> tuple[int, dict]:
    app_id, headers = submit(client, email, **params)
    run_pipeline(mocks)
    assert get(client, app_id, headers)["status"]["code"] in ("approved", "counter_offer")
    return app_id, headers


def other(code: str) -> str:
    return "000000" if code != "000000" else "111111"


def sign(client, app_id: int, headers: dict) -> dict:
    challenge = client.post(f"/api/applications/{app_id}/signing/code", headers=headers)
    assert challenge.status_code == 200, challenge.text
    response = client.post(
        f"/api/applications/{app_id}/signing/confirm",
        json={"challenge_id": challenge.json()["challenge_id"], "code": challenge.json()["demo_code"]},
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
    assert "подпишите" in accepted["status"]["hint"]

    contract = client.get(f"/api/applications/{app_id}/contract", headers=headers).json()
    assert contract["number"] == f"КД-{utcnow().year}-{app_id:06d}"
    assert contract["amount"] == 3_000_000
    assert contract["signed"] is False
    assert contract["total_payments"] > contract["amount"]

    challenge = client.post(f"/api/applications/{app_id}/signing/code", headers=headers).json()
    assert challenge["delivery"] == "in_app"
    code = challenge["demo_code"]
    # Код не хранится открытым текстом: ни в уведомлениях, ни в БД.
    notes = client.get("/api/notifications", headers=headers).json()
    assert all(code not in n["title"] + (n["body"] or "") for n in notes)
    wrong = client.post(
        f"/api/applications/{app_id}/signing/confirm",
        json={"challenge_id": challenge["challenge_id"], "code": other(code)},
        headers=headers,
    )
    assert wrong.status_code == 422
    assert "Осталось попыток: 2" in wrong.json()["detail"]

    signed = client.post(
        f"/api/applications/{app_id}/signing/confirm",
        json={"challenge_id": challenge["challenge_id"], "code": code},
        headers=headers,
    ).json()
    assert signed["offer"]["status"] == "signed"
    reused = client.post(
        f"/api/applications/{app_id}/signing/confirm",
        json={"challenge_id": challenge["challenge_id"], "code": code},
        headers=headers,
    )
    assert reused.status_code == 409
    events = client.get(f"/api/applications/{app_id}/events", headers=headers).json()
    terms_hash = client.get(f"/api/applications/{app_id}/contract", headers=headers).json()["terms_hash"]
    assert len(terms_hash) == 64
    assert {"offer_accepted", "contract_signed", "signing_code_rejected"} <= {e["event"] for e in events}
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


def test_accountant_can_neither_accept_decline_nor_sign(client, mocks):
    app_id, owner = approved(client, mocks)
    accountant = auth(client, "buh@demo.local")
    app = get(client, app_id, accountant)
    assert not {"accept_offer", "decline_offer", "sign"} & set(app["allowed_actions"])
    response = client.post(f"/api/applications/{app_id}/offer/accept", headers=accountant)
    assert response.status_code == 403
    assert "руководитель" in response.json()["detail"]
    assert client.post(f"/api/applications/{app_id}/offer/decline", headers=accountant).status_code == 403
    cancel = client.post(f"/api/applications/{app_id}/cancel", headers=accountant)
    assert cancel.status_code == 403
    assert "руководитель" in cancel.json()["detail"]
    client.post(f"/api/applications/{app_id}/offer/accept", headers=owner)
    assert client.post(f"/api/applications/{app_id}/signing/code", headers=accountant).status_code == 403


def test_strangers_and_analysts_cannot_touch_the_contract(client, mocks):
    app_id, owner = approved(client, mocks)
    stranger = auth(client, "sklad@demo.local")
    analyst = auth(client, "analyst@demo.local")
    assert client.post(f"/api/applications/{app_id}/offer/accept", headers=stranger).status_code == 404
    assert client.post(f"/api/applications/{app_id}/offer/accept", headers=analyst).status_code == 403
    client.post(f"/api/applications/{app_id}/offer/accept", headers=owner)
    assert client.get(f"/api/applications/{app_id}/contract", headers=stranger).status_code == 404
    assert client.post(f"/api/applications/{app_id}/signing/code", headers=stranger).status_code == 404
    assert client.post(f"/api/applications/{app_id}/signing/code", headers=analyst).status_code == 403


def test_code_cannot_be_used_after_cancel_or_expiry(client, mocks):
    app_id, headers = approved(client, mocks)
    client.post(f"/api/applications/{app_id}/offer/accept", headers=headers)
    challenge = client.post(f"/api/applications/{app_id}/signing/code", headers=headers).json()
    with SessionLocal() as db:
        db.get(SigningChallenge, challenge["challenge_id"]).expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    expired = client.post(
        f"/api/applications/{app_id}/signing/confirm",
        json={"challenge_id": challenge["challenge_id"], "code": challenge["demo_code"]},
        headers=headers,
    )
    assert expired.status_code == 409
    fresh = client.post(f"/api/applications/{app_id}/signing/code", headers=headers).json()
    cancelled = client.post(f"/api/applications/{app_id}/cancel", headers=headers)
    assert cancelled.status_code == 200
    # Отзыв равен отказу от предложения: договор больше не ждёт подписи и по прямой ссылке не открывается.
    assert cancelled.json()["offer"]["status"] == "declined" and cancelled.json()["allowed_actions"] == []
    assert client.get(f"/api/applications/{app_id}/contract", headers=headers).status_code == 404
    after_cancel = client.post(
        f"/api/applications/{app_id}/signing/confirm",
        json={"challenge_id": fresh["challenge_id"], "code": fresh["demo_code"]},
        headers=headers,
    )
    assert after_cancel.status_code == 409
    assert client.post(f"/api/applications/{app_id}/signing/code", headers=headers).status_code == 409


def test_cancel_at_offer_stage_declines_the_offer(client, mocks):
    app_id, headers = approved(client, mocks)
    cancelled = client.post(f"/api/applications/{app_id}/cancel", headers=headers)
    assert cancelled.status_code == 200
    assert cancelled.json()["status"]["code"] == "cancelled" and cancelled.json()["offer"]["status"] == "declined"
    assert client.post(f"/api/applications/{app_id}/offer/accept", headers=headers).status_code == 409


def test_consumed_code_is_rejected_even_if_the_offer_still_waits(client, mocks):
    app_id, headers = approved(client, mocks)
    client.post(f"/api/applications/{app_id}/offer/accept", headers=headers)
    challenge = client.post(f"/api/applications/{app_id}/signing/code", headers=headers).json()
    with SessionLocal() as db:  # как будто параллельный запрос уже погасил этот код
        db.get(SigningChallenge, challenge["challenge_id"]).used_at = utcnow()
        db.commit()
    response = client.post(
        f"/api/applications/{app_id}/signing/confirm",
        json={"challenge_id": challenge["challenge_id"], "code": challenge["demo_code"]},
        headers=headers,
    )
    assert response.status_code == 409
    assert get(client, app_id, headers)["offer"]["status"] == "accepted"


def test_code_is_bound_to_the_contract_terms(client, mocks):
    app_id, headers = approved(client, mocks)
    client.post(f"/api/applications/{app_id}/offer/accept", headers=headers)
    challenge = client.post(f"/api/applications/{app_id}/signing/code", headers=headers).json()
    with SessionLocal() as db:  # условия изменились после выдачи кода
        offer = db.scalar(select(Offer).where(Offer.application_id == app_id))
        offer.amount = offer.amount + 100_000
        db.commit()
    response = client.post(
        f"/api/applications/{app_id}/signing/confirm",
        json={"challenge_id": challenge["challenge_id"], "code": challenge["demo_code"]},
        headers=headers,
    )
    assert response.status_code == 422
    assert get(client, app_id, headers)["offer"]["status"] == "accepted"


def test_signing_codes_are_rate_limited(client, mocks):
    app_id, headers = approved(client, mocks)
    client.post(f"/api/applications/{app_id}/offer/accept", headers=headers)
    responses = [client.post(f"/api/applications/{app_id}/signing/code", headers=headers) for _ in range(6)]
    assert [r.status_code for r in responses[:5]] == [200] * 5
    assert responses[5].status_code == 429
    # Сообщение говорит, когда можно запросить код снова, и не отправляет клиента за пределы кабинета.
    body = responses[5].json()
    assert body["code"] == "too_many_requests"
    assert "через 60 мин." in body["detail"] and "обратитесь в банк" not in body["detail"]
    with SessionLocal() as db:  # окно скользящее: через час после первых кодов можно запросить новый
        for challenge in db.scalars(select(SigningChallenge).where(SigningChallenge.application_id == app_id)):
            challenge.created_at = utcnow() - timedelta(minutes=61)
        db.commit()
    assert client.post(f"/api/applications/{app_id}/signing/code", headers=headers).status_code == 200


def test_accepted_but_unsigned_contract_expires_with_the_offer(client, mocks):
    app_id, headers = approved(client, mocks)
    client.post(f"/api/applications/{app_id}/offer/accept", headers=headers)
    with SessionLocal() as db:
        offer = db.scalar(select(Offer).where(Offer.application_id == app_id))
        offer.valid_until = utcnow() - timedelta(minutes=1)
        db.commit()
    assert client.post(f"/api/applications/{app_id}/signing/code", headers=headers).status_code == 409
    with SessionLocal() as db:
        assert expire_offers(db) >= 1
    assert get(client, app_id, headers)["status"]["code"] == "expired"


def test_declining_offer_closes_application(client, mocks):
    app_id, headers = approved(client, mocks)
    declined = client.post(
        f"/api/applications/{app_id}/offer/decline", json={"comment": "Дорого"}, headers=headers
    ).json()
    assert declined["status"]["code"] == "cancelled"
    assert declined["offer"]["status"] == "declined"
    # На таймлайне заявка остановилась на «Решении», где от предложения отказались, а не на «Заявке».
    assert declined["status"]["stage"] == get(client, app_id, headers)["status"]["stage"] == 4
    assert client.post(f"/api/applications/{app_id}/offer/accept", headers=headers).status_code == 409


def test_code_attempts_run_out_and_new_code_replaces_old(client, mocks):
    app_id, headers = approved(client, mocks)
    client.post(f"/api/applications/{app_id}/offer/accept", headers=headers)
    first = client.post(f"/api/applications/{app_id}/signing/code", headers=headers).json()
    first_code = first["demo_code"]
    second = client.post(f"/api/applications/{app_id}/signing/code", headers=headers).json()
    stale = client.post(
        f"/api/applications/{app_id}/signing/confirm",
        json={"challenge_id": first["challenge_id"], "code": first_code},
        headers=headers,
    )
    assert stale.status_code == 409
    wrong = other(second["demo_code"])
    for _ in range(3):
        client.post(
            f"/api/applications/{app_id}/signing/confirm",
            json={"challenge_id": second["challenge_id"], "code": wrong},
            headers=headers,
        )
    exhausted = client.post(
        f"/api/applications/{app_id}/signing/confirm",
        json={"challenge_id": second["challenge_id"], "code": second["demo_code"]},
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


def test_long_bank_system_outage_delays_issue_but_never_strands_it(client, mocks):
    app_id, headers = approved(client, mocks)
    client.post(f"/api/applications/{app_id}/offer/accept", headers=headers)
    sign(client, app_id, headers)
    mocks.post("/admin/faults", json={"source": "abs", "mode": "error"})
    run_pipeline(mocks)
    status = get(client, app_id, headers)["status"]
    assert status["code"] == "signing"
    assert "подпишите" not in status["hint"] and status["action_required"] is False  # клиенту ничего делать не нужно
    assert client.get(f"/api/applications/{app_id}/contract", headers=headers).json()["issue_delayed"] is True
    mocks.post("/admin/faults", json={"source": "abs", "mode": "none"})
    with SessionLocal() as db:  # следующая попытка выдачи по расписанию — не ждём паузу в тесте
        from app.models import Job

        for job in db.scalars(select(Job).where(Job.application_id == app_id, Job.status == "pending")):
            job.run_after = utcnow()
        db.commit()
    run_pipeline(mocks)
    assert get(client, app_id, headers)["status"]["code"] == "issued"
    assert client.get(f"/api/applications/{app_id}/contract", headers=headers).json()["issue_delayed"] is False


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


def test_unanswered_bank_request_closes_the_application(client, mocks):
    from app.models import Application, ClientTask
    from app.pipeline.steps import expire_requests

    app_id, headers = submit(client, "bakery@demo.local", form={"consent_bki": True})
    run_pipeline(mocks)
    assert get(client, app_id, headers)["status"]["code"] == "needs_info"
    with SessionLocal() as db:
        assert expire_requests(db) == 0  # срок ещё не вышел
        for task in db.scalars(select(ClientTask).where(ClientTask.application_id == app_id)):
            task.created_at = utcnow() - timedelta(days=15)
        db.commit()
        assert expire_requests(db) == 1
        assert db.get(Application, app_id).status == "expired"
    assert get(client, app_id, headers)["open_tasks"] == 0


def test_accountant_hands_offer_to_the_director(client, mocks):
    app_id, owner = approved(client, mocks)
    accountant = auth(client, "buh@demo.local")
    app = get(client, app_id, accountant)
    assert "handoff_to_signer" in app["allowed_actions"] and app["awaiting_signer"] is False
    handed = client.post(f"/api/applications/{app_id}/offer/handoff", headers=accountant)
    assert handed.status_code == 200, handed.text
    assert handed.json()["awaiting_signer"] is True
    assert "handoff_to_signer" not in handed.json()["allowed_actions"]
    assert client.post(f"/api/applications/{app_id}/offer/handoff", headers=accountant).status_code == 409

    notes = client.get("/api/notifications", headers=owner).json()
    request = next(n for n in notes if n["kind"] == "signature_requested")
    assert "Елена Счётова" in request["title"]
    events = client.get(f"/api/applications/{app_id}/events", headers=owner).json()
    handoff = next(e for e in events if e["event"] == "handed_to_signer")
    assert handoff["actor_name"] == "Елена Счётова"
    assert client.post(f"/api/applications/{app_id}/offer/handoff", headers=owner).status_code == 409  # сам может

    accepted = client.post(f"/api/applications/{app_id}/offer/accept", headers=owner)
    assert accepted.status_code == 200
    sign(client, app_id, owner)
    with SessionLocal() as db:
        from app.models import ApplicationEvent

        signed = db.query(ApplicationEvent).filter_by(application_id=app_id, event="contract_signed").one()
        assert signed.payload["signer_authority"] == "руководитель по ЕГРЮЛ: Северова Ольга Николаевна"


def test_signing_right_is_checked_against_the_registry_director(client, mocks):
    from app.models import Company, User
    from app.security import hash_password

    app_id, _ = approved(client, mocks)
    with SessionLocal() as db:  # у пользователя есть флаг права подписи, но по ЕГРЮЛ руководитель другой
        company = db.scalar(select(Company).where(Company.inn == "0077010019"))
        db.add(User(email="ex-director@demo.local", full_name="Пётр Бывший", position="Бывший директор",
                    role="client", can_sign=True, password_hash=hash_password("demo1234"), company_id=company.id))
        db.commit()
    token = client.post("/api/auth/login", json={"email": "ex-director@demo.local", "password": "demo1234"}).json()
    former = {"Authorization": f"Bearer {token['access_token']}"}
    response = client.post(f"/api/applications/{app_id}/offer/accept", headers=former)
    assert response.status_code == 403
    detail = response.json()["detail"]
    assert "Северова Ольга Николаевна" in detail and " он" not in detail  # пол руководителя по ФИО не известен
    actions = get(client, app_id, former)["allowed_actions"]
    assert "handoff_to_signer" in actions and not {"accept_offer", "decline_offer", "cancel"} & set(actions)
    assert client.post(f"/api/applications/{app_id}/offer/decline", headers=former).status_code == 403
    assert client.post(f"/api/applications/{app_id}/cancel", headers=former).status_code == 403
    assert client.post(f"/api/applications/{app_id}/offer/handoff", headers=former).status_code == 200
    with SessionLocal() as db:
        from app.models import Notification

        ex = db.scalar(select(User).where(User.email == "ex-director@demo.local"))
        olga = db.scalar(select(User).where(User.email == "bakery@demo.local"))
        requests = db.scalars(select(Notification).where(Notification.kind == "signature_requested")).all()
        assert any(n.user_id == olga.id for n in requests)
        assert not any(n.user_id == ex.id for n in requests)  # бывшему директору запрос не уходит


def test_secured_loan_is_issued_only_after_issue_conditions_are_closed(client, mocks):
    from tests.test_analyst import vector_in_review

    app_id, headers = vector_in_review(client, mocks)
    analyst = auth(client, "analyst@demo.local")
    decided = client.post(f"/api/applications/{app_id}/decision", headers=analyst, json={
        "outcome": "counter_offer", "amount": 19_500_000, "term_months": 60,
        "comment": "Рекомендация конвейера: покрытие прибылью 1,2",
    })
    assert decided.status_code == 200, decided.text
    assert client.post(f"/api/applications/{app_id}/offer/accept", headers=headers).status_code == 200
    tasks = client.get(f"/api/applications/{app_id}/tasks", headers=headers).json()
    conditions = [t for t in tasks if (t["payload"] or {}).get("condition") == "before_issue"]
    assert {t["kind"] for t in conditions} == {"document", "question"}
    contract = client.get(f"/api/applications/{app_id}/contract", headers=headers).json()
    subject = " ".join(next(s for s in contract["sections"] if s["title"] == "2. Предмет договора")["paragraphs"])
    assert "после выполнения условий выдачи" in subject and "в день подписания" not in subject

    sign(client, app_id, headers)
    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "signing" and app["open_tasks"] == 2  # подписан, но денег нет
    assert {"answer_tasks", "confirm_guarantee"} <= set(app["allowed_actions"]) and "sign" not in app["allowed_actions"]
    # Подсказка статуса больше не просит подписать: подписывать нечего, нужно закрыть условия выдачи.
    hint = app["status"]["hint"]
    assert app["status"]["title"] == "Подписание договора" and app["status"]["action_required"] is True
    assert "условия выдачи" in hint and "подпишите" not in hint
    listed = next(a for a in client.get("/api/applications", headers=headers).json() if a["id"] == app_id)
    assert listed["status"]["hint"] == hint
    assert "issue_waiting_conditions" in [e["event"] for e in client.get(
        f"/api/applications/{app_id}/events", headers=headers).json()]

    document = next(t for t in conditions if t["kind"] == "document")
    question = next(t for t in conditions if t["kind"] == "question")
    uploaded = client.post(f"/api/applications/{app_id}/documents", headers=headers,
                           files={"file": ("zalog.pdf", b"%PDF-1.4 collateral", "application/pdf")},
                           data={"kind": "collateral", "task_id": str(document["id"])})
    assert uploaded.status_code == 201, uploaded.text
    run_pipeline(mocks)
    assert get(client, app_id, headers)["status"]["code"] == "signing"  # одно условие ещё открыто
    answered = client.post(f"/api/applications/{app_id}/tasks/{question['id']}/answer", headers=headers,
                           json={"answer": "Волков Игорь Сергеевич"})
    assert answered.status_code == 200, answered.text
    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "issued" and app["loan_id"]


def test_collateral_documents_from_the_form_are_not_requested_again(client, mocks):
    headers = auth(client, "vector@demo.local")
    created = client.post("/api/applications", headers=headers, json={
        "product_code": "invest", "purpose": "equipment", "amount": 25_000_000, "term_months": 48,
        "form": {"finance": {"monthly_revenue": 8_000_000}, "collateral": {"kind": "equipment", "value": 30_000_000},
                 "consent_bki": True},
    })
    app_id = created.json()["id"]
    uploaded = client.post(f"/api/applications/{app_id}/documents", headers=headers,
                           files={"file": ("zalog.pdf", b"%PDF-1.4 collateral", "application/pdf")},
                           data={"kind": "collateral"})
    assert uploaded.status_code == 201, uploaded.text
    assert client.post(f"/api/applications/{app_id}/submit", headers=headers).status_code == 200
    run_pipeline(mocks)
    assert get(client, app_id, headers)["status"]["code"] == "manual_review"
    client.post(f"/api/applications/{app_id}/decision", headers=auth(client, "analyst@demo.local"), json={
        "outcome": "counter_offer", "amount": 19_500_000, "term_months": 60, "comment": "Рекомендация конвейера",
    })
    assert client.post(f"/api/applications/{app_id}/offer/accept", headers=headers).status_code == 200

    tasks = client.get(f"/api/applications/{app_id}/tasks", headers=headers).json()
    document = next(t for t in tasks if t["kind"] == "document")
    question = next(t for t in tasks if t["kind"] == "question")
    assert document["status"] == "done" and document["answer"] == "zalog.pdf"  # залог уже приложен в анкете
    assert question["status"] == "open"
    assert get(client, app_id, headers)["open_tasks"] == 1

    # Выдачу держит только поручительство. До выдачи не доводим: второй кредит «Вектора» изменил бы его оценку
    # в следующих тестах — сама выдача после закрытия условий проверена в тесте выше.
    sign(client, app_id, headers)
    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "signing" and app["open_tasks"] == 1
    assert len(client.get(f"/api/applications/{app_id}/documents", headers=headers).json()) == 1


def test_only_the_director_confirms_the_owner_guarantee(client, mocks):
    app_id, accountant = submit(
        client, "buh@demo.local", product_code="invest", purpose="equipment", amount=5_000_000, term_months=48,
        form={"finance": {"monthly_revenue": 4_500_000}, "collateral": {"kind": "equipment", "value": 6_000_000},
              "consent_bki": True},
    )
    run_pipeline(mocks)
    assert get(client, app_id, accountant)["status"]["code"] == "manual_review"
    decided = client.post(f"/api/applications/{app_id}/decision", headers=auth(client, "analyst@demo.local"),
                          json={"outcome": "approve", "comment": "Залог покрывает сумму, нагрузка в пределах политики"})
    assert decided.status_code == 200, decided.text
    owner = auth(client, "bakery@demo.local")
    assert client.post(f"/api/applications/{app_id}/offer/accept", headers=owner).status_code == 200

    # Бухгалтер закрывает документы, но формы поручительства у него нет — это действие руководителя.
    actions = get(client, app_id, accountant)["allowed_actions"]
    assert "answer_tasks" in actions and "confirm_guarantee" not in actions
    assert "confirm_guarantee" in get(client, app_id, owner)["allowed_actions"]
    tasks = client.get(f"/api/applications/{app_id}/tasks", headers=accountant).json()
    document = next(t for t in tasks if t["kind"] == "document")
    question = next(t for t in tasks if t["kind"] == "question")
    refused = client.post(f"/api/applications/{app_id}/tasks/{question['id']}/answer", headers=accountant,
                          json={"answer": "Северова Ольга Николаевна"})
    assert refused.status_code == 403 and refused.json()["code"] == "forbidden"
    uploaded = client.post(f"/api/applications/{app_id}/documents", headers=accountant,
                           files={"file": ("zalog.pdf", b"%PDF-1.4 collateral", "application/pdf")},
                           data={"kind": "collateral", "task_id": str(document["id"])})
    assert uploaded.status_code == 201, uploaded.text
    answered = client.post(f"/api/applications/{app_id}/tasks/{question['id']}/answer", headers=owner,
                           json={"answer": "Северова Ольга Николаевна"})
    assert answered.status_code == 200, answered.text
    assert get(client, app_id, owner)["open_tasks"] == 0


def test_unsecured_loan_has_no_issue_conditions(client, mocks):
    app_id, headers = approved(client, mocks)
    client.post(f"/api/applications/{app_id}/offer/accept", headers=headers)
    assert get(client, app_id, headers)["open_tasks"] == 0


def test_disburse_step_refuses_while_conditions_are_open(client, mocks):
    from app.pipeline.queue import enqueue
    from tests.test_analyst import vector_in_review

    app_id, headers = vector_in_review(client, mocks)
    client.post(f"/api/applications/{app_id}/decision", headers=auth(client, "analyst@demo.local"), json={
        "outcome": "counter_offer", "amount": 19_500_000, "term_months": 60, "comment": "Рекомендация конвейера",
    })
    client.post(f"/api/applications/{app_id}/offer/accept", headers=headers)
    sign(client, app_id, headers)
    with SessionLocal() as db:  # выдачу кто-то поставил в очередь вручную — шаг всё равно не переведёт деньги
        enqueue(db, "pipeline.disburse", app_id)
        db.commit()
    run_pipeline(mocks)
    assert get(client, app_id, headers)["status"]["code"] == "signing"
    tasks = client.get(f"/api/applications/{app_id}/tasks", headers=headers).json()
    question = next(t for t in tasks if t["kind"] == "question")
    accountant = auth(client, "buh@demo.local")  # другая компания — 404, а свой бухгалтер у «Вектора» не заведён
    assert client.post(f"/api/applications/{app_id}/tasks/{question['id']}/answer", headers=accountant,
                       json={"answer": "x"}).status_code == 404
    blank = client.post(f"/api/applications/{app_id}/tasks/{question['id']}/answer", headers=headers,
                        json={"answer": "   "})
    assert blank.status_code == 422


def test_conditions_close_when_the_contract_expires(client, mocks):
    from tests.test_analyst import vector_in_review

    app_id, headers = vector_in_review(client, mocks)
    client.post(f"/api/applications/{app_id}/decision", headers=auth(client, "analyst@demo.local"), json={
        "outcome": "counter_offer", "amount": 19_500_000, "term_months": 60, "comment": "Рекомендация конвейера",
    })
    client.post(f"/api/applications/{app_id}/offer/accept", headers=headers)
    assert get(client, app_id, headers)["open_tasks"] == 2
    with SessionLocal() as db:
        offer = db.scalar(select(Offer).where(Offer.application_id == app_id).order_by(Offer.id.desc()))
        offer.valid_until = utcnow() - timedelta(minutes=1)
        db.commit()
        expire_offers(db)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "expired" and app["open_tasks"] == 0


def test_issued_overdraft_says_the_limit_is_opened(client, mocks):
    # Овердрафт не перечисляется на счёт, а открывается лимитом: статус, история и уведомление говорят об этом.
    app_id, headers = approved(client, mocks, "clean@demo.local", amount=300_000,
                               form={"finance": {"monthly_revenue": 1_000_000}, "consent_bki": True})
    assert client.post(f"/api/applications/{app_id}/offer/accept", headers=headers).status_code == 200
    sign(client, app_id, headers)
    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "issued" and app["status"]["title"] == "Лимит открыт"
    titles = [e["title"] for e in client.get(f"/api/applications/{app_id}/events", headers=headers).json()]
    assert "Лимит овердрафта открыт на расчётном счёте" in titles
    notes = client.get("/api/notifications", headers=headers).json()
    assert any("лимит открыт" in n["title"] for n in notes)

