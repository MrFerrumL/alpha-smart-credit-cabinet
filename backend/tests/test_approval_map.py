"""Граница одобрения по сроку: каждая сумма на карте — правда по тем же правилам, по которым решает конвейер.

Оракул — не сама карта, а то, что конвейер посчитал бы для новой заявки на эти условия: признаки строятся заново
из тех же ответов ЕГРЮЛ, ФНС и БКИ (build_features), затем скоринг и правила решения.
"""

from sqlalchemy import func, select

from app.db import SessionLocal
from app.domain.products import PRODUCTS, Purpose
from app.domain.statuses import Status
from app.models import Application, ApplicationEvent, Document
from app.pipeline.steps import _own_loans, checks_by_source
from app.scoring import rules
from app.scoring.decision import STEP, decide
from app.scoring.features import Features, build_features
from app.services import approval_map as approval_map_svc
from app.services.approval_map import features_for
from app.services.decisions import latest_scoring
from tests.conftest import auth, run_pipeline
from tests.test_pipeline import get, submit

MAP = "/api/applications/{}/approval-map"


def fresh_features(app_id: int, amount: int, term: int) -> Features:
    """Признаки, которые конвейер посчитал бы для заявки на эти сумму и срок: те же ответы источников, анкета,
    выписки и собственные кредиты банка — как в pipeline.steps.score."""
    with SessionLocal() as db:
        app = db.get(Application, app_id)
        checks = checks_by_source(db, app)
        has_statement = db.scalar(
            select(Document.id).where(Document.application_id == app.id, Document.kind == "bank_statement").limit(1)
        ) is not None
        finance = (app.form or {}).get("finance") or {}
        own_payments, own_debt = _own_loans(db, app)
        return build_features(
            egrul=checks["egrul"].data,
            fns=checks["fns"].data,
            bki=checks["bki"].data,
            declared_revenue=finance.get("monthly_revenue"),
            has_statement=has_statement,
            product=PRODUCTS[app.product_code],
            amount=amount,
            term_months=term,
            own_payments=own_payments,
            own_debt=own_debt,
            declared_debt_payments=finance.get("debt_payments"),
        )


def stored_features(app_id: int) -> Features:
    with SessionLocal() as db:
        return Features(**latest_scoring(db, db.get(Application, app_id)).features)


def pipeline_outcome(app_id: int, amount: int, term: int) -> Status:
    with SessionLocal() as db:
        app = db.get(Application, app_id)
        product, purpose = PRODUCTS[app.product_code], Purpose(app.purpose)
    f = fresh_features(app_id, amount, term)
    return decide(f, rules.score(f), product, amount, term, purpose).outcome


def event_count(app_id: int) -> int:
    with SessionLocal() as db:
        return db.scalar(select(func.count(ApplicationEvent.id)).where(ApplicationEvent.application_id == app_id))


def assert_boundaries(app_id: int, body: dict) -> None:
    """Каждая сумма на карте одобряется, а следующая за ней по шагу подбора — уже нет."""
    product = PRODUCTS[body["product_code"]]
    cap = min(body["requested_amount"], product.max_amount)
    stored = stored_features(app_id)
    for row in body["terms"]:
        amount, term = row["amount"], row["term_months"]
        if amount is None:
            # Не проходит даже минимальная сумма продукта.
            assert pipeline_outcome(app_id, product.min_amount, term) != Status.APPROVED, row
            continue
        # Пересчёт признаков на снимке совпадает с тем, что посчитал бы конвейер по новой заявке.
        assert features_for(stored, product, amount, term) == fresh_features(app_id, amount, term)
        assert pipeline_outcome(app_id, amount, term) == Status.APPROVED, row
        if amount < cap:
            assert pipeline_outcome(app_id, min(amount + STEP, cap), term) != Status.APPROVED, row


