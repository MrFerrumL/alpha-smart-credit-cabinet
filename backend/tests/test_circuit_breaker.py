"""Предохранитель внешних источников: открывается только на затяжном сбое, пока открыт — в сеть не ходит,
после паузы пропускает один пробный запрос. Короткий сбой из README он не трогает."""

import contextlib
import logging

import httpx
import pytest

from app.config import Settings, get_settings
from app.db import SessionLocal
from app.models import ApplicationEvent, utcnow
from app.pipeline.runner import run_until_idle
from app.services.applications import event_out
from app.services.integrations import (
    CIRCUIT_OPEN,
    CircuitBreaker,
    ExternalSources,
    NotInSource,
    SourceUnavailable,
    get_breaker,
    get_sources,
)
from tests.conftest import run_pipeline
from tests.test_pipeline import get, submit

INN = "0077010019"
README_RETRY = "Бюро кредитных историй: нет ответа — повторяем запрос"
EGRUL_PAUSED = "ЕГРЮЛ недоступен — запросы приостановлены, повторим автоматически"


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class Upstream:
    """Источник за httpx.MockTransport: отвечает заданным кодом (или бросает исключение) и считает запросы."""

    def __init__(self, status: int = 503) -> None:
        self.status = status
        self.error: Exception | None = None
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        return httpx.Response(self.status, json={"inn": INN})


def sources_for(upstream: Upstream, breaker: CircuitBreaker | None, retries: int = 3) -> ExternalSources:
    client = httpx.Client(transport=httpx.MockTransport(upstream), base_url="http://mocks")
    return ExternalSources(client, timeout=1, retries=retries, backoff=0, breaker=breaker)


def production_sources(mocks) -> tuple[ExternalSources, CircuitBreaker]:
    """Источники с настройками по умолчанию, как у воркера: три попытки на шаг, предохранитель 5 сбоев / 20 с."""
    settings = get_settings()
    breaker = CircuitBreaker.from_settings(settings)
    return ExternalSources(mocks, timeout=2, retries=settings.integration_retries, backoff=0, breaker=breaker), breaker


def retry_titles(client, app_id: int, headers: dict) -> list[str]:
    history = client.get(f"/api/applications/{app_id}/events", headers=headers).json()
    return [e["title"] for e in history if e["event"] == "check_retry"]


def test_breaker_opens_after_failures_in_a_row_and_then_fails_fast():
    upstream, clock = Upstream(503), Clock()
    breaker = CircuitBreaker(5, 20, clock=clock)
    sources = sources_for(upstream, breaker)
    with pytest.raises(SourceUnavailable) as first:
        sources.egrul(INN)
    # Три сбоя одного шага — ещё не повод для паузы: шаг просто повторится.
    assert first.value.reason == "HTTP 503" and len(upstream.requests) == 3
    assert breaker.state("egrul") == "closed"
    with pytest.raises(SourceUnavailable) as second:
        sources.egrul(INN)
    assert second.value.reason == CIRCUIT_OPEN and len(upstream.requests) == 5  # пятый сбой подряд открыл
    clock.now += 19
    with pytest.raises(SourceUnavailable) as third:
        sources.egrul(INN)
    assert third.value.reason == CIRCUIT_OPEN and len(upstream.requests) == 5  # в сеть не ходили
    assert breaker.state("egrul") == "open"
    upstream.status = 200
    assert sources.bki(INN) == {"inn": INN}  # у других источников свой счёт


def test_timeouts_and_connection_errors_count_as_failures():
    upstream = Upstream()
    breaker = CircuitBreaker(2, 20)
    sources = sources_for(upstream, breaker, retries=1)
    upstream.error = httpx.ReadTimeout("slow")
    with pytest.raises(SourceUnavailable) as timeout:
        sources.fns(INN)
    assert timeout.value.reason == "timeout"
    upstream.error = httpx.ConnectError("refused")
    with pytest.raises(SourceUnavailable) as refused:
        sources.fns(INN)
    assert refused.value.reason == CIRCUIT_OPEN and breaker.state("fns") == "open"


def test_any_answer_without_5xx_resets_the_count():
    upstream = Upstream()
    breaker = CircuitBreaker(3, 20)
    sources = sources_for(upstream, breaker, retries=1)
    for status in (503, 503, 404, 502, 500, 200, 503, 503):
        upstream.status = status
        with contextlib.suppress(SourceUnavailable, NotInSource):
            sources.fns(INN)
    assert breaker.state("fns") == "closed"  # «нет данных» (404) и 200 — источник жив
    upstream.status = 503
    with pytest.raises(SourceUnavailable) as third:
        sources.fns(INN)
    assert third.value.reason == CIRCUIT_OPEN


