"""Стенд без демо-режима (DEMO_MODE=false): ни Swagger, ни демо-данных, ни кода подписи в ответе."""

from fastapi.testclient import TestClient

from app import main
from app.config import get_settings
from tests.test_signing import approved


def test_docs_are_served_only_in_demo_mode(client, monkeypatch):
    assert client.get("/api/docs").status_code == 200
    assert client.get("/api/openapi.json").status_code == 200

    monkeypatch.setattr(get_settings(), "demo_mode", False)
    app = main.create_app()
    closed = TestClient(app)
    assert closed.get("/api/docs").status_code == 404
    assert closed.get("/api/openapi.json").status_code == 404
    # Выгрузка спецификации (scripts/export_openapi) строит её из кода и от адреса не зависит.
    assert "/api/applications" in app.openapi()["paths"]


def test_demo_data_is_seeded_only_in_demo_mode(monkeypatch):
    seeded = []
    monkeypatch.setattr(main, "seed", seeded.append)
    settings = get_settings()
    monkeypatch.setattr(settings, "seed_on_start", True)

    monkeypatch.setattr(settings, "demo_mode", False)
    with TestClient(main.create_app()):
        pass
    assert seeded == []

    monkeypatch.setattr(settings, "demo_mode", True)
    with TestClient(main.create_app()):
        pass
    assert len(seeded) == 1


def test_signing_code_is_not_returned_without_demo_mode(client, mocks, monkeypatch):
    app_id, headers = approved(client, mocks)
    assert client.post(f"/api/applications/{app_id}/offer/accept", headers=headers).status_code == 200

    monkeypatch.setattr(get_settings(), "demo_mode", False)
    challenge = client.post(f"/api/applications/{app_id}/signing/code", headers=headers)
    assert challenge.status_code == 200, challenge.text
    assert challenge.json()["demo_code"] is None
    assert client.get("/api/auth/demo-accounts").json() == []
    assert client.post("/api/auth/demo-login", json={"email": "bakery@demo.local"}).status_code == 404
