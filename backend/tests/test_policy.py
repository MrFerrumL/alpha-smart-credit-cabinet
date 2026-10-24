"""Правила кредитной политики на компаниях с заданным профилем риска (данные эмулятора подменяются)."""

from app.db import SessionLocal
from app.models import Company, User
from app.security import hash_password
from mockapi.data import COMPANIES
from mockapi.generator import generate
from tests.conftest import run_pipeline
from tests.test_pipeline import get

_counter = iter(range(100, 1000))


def _client_for(monkeypatch, *, revenue_year: int, expenses_year: int, loans: list[dict]) -> tuple[dict, str]:
    """Компания с заданными финансами и кредитами в эмуляторе и клиент-руководитель в кабинете."""
    from tests.test_hardening import _org_inn

    inn = _org_inn(f"0077{next(_counter):05d}")
    data = generate(inn)
    data["egrul"]["registered_at"] = "2015-01-15"
    data["egrul"]["status"] = {"code": "active", "title": "Действующая"}
    data["fns"] |= {"revenue": revenue_year, "expenses": expenses_year, "tax_debt": 0, "mass_address": False}
    data["bki"] = {"loans": loans, "inquiries_90d": 1}
    monkeypatch.setitem(COMPANIES, inn, data)
    email = f"policy-{inn}@demo.local"
    with SessionLocal() as db:
        company = Company(inn=inn, name=data["egrul"]["full_name"], short_name=data["egrul"]["short_name"],
                          legal_form="ООО", okved=data["egrul"]["okved"]["code"])
        db.add(company)
        db.flush()
        db.add(User(email=email, full_name="Тест Политика", position="Директор", role="client", can_sign=True,
                    password_hash=hash_password("demo1234"), company_id=company.id))
        db.commit()
    return email, inn


def _loan(monthly: int, overdue_now: int = 0, overdue_max: int = 0) -> dict:
    return {"lender": "Банк Развитие", "type": "Кредит", "amount": monthly * 24, "balance": monthly * 12,
            "monthly_payment": monthly, "opened_at": "2023-01-01", "overdue_days_current": overdue_now,
            "overdue_amount_current": monthly if overdue_now else 0, "overdue_max_days_24m": overdue_max}


def _apply(client, email: str, **params) -> tuple[int, dict]:
    token = client.post("/api/auth/login", json={"email": email, "password": "demo1234"}).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    body = {"product_code": "express", "purpose": "working_capital", "amount": 1_000_000, "term_months": 12,
            "form": {"finance": {"monthly_revenue": 1}, "consent_bki": True}} | params
    app_id = client.post("/api/applications", json=body, headers=headers).json()["id"]
    assert client.post(f"/api/applications/{app_id}/submit", headers=headers).status_code == 200
    return app_id, headers


def test_current_overdue_goes_to_specialist_even_with_a_good_grade(client, mocks, monkeypatch):
    email, _ = _client_for(monkeypatch, revenue_year=36_000_000, expenses_year=30_000_000,
                           loans=[_loan(50_000, overdue_now=20, overdue_max=20)])
    app_id, headers = _apply(client, email)
    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "manual_review"
    assert "просрочка" in app["decision"]["reasons"][0]


def test_profit_must_cover_the_new_payment(client, mocks, monkeypatch):
    # Выручка 3 млн в месяц, но прибыль лишь 60 тыс.: 1 млн на 12 мес. (≈94 тыс. в месяц) не покрывается.
    email, _ = _client_for(monkeypatch, revenue_year=36_000_000, expenses_year=35_280_000, loans=[])
    app_id, headers = _apply(client, email)
    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "counter_offer"
    offer = app["offer"]
    assert offer["monthly_payment"] * 1.2 <= 60_000
    assert offer["amount"] < 1_000_000 or offer["term_months"] > 12


def test_other_product_is_offered_when_the_requested_one_does_not_fit(client, mocks, monkeypatch):
    # Действующие платежи съедают почти половину выручки: «Экспресс» не проходит даже на минимальную сумму,
    # а у овердрафта платятся только проценты — он проходит.
    # Овердрафт проверяется как кредит, гасимый равными долями за 12 мес., — возврат лимита учтён.
    email, _ = _client_for(monkeypatch, revenue_year=12_000_000, expenses_year=9_600_000,
                           loans=[_loan(485_000)])
    app_id, headers = _apply(client, email, amount=300_000, term_months=12)
    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "counter_offer", app["decision"]
    assert app["offer"]["product_code"] == "overdraft"
    assert app["offer"]["amount"] == 150_000
    assert "Овердрафт" in app["decision"]["reasons"][0]
    accepted = client.post(f"/api/applications/{app_id}/offer/accept", headers=headers)
    assert accepted.status_code == 200, accepted.text
    # Заявка хранит то, что просили, а принятые условия — в предложении: по ним кабинет показывает кредит.
    app = get(client, app_id, headers)
    assert (app["product"]["code"], app["amount"]) == ("express", 300_000)
    offer = app["offer"]
    assert (offer["status"], offer["product_code"], offer["amount"]) == ("accepted", "overdraft", 150_000)
    contract = client.get(f"/api/applications/{app_id}/contract", headers=headers).json()
    assert contract["product_name"] == "Овердрафт" and contract["amount"] == 150_000


def test_loss_making_business_gets_a_specific_rejection(client, mocks, monkeypatch):
    email, _ = _client_for(monkeypatch, revenue_year=36_000_000, expenses_year=36_500_000, loans=[])
    app_id, headers = _apply(client, email)
    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "rejected"
    assert app["decision"]["reasons"] == ["По данным налоговой бизнес не приносит прибыли — платёж по кредиту нечем обслуживать"]
