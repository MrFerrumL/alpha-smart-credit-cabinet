"""Лента новостей меняется под компанию клиента и под то, что происходит с её заявками."""

from tests.conftest import auth, run_pipeline
from tests.test_pipeline import submit


def titles(client, headers) -> list[str]:
    response = client.get("/api/feed", headers=headers)
    assert response.status_code == 200, response.text
    items = response.json()
    assert items and all(i["is_synthetic"] and i["reasons"] for i in items)
    return [i["title"] for i in items]


def test_feed_differs_between_companies(client):
    bakery = titles(client, auth(client, "bakery@demo.local"))  # производство хлеба, раздел C
    vector = titles(client, auth(client, "vector@demo.local"))  # строительство, раздел F
    smirnova = titles(client, auth(client, "smirnova@demo.local"))  # ИП, услуги
    assert bakery != vector != smirnova
    assert any("производителей продуктов питания" in t for t in bakery)
    assert any("Строительная отрасль" in t for t in vector)
    assert any("УСН" in t for t in smirnova)
    assert not any("УСН" in t for t in bakery)  # новость для ИП не показывается ООО
    assert not any("Татарстан" in t for t in bakery)  # региональная новость — только для своего региона


def test_feed_reacts_to_application_status(client, mocks):
    headers = auth(client, "smirnova@demo.local")
    before = titles(client, headers)
    submit(client, "smirnova@demo.local", amount=500_000,
           form={"finance": {"monthly_revenue": 600_000}, "consent_bki": True})
    run_pipeline(mocks)  # банк запросил выписку
    after = client.get("/api/feed", headers=headers).json()
    assert after[0]["title"].startswith("Что делать, если банк запросил дополнительные документы")
    assert any("банк ждёт от вас информацию" in r for r in after[0]["reasons"])
    assert [i["title"] for i in after] != before


def test_feed_is_for_clients_only(client):
    assert client.get("/api/feed", headers=auth(client, "analyst@demo.local")).status_code == 403


def test_rejection_and_manual_review_bring_the_explainer_to_the_top(client, mocks):
    for email, params in (("start@demo.local", {"amount": 2_000_000}),
                          ("vector@demo.local", {"product_code": "invest", "purpose": "equipment", "amount": 25_000_000,
                                                 "term_months": 48,
                                                 "form": {"finance": {"monthly_revenue": 8_000_000},
                                                          "collateral": {"kind": "equipment", "value": 30_000_000},
                                                          "consent_bki": True}})):
        submit(client, email, **params)
        run_pipeline(mocks)
        top = client.get("/api/feed", headers=auth(client, email)).json()[0]
        assert top["title"].startswith("Как банк оценивает заявку"), (email, top)


def test_no_foreign_industry_news_even_with_matching_products(client, mocks):
    headers = auth(client, "smirnova@demo.local")
    submit(client, "smirnova@demo.local", amount=500_000,
           form={"finance": {"monthly_revenue": 600_000}, "consent_bki": True})
    items = client.get("/api/feed", headers=headers).json()
    assert len(items) >= 4
    assert not any(word in i["title"] for i in items for word in ("производителей", "Строительная", "Маркетплейсы"))
    assert all(len(i["summary"]) > 40 and "Демонстрационный" not in i["summary"] for i in items)
