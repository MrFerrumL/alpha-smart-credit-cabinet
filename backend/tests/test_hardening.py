"""Надёжность и безопасность: идемпотентность, токены, поток статусов, права на компанию."""

import time

import jwt

from app.config import get_settings
from app.db import SessionLocal, engine
from app.domain.authority import authority_of, same_person
from app.domain.inn import _W10, _check_digit, is_valid_inn
from app.models import User
from app.security import hash_password
from mockapi.data import COMPANIES
from mockapi.generator import generate
from tests.conftest import auth, run_pipeline
from tests.test_pipeline import submit


def _draft(client, headers) -> int:
    body = {
        "product_code": "express",
        "purpose": "working_capital",
        "amount": 1_000_000,
        "term_months": 12,
        "form": {"finance": {"monthly_revenue": 4_000_000}, "consent_bki": True},
    }
    response = client.post("/api/applications", json=body, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _org_inn(prefix9: str) -> str:
    digits = [int(c) for c in prefix9]
    inn = prefix9 + str(_check_digit(digits, _W10))
    assert is_valid_inn(inn)
    return inn


def _client_without_company(email: str, full_name: str) -> dict:
    with SessionLocal() as db:
        if db.query(User).filter_by(email=email).first() is None:
            db.add(User(email=email, full_name=full_name, position="Сотрудник", role="client", can_sign=True,
                        password_hash=hash_password("demo1234")))
            db.commit()
    return email


def _login(client, email: str) -> dict:
    token = client.post("/api/auth/login", json={"email": email, "password": "demo1234"}).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def test_idempotency_key_is_scoped_to_its_application(client):
    headers = auth(client, "bakery@demo.local")
    key = {"Idempotency-Key": "same-key-for-two-applications"}
    first, second = _draft(client, headers), _draft(client, headers)
    assert client.post(f"/api/applications/{first}/submit", headers=headers | key).status_code == 200
    reused = client.post(f"/api/applications/{second}/submit", headers=headers | key)
    assert reused.status_code == 200, reused.text
    assert reused.json()["status"]["code"] == "submitted"
    repeat = client.post(f"/api/applications/{second}/submit", headers=headers | key)
    assert repeat.status_code == 200
    events = [e["event"] for e in client.get(f"/api/applications/{second}/events", headers=headers).json()]
    assert events.count("submitted") == 1


def test_token_without_subject_is_rejected_as_unauthorized(client):
    settings = get_settings()
    no_sub = jwt.encode({"role": "analyst", "exp": int(time.time()) + 600}, settings.secret_key, algorithm="HS256")
    bad_sub = jwt.encode({"sub": "not-a-number", "exp": int(time.time()) + 600}, settings.secret_key,
                         algorithm="HS256")
    no_exp = jwt.encode({"sub": "1"}, settings.secret_key, algorithm="HS256")
    for token in (no_sub, bad_sub, no_exp):
        response = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 401
        assert response.json()["code"] == "unauthorized"


def test_open_status_stream_does_not_hold_a_database_connection(client, mocks):
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
    run_pipeline(mocks)  # manual_review: поток не закрывается сам
    with client.stream("GET", f"/api/applications/{app_id}/stream", headers=headers) as response:
        lines = response.iter_lines()
        assert next(lines).startswith("event: update")
        assert engine.pool.checkedout() == 0


def test_same_person_matches_profile_name_against_registry_name():
    assert same_person("Никита Новиков", "Новиков Никита Алексеевич")
    assert same_person("Алёна Ёлкина", "Елкина Алена Петровна")
    assert not same_person("Никита Новиков", "Новикова Анна Сергеевна")
    assert not same_person("Новиков", "Новиков Никита Алексеевич")  # одной фамилии мало
    assert not same_person("Никита Алексеевич", "Новиков Никита Алексеевич")  # без фамилии нельзя
    egrul = {"director": {"name": "Орлов Дмитрий Андреевич"}, "founders": [{"name": "Орлова Мария Ильинична"}]}
    assert authority_of("Дмитрий Орлов", egrul).can_sign
    founder = authority_of("Мария Орлова", egrul)
    assert founder.may_connect and not founder.can_sign
    assert not authority_of("Иван Петров", egrul).may_connect


def test_outsider_learns_nothing_about_a_connected_company(client):
    stranger = _login(client, _client_without_company("claimer@demo.local", "Никита Новиков"))
    response = client.post("/api/companies/link", json={"inn": "0077010019"}, headers=stranger)
    assert response.status_code == 403  # тот же ответ, что и для неподключённой компании
    assert client.get("/api/applications", headers=stranger).json() == []


def test_founder_cannot_join_a_company_already_in_the_cabinet(client):
    founder = _login(client, _client_without_company("sklad-founder@demo.local", "Мария Орлова"))
    response = client.post("/api/companies/link", json={"inn": "0077020024"}, headers=founder)
    assert response.status_code == 409
    assert "уже подключена" in response.json()["detail"]


def test_head_from_registry_can_always_join_and_sign(client):
    head = _login(client, _client_without_company("second-head@demo.local", "Ольга Северова"))
    response = client.post("/api/companies/link", json={"inn": "0077010019"}, headers=head)
    assert response.status_code == 200, response.text
    assert client.get("/api/auth/me", headers=head).json()["can_sign"] is True


def test_only_head_or_founder_from_registry_can_connect_a_company(client):
    outsider = _login(client, _client_without_company("outsider@demo.local", "Иван Посторонний"))
    response = client.post("/api/companies/link", json={"inn": _org_inn("771234567")}, headers=outsider)
    assert response.status_code == 403
    assert response.json()["code"] == "forbidden"
    me = client.get("/api/auth/me", headers=outsider).json()
    assert me["company"] is None


def test_founder_connects_company_but_cannot_sign(client, monkeypatch):
    inn = _org_inn("007708008")
    registry = generate(inn)
    registry["egrul"]["director"] = {"name": "Громов Пётр Ильич", "position": "Генеральный директор"}
    registry["egrul"]["founders"] = [{"name": "Громова Анна Петровна", "share": 100}]
    monkeypatch.setitem(COMPANIES, inn, registry)
    founder = _login(client, _client_without_company("founder@demo.local", "Анна Громова"))
    response = client.post("/api/companies/link", json={"inn": inn}, headers=founder)
    assert response.status_code == 200, response.text
    me = client.get("/api/auth/me", headers=founder).json()
    assert me["company"]["inn"] == inn
    assert me["can_sign"] is False


def test_step_that_keeps_crashing_hands_application_to_specialist(client, mocks, monkeypatch):
    from app.scoring import rules

    def broken(_features):
        raise RuntimeError("scorecard misconfigured")

    monkeypatch.setattr(rules, "score", broken)
    app_id, headers = submit(client, "bakery@demo.local")
    run_pipeline(mocks)
    app = client.get(f"/api/applications/{app_id}", headers=headers).json()
    assert app["status"]["code"] == "manual_review"
    analyst = auth(client, "analyst@demo.local")
    card = client.get(f"/api/applications/{app_id}/assessment", headers=analyst).json()
    assert card["review_reason"] == "pipeline_failure"
    assert card["scored"] is False
