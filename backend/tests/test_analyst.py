"""Кабинет аналитика: карточка заявки и ручное решение, видимое клиенту."""

from tests.conftest import auth, run_pipeline
from tests.test_pipeline import events, get, submit

COMMENT = "Залог покрывает сумму, нагрузка в пределах политики"


def vector_in_review(client, mocks) -> tuple[int, dict]:
    app_id, headers = submit(
        client,
        "vector@demo.local",
        product_code="invest",
        purpose="equipment",
        amount=25_000_000,
        term_months=48,
        form={"finance": {"monthly_revenue": 8_000_000}, "collateral": {"kind": "equipment", "value": 30_000_000},
              "consent_bki": True},
    )
    run_pipeline(mocks)
    assert get(client, app_id, headers)["status"]["code"] == "manual_review"
    return app_id, headers


def decide(client, app_id: int, analyst: dict, **body):
    return client.post(f"/api/applications/{app_id}/decision", json={"comment": COMMENT} | body, headers=analyst)


def test_analyst_card_explains_why_and_what_the_pipeline_recommends(client, mocks):
    app_id, client_headers = vector_in_review(client, mocks)
    analyst = auth(client, "analyst@demo.local")
    card = client.get(f"/api/applications/{app_id}/assessment", headers=analyst).json()
    assert card["review_reason"] == "manual_product"
    assert card["scored"] is True and card["grade"] == "C"
    assert card["factors"] and all({"points", "client_text"} <= set(f) for f in card["factors"])
    assert card["stop_checks"] and all(c["passed"] for c in card["stop_checks"])
    assert card["recommendation"]["amount"] == 25_000_000
    assert card["min_rate"] == 23.5
    assert card["revenue"]["source"] == "fns"
    assert card["can_decide"] is True
    assert client.get(f"/api/applications/{app_id}/assessment", headers=client_headers).status_code == 403
    assert decide(client, app_id, client_headers, outcome="approve").status_code == 403


def test_analyst_approval_reaches_client_with_offer_and_private_comment(client, mocks):
    app_id, client_headers = vector_in_review(client, mocks)
    analyst = auth(client, "analyst@demo.local")
    response = decide(client, app_id, analyst, outcome="approve", client_message="Одобрено специалистом")
    assert response.status_code == 200, response.text

    app = get(client, app_id, client_headers)
    assert app["status"]["code"] == "approved"
    assert app["offer"]["amount"] == 25_000_000 and app["offer"]["rate"] == 23.5
    assert "accept_offer" in app["allowed_actions"]
    assert app["decision"]["reasons"] == ["Одобрено специалистом"]

    client_view = client.get(f"/api/applications/{app_id}/events", headers=client_headers).json()
    assert all(e["internal_comment"] is None for e in client_view)
    assert COMMENT not in str(client_view)
    bank_view = client.get(f"/api/applications/{app_id}/events", headers=analyst).json()
    decision_event = next(e for e in bank_view if e["event"] == "analyst_decision")
    assert decision_event["internal_comment"] == COMMENT
    assert decision_event["actor_name"] == "Мария Кредитова"

    assert decide(client, app_id, analyst, outcome="approve").status_code == 409  # решение уже принято


def test_counter_offer_by_analyst_is_flagged_as_deviation(client, mocks):
    app_id, client_headers = vector_in_review(client, mocks)
    analyst = auth(client, "analyst@demo.local")
    response = decide(client, app_id, analyst, outcome="counter_offer", amount=20_000_000, term_months=60)
    assert response.status_code == 200, response.text
    app = get(client, app_id, client_headers)
    assert app["status"]["code"] == "counter_offer"
    assert (app["offer"]["amount"], app["offer"]["term_months"]) == (20_000_000, 60)
    from app.db import SessionLocal
    from app.models import ApplicationEvent

    with SessionLocal() as db:
        event = db.query(ApplicationEvent).filter_by(application_id=app_id, event="analyst_decision").one()
        assert event.payload["deviation"] is True
        assert event.payload["terms"]["amount"] == 20_000_000


def test_analyst_cannot_break_credit_policy(client, mocks):
    app_id, _ = vector_in_review(client, mocks)
    analyst = auth(client, "analyst@demo.local")
    short = client.post(f"/api/applications/{app_id}/decision", json={"outcome": "approve", "comment": "ок"},
                        headers=analyst)
    assert short.status_code == 422  # обоснование обязательно
    assert decide(client, app_id, analyst, outcome="approve", rate=20).status_code == 422  # ниже ставки грейда
    too_heavy = decide(client, app_id, analyst, outcome="counter_offer", amount=24_000_000, term_months=12, rate=90)
    assert too_heavy.status_code == 422
    assert "выручки" in too_heavy.json()["detail"]
    assert decide(client, app_id, analyst, outcome="reject").status_code == 422  # без причины для клиента


def test_rejection_by_analyst_shows_reasons_to_client(client, mocks):
    app_id, client_headers = vector_in_review(client, mocks)
    analyst = auth(client, "analyst@demo.local")
    response = decide(client, app_id, analyst, outcome="reject", reasons=["Высокая долговая нагрузка группы"],
                      tips=["Погасите часть кредитной линии"])
    assert response.status_code == 200, response.text
    app = get(client, app_id, client_headers)
    assert app["status"]["code"] == "rejected"
    assert app["decision"]["reasons"] == ["Высокая долговая нагрузка группы"]
    assert app["decision"]["tips"] == ["Погасите часть кредитной линии"]


