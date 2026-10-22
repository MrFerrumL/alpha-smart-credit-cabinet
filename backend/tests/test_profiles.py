"""Профили риска эмулятора: произвольный ИНН даёт разные исходы, а не только одобрения."""

import pytest

from app.db import SessionLocal
from app.domain.inn import _W10, _check_digit
from app.models import Company, User
from app.security import hash_password
from mockapi.generator import generate, profile_of
from tests.conftest import run_pipeline
from tests.test_pipeline import get


def inn_with_profile(ninth: str, eighth: str = "1") -> str:
    """ИНН организации с заданной девятой (профиль) и восьмой цифрой; контрольный разряд — по алгоритму ФНС."""
    prefix = f"0078012{eighth}{ninth}"
    return prefix + str(_check_digit([int(c) for c in prefix], _W10))


def apply_as_head(client, inn: str) -> tuple[int, dict]:
    egrul = generate(inn)["egrul"]
    last, first, _ = egrul["director"]["name"].split()
    email = f"head-{inn}@demo.local"
    with SessionLocal() as db:
        if db.query(User).filter_by(email=email).first() is None:
            company = Company(inn=inn, name=egrul["full_name"], short_name=egrul["short_name"], legal_form="ООО",
                              director=egrul["director"]["name"], okved=egrul["okved"]["code"])
            db.add(company)
            db.flush()
            db.add(User(email=email, full_name=f"{first} {last}", position="Директор", role="client", can_sign=True,
                        password_hash=hash_password("demo1234"), company_id=company.id))
            db.commit()
    token = client.post("/api/auth/login", json={"email": email, "password": "demo1234"}).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    body = {"product_code": "express", "purpose": "working_capital", "amount": 2_000_000, "term_months": 12,
            "form": {"finance": {}, "consent_bki": True}}
    app_id = client.post("/api/applications", json=body | {"form": body["form"] | {"finance": {"monthly_revenue": 1}}},
                         headers=headers).json()["id"]
    assert client.post(f"/api/applications/{app_id}/submit", headers=headers).status_code == 200
    return app_id, headers


@pytest.mark.parametrize(
    ("ninth", "eighth", "expected"),
    [
        ("7", "1", {"manual_review"}),  # текущая просрочка
        ("9", "0", {"rejected"}),  # ликвидация
        ("9", "1", {"manual_review"}),  # реорганизация
        ("9", "2", {"rejected"}),  # банкротство
    ],
)
def test_risk_profiles_lead_to_expected_outcomes(client, mocks, ninth, eighth, expected):
    inn = inn_with_profile(ninth, eighth)
    app_id, headers = apply_as_head(client, inn)
    run_pipeline(mocks)
    app = get(client, app_id, headers)
    assert app["status"]["code"] in expected, (profile_of(inn), app["decision"])


def test_bankruptcy_is_worded_as_bankruptcy_not_liquidation(client, mocks):
    app_id, headers = apply_as_head(client, inn_with_profile("9", "2"))
    run_pipeline(mocks)
    reasons = get(client, app_id, headers)["decision"]["reasons"]
    assert any("банкротства" in r for r in reasons) and not any("ликвидации" in r for r in reasons)


def test_profiles_produce_more_than_one_outcome(client, mocks):
    outcomes = set()
    for ninth in "0123456789":
        app_id, headers = apply_as_head(client, inn_with_profile(ninth, "4"))
        run_pipeline(mocks)
        outcomes.add(get(client, app_id, headers)["status"]["code"])
    assert len(outcomes) >= 3, outcomes
