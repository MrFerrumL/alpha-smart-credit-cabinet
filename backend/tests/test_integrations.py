"""Запросы к внешним системам: сквозной X-Request-ID, лог без ИНН, ключ идемпотентности выдачи в АБС."""

import logging
import uuid
from urllib.parse import quote, unquote

import httpx
import pytest

from app.observability import JsonFormatter, request_id_var
from app.services.integrations import CircuitBreaker, ExternalSources, SourceUnavailable
from tests.test_circuit_breaker import INN, Upstream, sources_for


def contract_number() -> str:
    return f"КД-ТЕСТ-{uuid.uuid4().hex[:8]}"


def test_request_id_goes_to_the_source():
    upstream = Upstream(200)
    sources = sources_for(upstream, None)
    token = request_id_var.set("req-42")
    try:
        sources.egrul(INN)
    finally:
        request_id_var.reset(token)
    sources.egrul(INN)  # вне запроса с ID заголовок не нужен
    assert upstream.requests[0].headers["X-Request-ID"] == "req-42"
    assert "X-Request-ID" not in upstream.requests[1].headers


def test_failed_attempt_is_logged_by_source_and_attempt_without_inn(caplog):
    sources = sources_for(Upstream(503), None, retries=2)
    with caplog.at_level(logging.WARNING, logger="app.integrations"), pytest.raises(SourceUnavailable):
        sources.bki(INN)
    records = [r for r in caplog.records if r.message == "integration attempt failed"]
    assert [(r.source, r.attempt, r.error) for r in records] == [("bki", 1, "HTTP 503"), ("bki", 2, "HTTP 503")]
    assert not [line for line in map(JsonFormatter().format, records) if INN in line]


def test_disbursement_sends_contract_number_as_idempotency_key():
    upstream = Upstream(200)
    sources_for(upstream, None).disburse(contract_number="КД-2026-000007", inn=INN, amount=1_000_000)
    key = upstream.requests[0].headers["Idempotency-Key"]
    assert key.isascii() and unquote(key) == "КД-2026-000007"  # в заголовке HTTP только ASCII


def test_emulator_echoes_request_id(mocks):
    assert mocks.get("/health", headers={"X-Request-ID": "req-7"}).headers["X-Request-ID"] == "req-7"
    assert "X-Request-ID" not in mocks.get("/health").headers


def test_abs_repeats_the_payment_for_the_same_key_and_rejects_other_terms(mocks):
    contract = contract_number()
    key = {"Idempotency-Key": quote(contract, safe="")}
    body = {"contract_number": contract, "inn": INN, "amount": 1_000_000}
    first = mocks.post("/abs/disbursements", json=body, headers=key)
    assert first.status_code == 200, first.text
    again = mocks.post("/abs/disbursements", json=body, headers=key)
    assert again.status_code == 200 and again.json()["payment_id"] == first.json()["payment_id"]
    for change in ({"amount": 2_000_000}, {"inn": "0077020010"}):
        conflict = mocks.post("/abs/disbursements", json=body | change, headers=key)
        assert conflict.status_code == 409, change
    # Без заголовка ключ — номер договора из тела, как и раньше.
    plain = mocks.post("/abs/disbursements", json=body | {"amount": 3_000_000})
    assert plain.status_code == 409


def test_conflicting_repeat_through_the_client_is_an_error_not_an_outage(mocks):
    breaker = CircuitBreaker(2, 20)
    sources = ExternalSources(mocks, timeout=2, retries=3, backoff=0, breaker=breaker)
    contract = contract_number()
    paid = sources.disburse(contract_number=contract, inn=INN, amount=500_000)
    assert sources.disburse(contract_number=contract, inn=INN, amount=500_000)["payment_id"] == paid["payment_id"]
    with pytest.raises(httpx.HTTPStatusError) as conflict:
        sources.disburse(contract_number=contract, inn=INN, amount=600_000)
    assert conflict.value.response.status_code == 409
    assert breaker.state("abs") == "closed"  # АБС ответила — это не сбой связи