def test_information_request_returns_to_analyst_after_client_answers(client, mocks):
    app_id, client_headers = vector_in_review(client, mocks)
    analyst = auth(client, "analyst@demo.local")
    response = decide(client, app_id, analyst, outcome="request_info", task_kind="question",
                      task_title="Укажите, кто поставщик оборудования")
    assert response.status_code == 200, response.text
    app = get(client, app_id, client_headers)
    assert app["status"]["code"] == "needs_info" and app["open_tasks"] == 1
    task = client.get(f"/api/applications/{app_id}/tasks", headers=client_headers).json()[-1]
    answered = client.post(f"/api/applications/{app_id}/tasks/{task['id']}/answer",
                           json={"answer": "ООО «СтанкоМаш», договор поставки № 15"}, headers=client_headers)
    assert answered.status_code == 200, answered.text
    run_pipeline(mocks)
    assert get(client, app_id, client_headers)["status"]["code"] == "manual_review"


def test_source_outage_case_needs_checks_before_any_approval(client, mocks):
    mocks.post("/admin/faults", json={"source": "bki", "mode": "error"})
    app_id, client_headers = submit(client, "bakery@demo.local")
    run_pipeline(mocks)
    assert get(client, app_id, client_headers)["status"]["code"] == "manual_review"
    analyst = auth(client, "analyst@demo.local")
    card = client.get(f"/api/applications/{app_id}/assessment", headers=analyst).json()
    assert card["review_reason"] == "source_failure" and card["scored"] is False
    assert card["failed_sources"] == ["Бюро кредитных историй"]
    assert decide(client, app_id, analyst, outcome="approve").status_code == 409

    mocks.post("/admin/faults", json={"source": "all", "mode": "none"})
    assert decide(client, app_id, analyst, outcome="retry_checks").status_code == 200
    run_pipeline(mocks)
    assert get(client, app_id, client_headers)["status"]["code"] == "approved"
    assert "analyst_decision" in events(client, app_id, client_headers)


def test_analyst_cannot_exceed_revenue_limit_or_requested_amount(client, mocks):
    app_id, headers = submit(
        client,
        "vector@demo.local",
        product_code="invest",
        purpose="equipment",
        amount=30_000_000,
        term_months=60,
        form={"finance": {"monthly_revenue": 8_000_000}, "collateral": {"kind": "equipment", "value": 40_000_000},
              "consent_bki": True},
    )
    run_pipeline(mocks)
    analyst = auth(client, "analyst@demo.local")
    card = client.get(f"/api/applications/{app_id}/assessment", headers=analyst).json()
    assert card["revenue_limit"] == 28_800_000  # 8 млн × 6 × 0,6 для грейда C
    over = decide(client, app_id, analyst, outcome="approve")
    assert over.status_code == 422
    assert "лимита по выручке" in over.json()["detail"]
    bigger = decide(client, app_id, analyst, outcome="counter_offer", amount=31_000_000, term_months=60)
    assert bigger.status_code == 422
    within = decide(client, app_id, analyst, outcome="counter_offer", amount=28_800_000, term_months=60)
    assert within.status_code == 200, within.text


def test_approval_without_pipeline_recommendation_is_a_deviation(client, mocks):
    from app.db import SessionLocal
    from app.models import Application, ApplicationEvent

    app_id, _ = vector_in_review(client, mocks)
    with SessionLocal() as db:
        app = db.get(Application, app_id)
        app.decision = dict(app.decision) | {"recommendation": None}
        db.commit()
    analyst = auth(client, "analyst@demo.local")
    assert decide(client, app_id, analyst, outcome="approve").status_code == 200
    with SessionLocal() as db:
        event = db.query(ApplicationEvent).filter_by(application_id=app_id, event="analyst_decision").one()
        assert event.payload["deviation"] is True
        assert event.payload["deviations"] == ["no_recommendation"]


def test_blank_justification_is_rejected(client, mocks):
    app_id, _ = vector_in_review(client, mocks)
    analyst = auth(client, "analyst@demo.local")
    response = client.post(f"/api/applications/{app_id}/decision",
                           json={"outcome": "approve", "comment": " " * 20}, headers=analyst)
    assert response.status_code == 422


def test_retry_during_a_second_outage_returns_to_the_analyst(client, mocks):
    mocks.post("/admin/faults", json={"source": "bki", "mode": "error"})
    app_id, client_headers = submit(client, "bakery@demo.local")
    run_pipeline(mocks)
    analyst = auth(client, "analyst@demo.local")
    assert decide(client, app_id, analyst, outcome="retry_checks").status_code == 200
    run_pipeline(mocks)  # БКИ всё ещё лежит
    assert get(client, app_id, client_headers)["status"]["code"] == "manual_review"
    card = client.get(f"/api/applications/{app_id}/assessment", headers=analyst).json()
    assert card["review_reason"] == "source_failure"
    assert decide(client, app_id, analyst, outcome="retry_checks").status_code == 200


def test_card_has_no_review_reason_outside_manual_review(client, mocks):
    app_id, _ = submit(client, "bakery@demo.local")
    run_pipeline(mocks)
    analyst = auth(client, "analyst@demo.local")
    card = client.get(f"/api/applications/{app_id}/assessment", headers=analyst).json()
    assert card["review_reason"] is None and card["can_decide"] is False
    assert card["failed_sources"] == []


def test_amount_above_analyst_authority_goes_to_credit_committee(client, mocks):
    app_id, _ = submit(
        client,
        "vector@demo.local",
        product_code="invest",
        purpose="equipment",
        amount=35_000_000,
        term_months=60,
        form={"finance": {"monthly_revenue": 8_000_000}, "collateral": {"kind": "equipment", "value": 50_000_000},
              "consent_bki": True},
    )
    run_pipeline(mocks)
    analyst = auth(client, "analyst@demo.local")
    response = decide(client, app_id, analyst, outcome="approve")
    assert response.status_code == 403
    assert "комитета" in response.json()["detail"]
