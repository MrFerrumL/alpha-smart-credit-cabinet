"""Охрана маршрутов: каждый эндпоинт либо явно публичный, либо требует вход и нужную роль.

Новый маршрут без охраны не пройдёт этот тест, пока его не внесут в PUBLIC осознанно."""

import re

import pytest
from fastapi.routing import APIRoute

from app.api import deps
from app.main import app
from tests.conftest import auth

CLIENT = "bakery@demo.local"
ANALYST = "analyst@demo.local"

# Зависимости, которые пускают только вошедшего пользователя (остальные завязаны на них).
LOGIN_GUARDS = {deps.get_current_user, deps.get_stream_user, deps.require_client, deps.require_analyst}

# Маршруты, открытые без входа. Всё остальное обязано быть под охраной.
PUBLIC = {
    ("POST", "/api/auth/login"),
    ("GET", "/api/auth/demo-accounts"),
    ("POST", "/api/auth/demo-login"),
    ("GET", "/api/meta"),
    ("GET", "/api/products"),
    ("POST", "/api/products/match"),
    ("GET", "/api/products/{code}/calculate"),
    ("GET", "/health/live"),
    ("GET", "/health/ready"),
}
# Публичный маршрут, который появляется отдельной веткой: если он есть, он допустим; если нет — не ошибка.
OPTIONAL_PUBLIC = {("GET", "/health/deps")}
# Страницы Swagger и спецификация (FastAPI регистрирует их не как APIRoute; вне демо-режима их нет вовсе).
DOCS = {"/api/docs", "/api/openapi.json", "/docs/oauth2-redirect"}


def all_routes() -> list:
    """Маршруты приложения с учётом include_router. В FastAPI 0.159 app.routes хранит вложенные роутеры целиком,
    раскрывает их iter_route_contexts; в более старых версиях список уже плоский."""
    try:
        from fastapi.routing import iter_route_contexts
    except ImportError:
        return list(app.routes)
    return list(iter_route_contexts(app.routes))


def original(route):
    return getattr(route, "original_route", route)


def api_routes() -> list:
    return [r for r in all_routes() if isinstance(original(r), APIRoute)]


def dependencies_of(dependant) -> set:
    """Все вызываемые зависимости маршрута, в том числе вложенные."""
    found = set()
    for sub in dependant.dependencies:
        found.add(sub.call)
        found |= dependencies_of(sub)
    return found


def operations(routes: list) -> dict[tuple[str, str], set]:
    return {(method, r.path): dependencies_of(r.dependant) for r in routes for method in r.methods}


ROUTES = api_routes()
OPERATIONS = operations(ROUTES)
ANALYST_ONLY = sorted(op for op, calls in OPERATIONS.items() if deps.require_analyst in calls)
CLIENT_ONLY = sorted(op for op, calls in OPERATIONS.items() if deps.require_client in calls)
GUARDED = sorted(op for op, calls in OPERATIONS.items() if calls & LOGIN_GUARDS)


def url(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "1", path)  # подставляем любой id: охрана срабатывает до поиска в БД


@pytest.fixture
def tokens(client) -> dict[str, dict]:
    return {"client": auth(client, CLIENT), "analyst": auth(client, ANALYST)}


# --- карта маршрутов ---------------------------------------------------------------------------------------------


def test_every_route_is_public_by_decision_or_requires_login():
    unguarded = {op for op, calls in OPERATIONS.items() if not calls & LOGIN_GUARDS}
    stray = sorted(unguarded - PUBLIC - OPTIONAL_PUBLIC)
    assert not stray, f"маршруты без охраны, которых нет в PUBLIC: {stray}"


def test_public_list_has_no_dead_entries_and_public_routes_are_not_guarded():
    assert not sorted(PUBLIC - set(OPERATIONS)), "в PUBLIC есть маршруты, которых больше нет"
    guarded_but_listed = sorted((PUBLIC | OPTIONAL_PUBLIC) & set(GUARDED))
    assert not guarded_but_listed, f"маршруты в PUBLIC на самом деле под охраной: {guarded_but_listed}"


