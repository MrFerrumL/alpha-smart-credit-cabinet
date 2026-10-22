from tests.conftest import auth


def _draft(client, headers, **overrides) -> dict:
    body = {
        "product_code": "express",
        "purpose": "working_capital",
        "amount": 3_000_000,
        "term_months": 12,
        "form": {"finance": {"monthly_revenue": 4_500_000}},
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


def test_meta_and_product_matching(client):
    meta = client.get("/api/meta").json()
    assert len(meta["stages"]) == 7
    assert {s["code"] for s in meta["statuses"]} >= {"draft", "approved", "counter_offer"}
    matches = client.post("/api/products/match", json={"purpose": "equipment", "amount": 5_000_000, "term_months": 36})
    assert matches.json()[0]["product"]["code"] == "invest"
    calc = client.get("/api/products/express/calculate", params={"amount": 1_000_000, "term_months": 12}).json()
    assert len(calc["schedule"]) == 12
    assert calc["total"] == calc["amount"] + calc["overpayment"]


def test_company_lookup_uses_registry(client):
    headers = auth(client, "new@demo.local")
    card = client.get("/api/companies/lookup", params={"inn": "0077060066"}, headers=headers).json()
    assert card["short_name"] == "ООО «Закат»"
    assert card["status"] == "liquidating"
    wrong = client.get("/api/companies/lookup", params={"inn": "0077060067"}, headers=headers)
    assert wrong.status_code == 422
    generated = client.get("/api/companies/lookup", params={"inn": "7707083893"}, headers=headers)
    assert generated.status_code == 200


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
    assert client.get("/api/auth/me", headers=headers).json()["company"]["inn"] == "0077070071"
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
