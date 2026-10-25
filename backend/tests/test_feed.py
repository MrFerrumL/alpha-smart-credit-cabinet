"""Лента новостей меняется под компанию клиента и под то, что происходит с её главной заявкой."""

from datetime import datetime, timedelta, timezone
from itertools import combinations

from app.models import Application, Company
from app.seed import COMPANIES
from app.services.feed import main_application, personal_feed
from tests.conftest import auth, run_pipeline
from tests.test_pipeline import submit

INN = {"bakery": "0077010019", "sklad": "0077020024", "smirnova": "007703003174", "vector": "0077040045",
       "clean": "0077090092"}
T0 = datetime(2026, 10, 1, tzinfo=timezone.utc)


def titles(client, headers) -> list[str]:
    response = client.get("/api/feed", headers=headers)
    assert response.status_code == 200, response.text
    items = response.json()
    assert items and all(i["is_synthetic"] and i["reasons"] for i in items)
    return [i["title"] for i in items]


def company(name: str) -> Company:
    c = next(c for c in COMPANIES if c.inn == INN[name])
    return Company(inn=c.inn, short_name=c.short_name, legal_form=c.legal_form, okved=c.okved)


def app(id_: int, status: str, minutes: int = 0, product: str = "express", purpose: str = "working_capital"):
    """Заявка без БД: лента смотрит только на статус, продукт, цель и время обновления."""
    return Application(id=id_, status=status, product_code=product, purpose=purpose,
                       updated_at=T0 + timedelta(minutes=minutes))


def top3(name: str, apps=()) -> list[str]:
    return [i.id for i in personal_feed(company(name), list(apps))[:3]]


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
    app_id, _ = submit(client, "smirnova@demo.local", amount=500_000,
                       form={"finance": {"monthly_revenue": 600_000}, "consent_bki": True})
    run_pipeline(mocks)  # банк запросил выписку
    after = client.get("/api/feed", headers=headers).json()
    assert after[0]["title"].startswith("Что делать, если банк запросил дополнительные документы")
    assert any("банк ждёт от вас информацию" in r for r in after[0]["reasons"])
    assert after[0]["application_id"] == app_id
    assert all(i["application_id"] is None for i in after[1:])
    assert [i["title"] for i in after] != before


def test_feed_is_for_clients_only(client):
    assert client.get("/api/feed", headers=auth(client, "analyst@demo.local")).status_code == 403


def test_stage_is_taken_from_the_main_application_by_priority():
    # Как на главной кабинета (byAction): подписание → предложение → запрос банка → черновик → идущие проверки;
    # среди равных — более новая заявка. Время обновления не важно: самая свежая здесь — черновик.
    signing, offer, asks, draft, checks = (app(1, "signing"), app(2, "counter_offer"), app(3, "needs_info"),
                                           app(4, "draft"), app(5, "scoring"))
    apps = [checks, draft, asks, offer, signing]
    for a in apps:
        a.updated_at = T0 + timedelta(minutes=10 * a.id)
    assert main_application(apps) is signing
    assert main_application([checks, draft, asks, offer]) is offer
    assert main_application([checks, draft, asks]) is asks
    assert main_application([checks, draft]) is draft
    assert main_application([checks, app(6, "validation")]).id == 6
    assert main_application([app(7, "approved"), app(8, "counter_offer")]).id == 8
    # Договор подписан: заявка ждёт клиента, только пока открыты условия выдачи.
    assert main_application([signing, asks], signed={1: False}) is asks
    assert main_application([signing, asks], signed={1: True}) is signing
    # Идущих заявок нет — этап по последней закрытой.
    assert main_application([app(9, "issued", 5), app(10, "rejected", 1)]).id == 9
    assert main_application([]) is None

    feed = personal_feed(company("bakery"), apps)
    assert feed[0].title.startswith("Что проверить в договоре перед подписью кодом")
    assert feed[0].reasons[0] == "Сейчас договор ждёт вашей подписи"
    assert feed[0].application_id == 1
    assert not any("черновик" in r for i in feed for r in i.reasons)
    # Подписанный договор не поднимает новости о подписании.
    signed = personal_feed(company("bakery"), [signing], signed={1: False})
    assert all(i.application_id is None for i in signed)


def test_each_stage_has_its_own_news_on_top():
    expected = {
        "submitted": "Что банк делает, пока вы ждёте решение",
        "enrichment": "Что банк делает, пока вы ждёте решение",
        "approved": "Что проверить в договоре перед подписью кодом",
        "counter_offer": "Как сравнить предложение банка с заявкой",
        "signing": "Что проверить в договоре перед подписью кодом",
        "needs_info": "Что делать, если банк запросил дополнительные документы",
        "manual_review": "Как банк оценивает заявку",
        "rejected": "Как банк оценивает заявку",
        "draft": "Как банк оценивает заявку",
        "issued": "Деньги на счёте: как не пропустить первый платёж",
    }
    for status, title in expected.items():
        top = personal_feed(company("vector"), [app(1, status, product="invest", purpose="equipment")])[0]
        assert top.title.startswith(title), (status, top.title)
        assert top.application_id == 1
    issued = personal_feed(company("clean"), [app(1, "issued")])[0]
    assert issued.reasons[0] == "Сейчас деньги уже у вас"


