"""Сквозные сценарии конвейера: отправка → проверка → ЕГРЮЛ/ФНС/БКИ → оценка → решение."""

from app.db import SessionLocal
from app.pipeline.runner import process_next
from app.services.integrations import ExternalSources
from tests.conftest import auth, run_pipeline


def submit(client, email: str, *, form: dict | None = None, **params) -> tuple[int, dict]:
    headers = auth(client, email)
    body = {
        "product_code": "express",
        "purpose": "working_capital",
        "amount": 3_000_000,
        "term_months": 12,
        "form": form if form is not None else {"finance": {"monthly_revenue": 4_000_000}, "consent_bki": True},
    } | params
    created = client.post("/api/applications", json=body, headers=headers)
    assert created.status_code == 201, created.text
    app_id = created.json()["id"]
    submitted = client.post(f"/api/applications/{app_id}/submit", headers=headers)
    assert submitted.status_code == 200, submitted.text
    return app_id, headers


def get(client, app_id: int, headers: dict) -> dict:
    return client.get(f"/api/applications/{app_id}", headers=headers).json()


def events(client, app_id: int, headers: dict) -> list[str]:
    return [e["event"] for e in client.get(f"/api/applications/{app_id}/events", headers=headers).json()]


def test_reliable_company_is_approved_automatically(client, mocks):
    app_id, headers = submit(client, "bakery@demo.local")
    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "approved"
    assert app["offer"]["kind"] == "approved"
    assert app["offer"]["amount"] == 3_000_000
    assert app["offer"]["rate"] == 22.9
    assert app["decision"]["reasons"]
    history = events(client, app_id, headers)
    assert history.count("check_completed") == 3
    assert "scored" in history
    checks = client.get(f"/api/applications/{app_id}/checks", headers=headers).json()
    assert [c["status"] for c in checks] == ["ok", "ok", "ok"]
    assert all(c["data"] is None for c in checks)  # сырые ответы источников клиенту не отдаются


def test_amount_above_revenue_limit_gets_counter_offer(client, mocks):
    app_id, headers = submit(client, "sklad@demo.local", amount=10_000_000)
    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "counter_offer"
    assert app["offer"]["kind"] == "counter"
    assert app["offer"]["amount"] == 4_500_000
    # На 12 мес. платёж 423 тыс. при прибыли 417 тыс.; срок увеличен до самого короткого, при котором прибыль
    # покрывает платёж в 1,2 раза (16 мес., ≈329 тыс.).
    assert app["offer"]["term_months"] == 16
    assert any("выручкой" in r for r in app["decision"]["reasons"])


def test_investment_credit_goes_to_specialist(client, mocks):
    app_id, headers = submit(
        client,
        "vector@demo.local",
        product_code="invest",
        purpose="equipment",
        amount=25_000_000,
        term_months=48,
        form={
            "finance": {"monthly_revenue": 8_000_000},
            "collateral": {"kind": "equipment", "value": 30_000_000},
            "consent_bki": True,
        },
    )
    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "manual_review"
    assert app["offer"] is None
    analyst = auth(client, "analyst@demo.local")
    queue = client.get("/api/applications", params={"status": "manual_review"}, headers=analyst).json()
    assert app_id in {a["id"] for a in queue}


def test_overdue_and_tax_debt_lead_to_explained_rejection(client, mocks):
    app_id, headers = submit(client, "start@demo.local", amount=2_000_000)
    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "rejected"
    assert len(app["decision"]["reasons"]) == 3
    assert app["decision"]["tips"]


def test_liquidating_company_hits_stop_factor(client, mocks):
    app_id, headers = submit(client, "zakat@demo.local", amount=1_000_000)
    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "rejected"
    assert "ликвидации" in app["decision"]["reasons"][0]


def test_missing_tax_revenue_requests_statement_and_resumes(client, mocks):
    app_id, headers = submit(
        client,
        "smirnova@demo.local",
        amount=500_000,
        form={"finance": {"monthly_revenue": 600_000}, "consent_bki": True},
    )
    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "needs_info"
    assert app["open_tasks"] == 1
    assert "answer_tasks" in app["allowed_actions"]
    task = client.get(f"/api/applications/{app_id}/tasks", headers=headers).json()[0]
    assert task["kind"] == "document"

    bad = client.post(
        f"/api/applications/{app_id}/documents",
        files={"file": ("virus.exe", b"MZ", "application/octet-stream")},
        data={"kind": "bank_statement", "task_id": str(task["id"])},
        headers=headers,
    )
    assert bad.status_code == 422

    uploaded = client.post(
        f"/api/applications/{app_id}/documents",
        files={"file": ("vypiska.pdf", b"%PDF-1.4 statement", "application/pdf")},
        data={"kind": "bank_statement", "task_id": str(task["id"])},
        headers=headers,
    )
    assert uploaded.status_code == 201, uploaded.text
    assert get(client, app_id, headers)["status"]["code"] == "validation"

    run_pipeline(mocks)
    app = get(client, app_id, headers)
    # Выручку подтверждает только выписка — заявку сверяет специалист, а не автомат.
    assert app["status"]["code"] == "manual_review"
    assert app["open_tasks"] == 0
    assert "document_uploaded" in events(client, app_id, headers)
    analyst = auth(client, "analyst@demo.local")
    card = client.get(f"/api/applications/{app_id}/assessment", headers=analyst).json()
    assert card["review_reason"] == "unverified_revenue"
    assert card["revenue"]["source"] == "statement"
    approved = client.post(
        f"/api/applications/{app_id}/decision",
        json={"outcome": "approve", "comment": "Обороты по выписке совпадают с заявленной выручкой"},
        headers=analyst,
    )
    assert approved.status_code == 200, approved.text
    assert get(client, app_id, headers)["status"]["code"] == "approved"


