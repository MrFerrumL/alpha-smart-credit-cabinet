import re

from tests.conftest import auth


def _draft(client, headers, **overrides) -> dict:
    body = {
        "product_code": "express",
        "purpose": "working_capital",
        "amount": 3_000_000,
        "term_months": 12,
        "form": {"finance": {"monthly_revenue": 4_500_000}, "consent_bki": True},
    } | overrides
    response = client.post("/api/applications", json=body, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def test_unauthorized_request_returns_problem_details(client):
    response = client.get("/api/applications")
    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


def test_demo_accounts_cover_all_scenarios(client):
    accounts = client.get("/api/auth/demo-accounts").json()
    emails = {a["email"] for a in accounts}
    assert {"bakery@demo.local", "analyst@demo.local", "new@demo.local"} <= emails
    assert all(a["scenario"] for a in accounts)


def test_password_login(client):
    ok = client.post("/api/auth/login", json={"email": "bakery@demo.local", "password": "demo1234"})
    assert ok.status_code == 200
    assert ok.json()["user"]["company"]["inn"] == "0077010019"
    bad = client.post("/api/auth/login", json={"email": "bakery@demo.local", "password": "wrong"})
    assert bad.status_code == 401


def test_unknown_email_costs_the_same_password_check(client, monkeypatch):
    from app.api import auth as auth_api
    from app.security import DUMMY_PASSWORD_HASH, hash_password, verify_password

    checked = []

    def spy(password: str, stored: str) -> bool:
        checked.append(stored)
        return verify_password(password, stored)

    monkeypatch.setattr(auth_api, "verify_password", spy)
    unknown = client.post("/api/auth/login", json={"email": "nobody@demo.local", "password": "demo1234"})
    wrong = client.post("/api/auth/login", json={"email": "bakery@demo.local", "password": "wrong"})
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json()["detail"] == wrong.json()["detail"]
    assert checked[0] == DUMMY_PASSWORD_HASH and len(checked) == 2
    # Та же схема и то же число итераций, что у настоящих хешей, — и с ним не совпадает никакой пароль.
    assert DUMMY_PASSWORD_HASH.split("$")[:2] == hash_password("x").split("$")[:2]
    assert not verify_password("", DUMMY_PASSWORD_HASH)


def test_meta_and_product_matching(client):
    meta = client.get("/api/meta").json()
    assert len(meta["stages"]) == 7
    assert {s["code"] for s in meta["statuses"]} >= {"draft", "approved", "counter_offer"}
    matches = client.post("/api/products/match", json={"purpose": "equipment", "amount": 5_000_000, "term_months": 36})
    assert matches.json()[0]["product"]["code"] == "invest"
    calc = client.get("/api/products/express/calculate", params={"amount": 1_000_000, "term_months": 12}).json()
    assert len(calc["schedule"]) == 12
    assert calc["total"] == calc["amount"] + calc["overpayment"]


def test_company_lookup_uses_registry(client, mocks):
    headers = auth(client, "new@demo.local")
    card = client.get("/api/companies/lookup", params={"inn": "0077060066"}, headers=headers).json()
    assert card["short_name"] == "ООО «Закат»"
    assert card["status"] == "liquidating"
    wrong = client.get("/api/companies/lookup", params={"inn": "0077060067"}, headers=headers)
    assert wrong.status_code == 422
    generated = client.get("/api/companies/lookup", params={"inn": "0078012403"}, headers=headers)
    assert generated.status_code == 200
    # ИНН реальной организации эмулятор не знает: вместо вымышленной выписки — «не найдена».
    real = client.get("/api/companies/lookup", params={"inn": "7707083893"}, headers=headers)
    assert real.status_code == 404
    assert real.json()["code"] == "not_found" and "не найдена" in real.json()["detail"]
    assert all(mocks.get(f"/{source}/7707083893").status_code == 404 for source in ("egrul", "fns", "bki"))


def test_company_lookup_survives_source_outage(client, mocks):
    headers = auth(client, "new@demo.local")
    mocks.post("/admin/faults", json={"source": "egrul", "mode": "error", "count": 1})
    # Первая попытка падает, повторная проходит — клиент не замечает сбоя.
    assert client.get("/api/companies/lookup", params={"inn": "0077010019"}, headers=headers).status_code == 200
    mocks.post("/admin/faults", json={"source": "egrul", "mode": "error"})
    down = client.get("/api/companies/lookup", params={"inn": "0077010019"}, headers=headers)
    assert down.status_code == 503
    assert down.json()["code"] == "integration_unavailable"


def test_new_client_links_company_by_inn(client):
    headers = auth(client, "new@demo.local")
    linked = client.post("/api/companies/link", json={"inn": "0077070071"}, headers=headers)
    assert linked.status_code == 200, linked.text
    assert linked.json()["short_name"] == "ООО «Новые горизонты»"
    me = client.get("/api/auth/me", headers=headers).json()
    assert me["company"]["inn"] == "0077070071"
    assert me["can_sign"] is True  # руководитель по ЕГРЮЛ
    again = client.post("/api/companies/link", json={"inn": "0077070071"}, headers=headers)
    assert again.status_code == 409


def test_application_lifecycle_and_access(client):
    owner = auth(client, "bakery@demo.local")
    draft = _draft(client, owner)
    assert draft["status"]["code"] == "draft"
    assert draft["number"].endswith(f"{draft['id']:06d}")
    assert set(draft["allowed_actions"]) == {"edit", "submit", "cancel"}

    updated = client.patch(f"/api/applications/{draft['id']}", json={"amount": 2_500_000}, headers=owner)
    assert updated.json()["amount"] == 2_500_000

    analyst = auth(client, "analyst@demo.local")
    assert client.get(f"/api/applications/{draft['id']}", headers=analyst).status_code == 404

    stranger = auth(client, "sklad@demo.local")
    assert client.get(f"/api/applications/{draft['id']}", headers=stranger).status_code == 404

    key = {"Idempotency-Key": "submit-test-1"}
    first = client.post(f"/api/applications/{draft['id']}/submit", headers=owner | key)
    assert first.status_code == 200
    assert first.json()["status"]["code"] == "submitted"
    repeat = client.post(f"/api/applications/{draft['id']}/submit", headers=owner | key)
    assert repeat.status_code == 200
    other_key = client.post(f"/api/applications/{draft['id']}/submit", headers=owner | {"Idempotency-Key": "x"})
    assert other_key.status_code == 409

    assert client.patch(f"/api/applications/{draft['id']}", json={"amount": 1}, headers=owner).status_code == 409

    queue = client.get("/api/applications", headers=analyst).json()
    assert draft["id"] in {a["id"] for a in queue}

    cancelled = client.post(f"/api/applications/{draft['id']}/cancel", json={"comment": "Передумали"}, headers=owner)
    assert cancelled.json()["status"]["code"] == "cancelled"
    # Таймлайн отозванной заявки стоит на этапе, где её отозвали («Проверка данных»), а не на «Заявке».
    assert cancelled.json()["status"]["stage"] == 1
    assert client.post(f"/api/applications/{draft['id']}/cancel", headers=owner).status_code == 409

    events = client.get(f"/api/applications/{draft['id']}/events", headers=owner).json()
    assert [e["event"] for e in events] == ["created", "updated", "submitted", "cancelled"]
    assert events[-1]["comment"] == "Передумали"
    assert events[-1]["actor_name"] == "Ольга Северова"


def test_submit_rejects_parameters_outside_product(client):
    owner = auth(client, "sklad@demo.local")
    draft = _draft(client, owner, amount=15_000_000, purpose="equipment")
    response = client.post(f"/api/applications/{draft['id']}/submit", headers=owner)
    assert response.status_code == 422
    fields = {e["field"] for e in response.json()["errors"]}
    assert fields == {"amount", "purpose"}


def test_analyst_cannot_create_applications(client):
    analyst = auth(client, "analyst@demo.local")
    response = client.post(
        "/api/applications",
        json={"product_code": "express", "purpose": "working_capital", "amount": 1_000_000, "term_months": 12},
        headers=analyst,
    )
    assert response.status_code == 403


def test_schema_errors_are_explained_in_russian(client):
    def errors(response, field):
        assert response.status_code == 422, response.text
        body = response.json()
        assert body["code"] == "validation_error"
        messages = {e["field"]: e["message"] for e in body["errors"]}
        assert not any(re.search("[A-Za-z]", m) for m in messages.values()), messages
        return messages[field]

    login = client.post("/api/auth/login", json={"email": "ab", "password": "x"})
    assert errors(login, "email") == "Почта — не короче 3 символов"

    owner = auth(client, "bakery@demo.local")
    draft = _draft(client, owner)
    url = f"/api/applications/{draft['id']}"
    employees = client.patch(url, json={"form": {"finance": {"employees": 1_000_000}}}, headers=owner)
    assert errors(employees, "form.finance.employees") == "Сотрудников — не больше 100 000"
    # Так браузер отправляет 22-значную выручку: число больше MAX_SAFE_INTEGER уходит в экспоненциальной записи.
    huge = client.patch(
        url, content='{"form":{"finance":{"monthly_revenue":1e+21}}}', headers=owner | {"Content-Type": "application/json"}
    )
    assert errors(huge, "form.finance.monthly_revenue") == "Выручка в месяц — слишком большое число"
    name = client.patch(url, json={"form": {"contact_name": "А" * 256}}, headers=owner)
    assert errors(name, "form.contact_name") == "Контактное лицо — не длиннее 255 символов"

    analyst = auth(client, "analyst@demo.local")
    decision = client.post(
        f"{url}/decision",
        json={"outcome": "reject", "comment": "Обоснование решения", "reasons": ["П" * 301], "rate": 100},
        headers=analyst,
    )
    assert errors(decision, "reasons.0") == "Причина отказа — не длиннее 300 символов"
    assert errors(decision, "rate") == "Ставка — меньше 100"


def test_huge_money_is_a_readable_validation_error_not_a_server_error(client):
    owner = auth(client, "bakery@demo.local")
    body = {"product_code": "express", "purpose": "working_capital", "amount": 1_000_000, "term_months": 12}
    limit = "не больше 1 000 000 000 000"
    cases = {
        "form.finance.monthly_revenue": ({"finance": {"monthly_revenue": 10**15}}, f"Выручка в месяц — {limit}"),
        "form.finance.monthly_expenses": ({"finance": {"monthly_expenses": 10**400}}, f"Расходы в месяц — {limit}"),
        "form.finance.debt_payments": ({"finance": {"debt_payments": 10**13}}, f"Платежи по текущим кредитам — {limit}"),
        "form.collateral.value": ({"collateral": {"value": 10**18}}, f"Стоимость обеспечения — {limit}"),
    }
    for field, (form, message) in cases.items():
        response = client.post("/api/applications", json=body | {"form": form}, headers=owner)
        assert response.status_code == 422, response.text
        assert response.json()["errors"] == [{"field": field, "message": message}]
    edge = client.post("/api/applications", json=body | {"form": {"finance": {"monthly_revenue": 10**12}}}, headers=owner)
    assert edge.status_code == 201, edge.text

    analyst = auth(client, "analyst@demo.local")
    decision = client.post(
        f"/api/applications/{edge.json()['id']}/decision",
        json={"outcome": "counter_offer", "comment": "Обоснование решения", "amount": 10**15, "term_months": 12},
        headers=analyst,
    )
    assert decision.status_code == 422
    assert decision.json()["errors"] == [{"field": "amount", "message": "Сумма — не больше 1 000 000 000"}]

    # Число длиннее 4300 цифр JSON-парсер Python не разбирает вовсе: ответ всё равно понятный, а не 500.
    longest = client.post(
        "/api/applications",
        content='{"amount": 1' + "0" * 5000 + "}",
        headers=owner | {"Content-Type": "application/json"},
    )
    assert longest.status_code == 400
    assert longest.json()["title"].startswith("Не удалось разобрать запрос")