def test_bakery_on_signing_gets_the_contract_news_first(client, mocks):
    app_id, headers = submit(client, "bakery@demo.local")
    run_pipeline(mocks)
    accepted = client.post(f"/api/applications/{app_id}/offer/accept", headers=headers)
    assert accepted.json()["status"]["code"] == "signing", accepted.text
    # Новый черновик обновлён позже, но главной остаётся заявка на подписании — как на главной кабинета.
    draft = client.post("/api/applications", headers=headers, json={
        "product_code": "express", "purpose": "working_capital", "amount": 1_000_000, "term_months": 12,
        "form": {"consent_bki": True},
    })
    assert draft.status_code == 201, draft.text
    items = client.get("/api/feed", headers=headers).json()
    assert items[0]["title"].startswith("Что проверить в договоре перед подписью кодом")
    assert items[0]["reasons"][0] == "Сейчас договор ждёт вашей подписи"
    assert items[0]["application_id"] == app_id
    assert not any("черновик" in r for i in items for r in i["reasons"])


def test_rejection_and_manual_review_bring_the_explainer_to_the_top(client, mocks):
    # Идущих заявок у компании нет — лента смотрит на последнюю закрытую: отказ.
    submit(client, "start@demo.local", amount=2_000_000)
    run_pipeline(mocks)
    top = client.get("/api/feed", headers=auth(client, "start@demo.local")).json()[0]
    assert top["title"].startswith("Как банк оценивает заявку"), top
    assert top["reasons"][0] == "Сейчас по заявке пришёл отказ"
    # Ручное рассмотрение — без БД: у «Вектора» в общей базе тестов уже есть заявки с предложением аналитика,
    # а они главнее заявки у специалиста.
    review = personal_feed(company("vector"), [app(1, "manual_review", product="invest", purpose="equipment")])[0]
    assert review.title.startswith("Как банк оценивает заявку")
    assert review.reasons[0] == "Сейчас заявку рассматривает специалист"


def test_services_to_the_population_get_their_own_news(client):
    clean = client.get("/api/feed", headers=auth(client, "clean@demo.local")).json()
    smirnova = client.get("/api/feed", headers=auth(client, "smirnova@demo.local")).json()
    for items in (clean, smirnova):
        assert any("Для вашей отрасли: услуги населению" in i["reasons"] for i in items)
    assert any(i["title"].startswith("Химчистки и прачечные") for i in clean)
    assert any(i["title"].startswith("Салоны красоты и парикмахерские на ИП") for i in smirnova)
    assert not any("Салоны красоты" in i["title"] for i in clean)  # новость для ИП не показывается ООО
    bakery = titles(client, auth(client, "bakery@demo.local"))
    assert not any(t.startswith(("Химчистки", "Салоны красоты")) for t in bakery)


def test_home_feeds_of_four_companies_differ():
    # Три новости на главной у пекарни, «ТехноСклада», химчистки и Смирновой совпадают не больше чем в одной —
    # и без заявок, и на этапах их демо-сценариев (одобрение, контрпредложение, другой продукт, запрос выписки).
    states = {
        "без заявок": {"bakery": [], "sklad": [], "clean": [], "smirnova": []},
        "сценарии": {"bakery": [app(1, "approved")], "sklad": [app(2, "counter_offer")],
                     "clean": [app(3, "counter_offer")], "smirnova": [app(4, "needs_info")]},
    }
    for state, apps in states.items():
        tops = {name: top3(name, apps[name]) for name in apps}
        for a, b in combinations(tops, 2):
            assert len(set(tops[a]) & set(tops[b])) <= 1, (state, a, b)
    for name, apps in states["сценарии"].items():
        assert personal_feed(company(name), apps)[0].application_id == apps[0].id, name


def test_no_foreign_industry_news_even_with_matching_products(client, mocks):
    headers = auth(client, "smirnova@demo.local")
    submit(client, "smirnova@demo.local", amount=500_000,
           form={"finance": {"monthly_revenue": 600_000}, "consent_bki": True})
    items = client.get("/api/feed", headers=headers).json()
    assert len(items) >= 4
    assert not any(word in i["title"] for i in items for word in ("производителей", "Строительная", "Маркетплейсы"))
    assert all(len(i["summary"]) > 40 and "Демонстрационный" not in i["summary"] for i in items)
