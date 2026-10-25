"""Журнал входа: каждая попытка — строка с исходом и отпечатком почты, без самой почты и пароля."""

import hashlib
import hmac
import logging

from app.config import get_settings
from app.observability import JsonFormatter
from app.security import fingerprint, throttle_key

CLIENT = "bakery@demo.local"
PASSWORD = "demo1234"


def sha(email: str) -> str:
    """Ожидаемый отпечаток, посчитанный независимо от кода: HMAC-SHA256 почты ключом, выведенным из SECRET_KEY."""
    key = hmac.new(get_settings().secret_key.encode(), b"potok/log-fingerprint", hashlib.sha256).digest()
    return hmac.new(key, email.encode(), hashlib.sha256).hexdigest()[:12]


def login(client, email: str, password: str):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def attempts(caplog) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.name == "app.auth"]


def test_password_attempts_are_logged_without_email_or_password(client, caplog):
    caplog.set_level(logging.INFO, logger="app.auth")
    user_id = login(client, CLIENT, PASSWORD).json()["user"]["id"]
    login(client, f" {CLIENT.upper()} ", "secret-guess-1")
    login(client, "nobody@demo.local", "secret-guess-2")
    for _ in range(4):
        login(client, CLIENT, "secret-guess-3")
    login(client, CLIENT, PASSWORD)  # пять неудач подряд — вход закрыт

    records = attempts(caplog)
    assert [r.outcome for r in records] == ["success"] + ["failure"] * 6 + ["throttled"]
    assert {r.event for r in records} == {"login"}
    assert (records[0].user_id, records[0].email_sha) == (user_id, sha(CLIENT))
    assert (records[1].user_id, records[1].email_sha) == (user_id, sha(CLIENT))  # регистр и пробелы не в счёт
    assert (records[2].user_id, records[2].email_sha) == (None, sha("nobody@demo.local"))
    assert (records[-1].user_id, records[-1].email_sha) == (None, sha(CLIENT))

    lines = "\n".join(JsonFormatter().format(r) for r in records)
    for secret in (CLIENT, "bakery", "nobody", PASSWORD, "secret-guess"):
        assert secret not in lines


def test_fingerprint_needs_the_secret_key(monkeypatch):
    before = fingerprint(CLIENT)
    assert len(before) == 12 and before == sha(CLIENT)
    assert before != hashlib.sha256(CLIENT.encode()).hexdigest()[:12]  # простой sha256 подбирается по словарю почт
    assert fingerprint("other@demo.local") != before
    monkeypatch.setattr(get_settings(), "secret_key", "another-secret-key")
    assert fingerprint(CLIENT) != before


def test_keys_are_derived_per_purpose_not_taken_from_the_signing_key():
    secret = get_settings().secret_key.encode()
    # Почту присылает клиент: HMAC самим ключом токенов дал бы ему оракул подписи (например, для «header.payload»).
    direct = hmac.new(secret, CLIENT.encode(), hashlib.sha256).hexdigest()
    assert fingerprint(CLIENT) != direct[:12] and throttle_key(CLIENT) != direct
    assert throttle_key(CLIENT)[:12] != fingerprint(CLIENT)  # метки разные: журнал не выдаёт ключ счётчика
    assert len(throttle_key(CLIENT)) == 64
    assert throttle_key("ab", "c") != throttle_key("a", "bc")  # части ключа (почта, адрес) не склеиваются


def test_demo_login_is_logged_too(client, caplog):
    caplog.set_level(logging.INFO, logger="app.auth")
    ok = client.post("/api/auth/demo-login", json={"email": CLIENT})
    unknown = client.post("/api/auth/demo-login", json={"email": "nobody@demo.local"})
    assert (ok.status_code, unknown.status_code) == (200, 404)

    first, second = attempts(caplog)
    assert (first.outcome, first.method, first.user_id) == ("success", "demo", ok.json()["user"]["id"])
    assert (second.outcome, second.method, second.user_id) == ("failure", "demo", None)
    assert first.email_sha == sha(CLIENT) and second.email_sha == sha("nobody@demo.local")