def test_counter_offer_shows_how_much_each_term_gets(client, mocks):
    app_id, headers = submit(client, "sklad@demo.local", amount=10_000_000)
    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "counter_offer"
    before = event_count(app_id)

    response = client.get(MAP.format(app_id), headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["product_code"] == "express"
    assert (body["requested_amount"], body["requested_term"]) == (10_000_000, 12)
    assert body["offered_term"] == app["offer"]["term_months"] == 16
    assert body["explanation"] is None and body["alternative"] is None

    rows = {row["term_months"]: row for row in body["terms"]}
    # Стандартные сроки продукта (3–24 мес.), срок заявки и срок предложения банка — по возрастанию.
    assert list(rows) == [6, 12, 16, 18, 24]
    assert [t for t, row in rows.items() if row["requested"]] == [12]
    assert [t for t, row in rows.items() if row["offered"]] == [16]
    # На 12 мес. прибыль 416 667 ₽ должна покрывать платёж в 1,2 раза: платёж не больше 347 222 ₽.
    assert rows[12]["amount"] == 3_650_000
    assert rows[12]["monthly_payment"] == 343_202 and rows[12]["rate"] == 22.9
    # На сроке предложения граница совпадает с предложением, дальше сумму держит лимит по выручке.
    assert rows[16]["amount"] == app["offer"]["amount"] == 4_500_000
    assert rows[16]["monthly_payment"] == app["offer"]["monthly_payment"]
    assert rows[24]["amount"] == 4_500_000
    assert rows[6]["amount"] < rows[12]["amount"]
    assert_boundaries(app_id, body)

    # Карта только читает: заявка, решение и история не меняются.
    assert get(client, app_id, headers)["status"] == app["status"]
    assert event_count(app_id) == before


def test_amount_from_the_map_is_approved_by_the_pipeline(client, mocks):
    app_id, headers = submit(client, "sklad@demo.local", amount=10_000_000)
    run_pipeline(mocks)
    row = next(r for r in client.get(MAP.format(app_id), headers=headers).json()["terms"] if r["requested"])

    # Новая заявка ровно на сумму с карты одобряется как есть, на шаг больше — уже нет.
    exact, _ = submit(client, "sklad@demo.local", amount=row["amount"], term_months=row["term_months"])
    above, _ = submit(client, "sklad@demo.local", amount=row["amount"] + STEP, term_months=row["term_months"])
    run_pipeline(mocks)
    approved = get(client, exact, headers)
    assert approved["status"]["code"] == "approved", approved["decision"]
    assert (approved["offer"]["amount"], approved["offer"]["term_months"]) == (row["amount"], row["term_months"])
    assert approved["offer"]["monthly_payment"] == row["monthly_payment"]
    assert get(client, above, headers)["status"]["code"] == "counter_offer"
    # Одобренной заявке карта не нужна: банк и так выдаёт то, что просили.
    assert client.get(MAP.format(exact), headers=headers).json()["terms"] == []
    # Лишние заявки закрываем: у компании не остаётся активных предложений из этого теста.
    for extra in (exact, above):
        assert client.post(f"/api/applications/{extra}/cancel", headers=headers).status_code == 200


def test_other_product_offer_explains_why_no_term_passes(client, mocks):
    app_id, headers = submit(client, "clean@demo.local", amount=300_000)
    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "counter_offer" and app["offer"]["product_code"] == "overdraft"

    body = client.get(MAP.format(app_id), headers=headers).json()
    assert body["product_code"] == "express"
    assert body["offered_term"] is None  # предложение — по другому продукту
    assert [r["term_months"] for r in body["terms"]] == [6, 12, 18, 24]
    assert all(r["amount"] is None and r["monthly_payment"] is None for r in body["terms"])
    assert_boundaries(app_id, body)
    # Одна строка: самый мягкий вариант — минимальная сумма на самый долгий срок — и что именно не проходит.
    assert body["explanation"].startswith("Даже 300 000 ₽ на 24 месяца банк не одобрит: ")
    assert "выручки" in body["explanation"] and "50%" in body["explanation"]
    alternative = body["alternative"]
    assert alternative["product_code"] == "overdraft" and alternative["product_name"] == "Овердрафт"
    assert (alternative["amount"], alternative["term_months"]) == (app["offer"]["amount"], app["offer"]["term_months"])


def test_stop_factor_rejection_has_no_map(client, mocks):
    app_id, headers = submit(client, "zakat@demo.local", amount=1_000_000)
    run_pipeline(mocks)
    assert get(client, app_id, headers)["status"]["code"] == "rejected"
    body = client.get(MAP.format(app_id), headers=headers).json()
    assert body["terms"] == [] and body["explanation"] is None and body["alternative"] is None


def test_specialist_decision_has_no_map(client, mocks):
    # Решение специалиста учитывает то, чего нет в правилах: карта по правилам с ним не спорит.
    app_id, headers = submit(client, "sklad@demo.local", amount=10_000_000)
    run_pipeline(mocks)
    assert client.get(MAP.format(app_id), headers=headers).json()["terms"]
    with SessionLocal() as db:
        app = db.get(Application, app_id)
        app.decision = {**app.decision, "decided_by": "analyst"}
        db.commit()
    assert client.get(MAP.format(app_id), headers=headers).json()["terms"] == []


def test_map_without_scoring_is_empty(client):
    headers = auth(client, "sklad@demo.local")
    body = {"product_code": "express", "purpose": "working_capital", "amount": 2_000_000, "term_months": 12}
    draft = client.post("/api/applications", json=body, headers=headers).json()
    response = client.get(MAP.format(draft["id"]), headers=headers)
    assert response.status_code == 200
    assert response.json()["terms"] == []
    # Черновик аналитик не видит — и его карту тоже.
    assert client.get(MAP.format(draft["id"]), headers=auth(client, "analyst@demo.local")).status_code == 404
    assert client.post(f"/api/applications/{draft['id']}/cancel", headers=headers).status_code == 200


def test_map_access(client, mocks):
    app_id, headers = submit(client, "sklad@demo.local", amount=10_000_000)
    run_pipeline(mocks)
    url = MAP.format(app_id)
    assert client.get(url).status_code == 401
    assert client.get(url, headers=auth(client, "bakery@demo.local")).status_code == 404  # чужая компания
    assert client.get(url, headers=auth(client, "analyst@demo.local")).status_code == 200
    assert client.get(MAP.format(10**9), headers=headers).status_code == 404


def test_map_is_small_and_fast(client, mocks, monkeypatch):
    app_id, headers = submit(client, "sklad@demo.local", amount=10_000_000)
    run_pipeline(mocks)
    calls = 0
    real = approval_map_svc.decide

    def counting(*args, **kwargs):
        nonlocal calls
        calls += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(approval_map_svc, "decide", counting)
    response = client.get(MAP.format(app_id), headers=headers)
    assert response.status_code == 200
    body = response.json()
    # Сроков не больше десяти (семь стандартных, срок заявки, срок предложения и самый долгий срок продукта), на срок —
    # двоичный поиск по сумме.
    assert len(body["terms"]) <= 10
    assert 0 < calls <= len(body["terms"]) * 20
    assert len(response.content) < 2_000
    assert set(body["terms"][0]) == {"term_months", "amount", "rate", "monthly_payment", "requested", "offered"}