def test_after_the_pause_one_successful_probe_closes_the_breaker(caplog):
    upstream, clock = Upstream(503), Clock()
    breaker = CircuitBreaker(2, 20, clock=clock)
    sources = sources_for(upstream, breaker)
    with caplog.at_level(logging.INFO, logger="app.integrations"):
        with pytest.raises(SourceUnavailable):
            sources.bki(INN)
        assert len(upstream.requests) == 2 and breaker.state("bki") == "open"
        clock.now += 20
        upstream.status = 200
        assert sources.bki(INN) == {"inn": INN}
    assert len(upstream.requests) == 3  # ровно один пробный запрос
    assert breaker.state("bki") == "closed"
    assert [(r.message, r.source) for r in caplog.records if r.message.startswith("circuit")] == [
        ("circuit opened", "bki"),
        ("circuit closed", "bki"),
    ]


def test_failed_probe_reopens_and_only_one_probe_goes_through():
    upstream, clock = Upstream(503), Clock()
    breaker = CircuitBreaker(2, 20, clock=clock)
    sources = sources_for(upstream, breaker)
    with pytest.raises(SourceUnavailable):
        sources.egrul(INN)
    assert len(upstream.requests) == 2
    clock.now += 20
    with pytest.raises(SourceUnavailable) as probe:
        sources.egrul(INN)
    assert probe.value.reason == CIRCUIT_OPEN and len(upstream.requests) == 3  # проба не прошла — без повторов
    assert breaker.state("egrul") == "open"
    clock.now += 19
    assert not breaker.allow("egrul")  # пауза отсчитывается заново от неудачной пробы
    clock.now += 1
    assert breaker.allow("egrul") and breaker.state("egrul") == "half_open"
    assert not breaker.allow("egrul")  # второй запрос ждёт итога пробы
    clock.now += 20
    assert breaker.allow("egrul")  # проба без итога (оборвалась исключением) не держит паузу вечно
    breaker.record_success("egrul")
    assert breaker.state("egrul") == "closed" and breaker.allow("egrul")


def test_threshold_from_settings_stays_above_the_attempts_of_one_step():
    default = CircuitBreaker.from_settings(Settings(_env_file=None))
    assert (default.threshold, default.cooldown_s) == (5, 20.0)
    assert default.threshold > Settings(_env_file=None).integration_retries
    low = CircuitBreaker.from_settings(Settings(_env_file=None, breaker_threshold=2, integration_retries=3))
    assert low.threshold == 4
    assert CircuitBreaker.from_settings(Settings(_env_file=None, breaker_threshold=0)) is None


def test_worker_sources_share_the_process_breaker():
    sources = get_sources.__wrapped__()
    try:
        assert sources._breaker is get_breaker() is not None
    finally:
        sources._client.close()


def test_readme_outage_of_three_errors_never_opens_the_breaker(client, mocks, caplog):
    """README, «Сбой источника»: count 3 — шаг повторяется и доходит до решения, как и без предохранителя."""
    sources, breaker = production_sources(mocks)
    run_pipeline(mocks)  # готовые задачи других тестов не должны попасть под этот прогон
    mocks.post("/admin/faults", json={"source": "bki", "mode": "error", "count": 3})
    app_id, headers = submit(client, "bakery@demo.local")
    with caplog.at_level(logging.INFO, logger="app.integrations"):
        run_until_idle(SessionLocal, sources)
    assert get(client, app_id, headers)["status"]["code"] == "approved"
    assert retry_titles(client, app_id, headers) == [README_RETRY]
    assert breaker.state("bki") == "closed"
    assert "circuit opened" not in caplog.messages


def test_sustained_outage_pauses_the_source_and_history_says_so(client, mocks):
    sources, breaker = production_sources(mocks)
    run_pipeline(mocks)
    app_id, headers = submit(client, "bakery@demo.local")
    mocks.post("/admin/faults", json={"source": "egrul", "mode": "error"})
    run_until_idle(SessionLocal, sources)
    assert breaker.state("egrul") == "open"
    titles = retry_titles(client, app_id, headers)
    # Первая попытка шага — обычный повтор, дальше источник на паузе; заявка уходит специалисту, как и раньше.
    assert titles[0] == "ЕГРЮЛ: нет ответа — повторяем запрос"
    assert titles[1:] and set(titles[1:]) == {EGRUL_PAUSED}
    assert len(titles) == get_settings().pipeline_max_attempts
    app = get(client, app_id, headers)
    assert app["status"]["code"] == "manual_review"
    assert "ЕГРЮЛ" in app["decision"]["reasons"][0]


def test_paused_check_reads_as_a_pause_for_every_source():
    def title(payload: dict) -> str:
        ev = ApplicationEvent(id=1, created_at=utcnow(), actor_type="system", event="check_retry", payload=payload)
        return event_out(ev).title

    assert title({"source": "egrul", "reason": CIRCUIT_OPEN}) == EGRUL_PAUSED
    assert title({"source": "fns", "reason": CIRCUIT_OPEN}) == (
        "ФНС «Прозрачный бизнес» недоступна — запросы приостановлены, повторим автоматически"
    )
    assert title({"source": "bki", "reason": CIRCUIT_OPEN}) == (
        "Бюро кредитных историй недоступно — запросы приостановлены, повторим автоматически"
    )
    # Обычный повтор и события, записанные до появления причины, читаются по-прежнему.
    assert title({"source": "bki", "reason": "HTTP 503"}) == README_RETRY
    assert title({"source": "bki"}) == README_RETRY