def test_incomplete_form_asks_for_revenue_and_continues(client, mocks):
    app_id, headers = submit(client, "bakery@demo.local", form={"consent_bki": True})
    run_pipeline(mocks)
    assert get(client, app_id, headers)["status"]["code"] == "needs_info"
    task = client.get(f"/api/applications/{app_id}/tasks", headers=headers).json()[0]
    assert task["kind"] == "field"
    answered = client.post(
        f"/api/applications/{app_id}/tasks/{task['id']}/answer", json={"answer": "4 500 000"}, headers=headers
    )
    assert answered.status_code == 200, answered.text
    app = get(client, app_id, headers)
    assert app["form"]["finance"]["monthly_revenue"] == 4_500_000
    run_pipeline(mocks)
    assert get(client, app_id, headers)["status"]["code"] == "approved"


def test_short_outage_is_retried_transparently(client, mocks):
    mocks.post("/admin/faults", json={"source": "bki", "mode": "error", "count": 1})
    app_id, headers = submit(client, "bakery@demo.local")
    run_pipeline(mocks)
    assert get(client, app_id, headers)["status"]["code"] == "approved"
    assert "check_retry" in events(client, app_id, headers)


def test_long_outage_hands_application_to_specialist(client, mocks):
    mocks.post("/admin/faults", json={"source": "bki", "mode": "error"})
    app_id, headers = submit(client, "bakery@demo.local")
    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "manual_review"
    assert "Бюро кредитных историй" in app["decision"]["reasons"][0]
    checks = {c["source"]: c["status"] for c in client.get(f"/api/applications/{app_id}/checks", headers=headers).json()}
    assert checks == {"egrul": "ok", "fns": "ok", "bki": "failed"}


def test_cancelled_application_is_left_alone_by_pipeline(client, mocks):
    app_id, headers = submit(client, "bakery@demo.local")
    process_next(SessionLocal, ExternalSources(mocks, timeout=2, retries=1, backoff=0))  # submitted → validation
    assert client.post(f"/api/applications/{app_id}/cancel", headers=headers).status_code == 200
    run_pipeline(mocks)
    assert get(client, app_id, headers)["status"]["code"] == "cancelled"


def test_stream_reports_status_and_closes_on_final_status(client, mocks):
    app_id, headers = submit(client, "zakat@demo.local", amount=1_000_000)
    run_pipeline(mocks)
    with client.stream("GET", f"/api/applications/{app_id}/stream", headers=headers) as response:
        assert response.headers["content-type"].startswith("text/event-stream")
        body = response.read().decode()
    assert body.startswith("event: update")
    assert '"status": "rejected"' in body
    assert '"terminal": true' in body
    stranger = auth(client, "bakery@demo.local")
    assert client.get(f"/api/applications/{app_id}/stream", headers=stranger).status_code == 404


def test_submit_requires_consent(client):
    headers = auth(client, "bakery@demo.local")
    draft = client.post(
        "/api/applications",
        json={"product_code": "express", "purpose": "working_capital", "amount": 1_000_000, "term_months": 12},
        headers=headers,
    ).json()
    response = client.post(f"/api/applications/{draft['id']}/submit", headers=headers)
    assert response.status_code == 422
    assert {e["field"] for e in response.json()["errors"]} == {"form.consent_bki"}


def test_financials_prefill_from_tax_data(client):
    bakery = client.get("/api/companies/me/financials", headers=auth(client, "bakery@demo.local")).json()
    assert bakery == {
        "available": True,
        "reporting_year": 2025,
        "revenue_monthly": 4_500_000,
        "expenses_monthly": 3_958_333,
        "employees": 38,
        "tax_regime": "ОСН",
    }
    smirnova = client.get("/api/companies/me/financials", headers=auth(client, "smirnova@demo.local")).json()
    assert smirnova["available"] is False


def test_heavy_existing_debt_gets_an_overdraft_instead(client, mocks):
    # «Городская химчистка»: платежи по кредитам 485 тыс. при выручке 1 млн в месяц — «Экспресс-оборот» не проходит
    # даже на минимальную сумму, а у овердрафта минимум ниже: 150 тыс. проходят по нагрузке.
    app_id, headers = submit(client, "clean@demo.local", amount=300_000)
    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "counter_offer", app["decision"]
    assert app["offer"]["product_code"] == "overdraft"
    assert app["offer"]["amount"] == 150_000
    assert "Овердрафт" in app["decision"]["reasons"][0]