def test_the_walk_sees_every_documented_operation():
    spec = app.openapi()["paths"]
    documented = {(method.upper(), path) for path, item in spec.items() for method in item}
    assert documented and documented <= set(OPERATIONS), sorted(documented - set(OPERATIONS))
    assert len(GUARDED) >= 20 and ANALYST_ONLY and CLIENT_ONLY  # обход не пуст, роли распознаются


def test_only_documentation_pages_are_not_api_routes():
    other = {r.path for r in all_routes() if not isinstance(original(r), APIRoute)}
    assert other <= DOCS, sorted(other - DOCS)


# --- без входа ---------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(("method", "path"), GUARDED, ids=[f"{m} {p}" for m, p in GUARDED])
def test_guarded_route_rejects_anonymous(client, method, path):
    response = client.request(method, url(path))
    assert response.status_code == 401, response.text
    assert response.json()["code"] == "unauthorized"


@pytest.mark.parametrize(("method", "path"), GUARDED, ids=[f"{m} {p}" for m, p in GUARDED])
def test_guarded_route_rejects_a_forged_token(client, method, path):
    response = client.request(method, url(path), headers={"Authorization": "Bearer not.a.token"})
    assert response.status_code == 401, response.text


# --- роли --------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(("method", "path"), ANALYST_ONLY, ids=[f"{m} {p}" for m, p in ANALYST_ONLY])
def test_client_is_forbidden_on_analyst_routes(client, tokens, method, path):
    response = client.request(method, url(path), headers=tokens["client"])
    assert response.status_code == 403, response.text
    assert response.json()["code"] == "forbidden"


@pytest.mark.parametrize(("method", "path"), CLIENT_ONLY, ids=[f"{m} {p}" for m, p in CLIENT_ONLY])
def test_analyst_is_forbidden_on_client_routes(client, tokens, method, path):
    response = client.request(method, url(path), headers=tokens["analyst"])
    assert response.status_code == 403, response.text
    assert response.json()["code"] == "forbidden"


# Те же проверки на конкретных действиях: если разбор зависимостей когда-нибудь перестанет их находить,
# явная таблица всё равно поймает пропуск охраны.
CLIENT_ON_ANALYST = [
    ("GET", "/api/applications/1/assessment"),
    ("POST", "/api/applications/1/assessment/replay"),
    ("POST", "/api/applications/1/decision"),
    ("POST", "/api/policy/simulate"),
    ("GET", "/api/system/jobs"),
]
ANALYST_ON_CLIENT = [
    ("POST", "/api/applications/1/submit"),
    ("POST", "/api/applications/1/offer/accept"),
    ("POST", "/api/applications/1/signing/code"),
]


@pytest.mark.parametrize(("method", "path"), CLIENT_ON_ANALYST, ids=[f"{m} {p}" for m, p in CLIENT_ON_ANALYST])
def test_client_gets_403_on_assessment_decision_policy_and_system(client, tokens, method, path):
    assert client.request(method, path, headers=tokens["client"]).status_code == 403


@pytest.mark.parametrize(("method", "path"), ANALYST_ON_CLIENT, ids=[f"{m} {p}" for m, p in ANALYST_ON_CLIENT])
def test_analyst_gets_403_on_submit_accept_and_signing(client, tokens, method, path):
    assert client.request(method, path, headers=tokens["analyst"]).status_code == 403


def test_guards_do_not_block_the_right_role(client, tokens):
    assert client.get("/api/loans", headers=tokens["client"]).status_code == 200
    assert client.get("/api/applications", headers=tokens["analyst"]).status_code == 200
    assert client.get("/api/auth/me", headers=tokens["client"]).json()["role"] == "client"
    assert client.get("/api/auth/me", headers=tokens["analyst"]).json()["role"] == "analyst"
