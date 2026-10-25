"""Клиент внешних систем: ЕГРЮЛ/ЕГРИП, бюро кредитных историй, ФНС «Прозрачный бизнес», АБС банка.

В прототипе все внешние системы эмулирует сервис mocks. Клиент делает то же, что делал бы с
настоящими интеграциями: ограничивает время ответа, повторяет запрос при сбоях с растущей
паузой, отличает «данных нет» от «источник недоступен» и не опрашивает источник, который лежит
долго (предохранитель, CircuitBreaker).
"""

import logging
import threading
import time
from collections.abc import Callable
from functools import lru_cache
from urllib.parse import quote

import httpx

from app.config import Settings, get_settings
from app.observability import request_id_var

log = logging.getLogger("app.integrations")

SOURCE_NAMES = ("egrul", "fns", "bki", "abs")
# Причина отказа, когда предохранитель источника открыт: запрос не отправлялся.
CIRCUIT_OPEN = "circuit open"


class SourceUnavailable(Exception):
    def __init__(self, source: str, reason: str):
        super().__init__(f"{source}: {reason}")
        self.source = source
        self.reason = reason


class NotInSource(Exception):
    def __init__(self, source: str):
        super().__init__(f"{source}: not found")
        self.source = source


class CircuitBreaker:
    """Предохранитель по источникам. После `threshold` сбоев подряд (5xx, таймаут, обрыв связи) источник
    «отдыхает» `cooldown_s` секунд: запросы к нему не уходят, шаг конвейера сразу откладывается. Затем
    пропускается один пробный запрос: ответ закрывает предохранитель, сбой открывает его снова. Любой ответ
    без 5xx, в том числе 404 «нет данных», значит, что источник жив."""

    def __init__(self, threshold: int, cooldown_s: float, clock: Callable[[], float] = time.monotonic):
        self.threshold = max(1, threshold)
        self.cooldown_s = cooldown_s
        self._clock = clock
        self._lock = threading.Lock()
        self._failures: dict[str, int] = {}
        self._opened_at: dict[str, float] = {}
        self._probing: set[str] = set()

    @classmethod
    def from_settings(cls, settings: Settings) -> "CircuitBreaker | None":
        if settings.breaker_threshold <= 0:
            return None
        # Порог всегда выше числа попыток одного шага: короткий сбой, который шаг переживает повтором
        # (README, «Сбой источника»: БКИ трижды отвечает ошибкой), предохранитель не открывает.
        threshold = max(settings.breaker_threshold, settings.integration_retries + 1)
        return cls(threshold, settings.breaker_cooldown_s)

    def allow(self, source: str) -> bool:
        with self._lock:
            opened = self._opened_at.get(source)
            if opened is None:
                return True
            if self._clock() - opened < self.cooldown_s:
                return False
            # Пауза прошла: один пробный запрос, остальные ждут его итога. Если итога не будет (запрос
            # оборвался исключением), через ещё одну паузу пройдёт новая проба.
            self._opened_at[source] = self._clock()
            self._probing.add(source)
            return True

    def is_open(self, source: str) -> bool:
        with self._lock:
            return source in self._opened_at

    def state(self, source: str) -> str:
        """closed — запросы идут; open — пауза; half_open — идёт пробный запрос."""
        with self._lock:
            if source not in self._opened_at:
                return "closed"
            return "half_open" if source in self._probing else "open"

    def record_success(self, source: str) -> None:
        with self._lock:
            self._failures.pop(source, None)
            self._probing.discard(source)
            if self._opened_at.pop(source, None) is not None:
                log.info("circuit closed", extra={"source": source})

    def record_failure(self, source: str) -> None:
        with self._lock:
            if source in self._opened_at:
                if source in self._probing:
                    self._probing.discard(source)
                    self._opened_at[source] = self._clock()
                    log.warning("circuit opened", extra={"source": source, "probe": "failed"})
                return
            failures = self._failures.get(source, 0) + 1
            self._failures[source] = failures
            if failures >= self.threshold:
                self._opened_at[source] = self._clock()
                log.warning(
                    "circuit opened", extra={"source": source, "failures": failures, "cooldown_s": self.cooldown_s}
                )


class ExternalSources:
    def __init__(
        self,
        client: httpx.Client,
        *,
        timeout: float,
        retries: int,
        backoff: float = 0.2,
        breaker: CircuitBreaker | None = None,
    ):
        self._client = client
        self._timeout = timeout
        self._retries = max(1, retries)
        self._backoff = backoff
        self._breaker = breaker

    @staticmethod
    def _headers(extra: dict[str, str] | None) -> dict[str, str]:
        headers = dict(extra or {})
        request_id = request_id_var.get()
        if request_id != "-":  # «-» — значение по умолчанию: запрос идёт не из контекста с ID
            headers["X-Request-ID"] = request_id
        return headers

    def _request(
        self, source: str, method: str, path: str, json: dict | None = None, headers: dict[str, str] | None = None
    ) -> dict:
        breaker = self._breaker
        last_error = "unknown error"
        for attempt in range(1, self._retries + 1):
            if breaker is not None and not breaker.allow(source):
                raise SourceUnavailable(source, CIRCUIT_OPEN)
            try:
                response = self._client.request(
                    method, path, json=json, headers=self._headers(headers), timeout=self._timeout
                )
            except httpx.TimeoutException:
                last_error = "timeout"
            except httpx.TransportError as exc:
                last_error = f"transport error: {exc.__class__.__name__}"
            else:
                if response.status_code < 500:
                    if breaker is not None:
                        breaker.record_success(source)
                    if response.status_code == 404:
                        raise NotInSource(source)
                    response.raise_for_status()
                    return response.json()
                last_error = f"HTTP {response.status_code}"
            if breaker is not None:
                breaker.record_failure(source)
            # В пути запроса ИНН клиента — в лог идут только источник, попытка и ошибка.
            log.warning("integration attempt failed", extra={"source": source, "attempt": attempt, "error": last_error})
            if breaker is not None and breaker.is_open(source):
                raise SourceUnavailable(source, CIRCUIT_OPEN)
            if attempt < self._retries:
                time.sleep(self._backoff * 2 ** (attempt - 1))
        raise SourceUnavailable(source, last_error)

    def egrul(self, inn: str) -> dict:
        return self._request("egrul", "GET", f"/egrul/{inn}")

    def bki(self, inn: str) -> dict:
        return self._request("bki", "GET", f"/bki/{inn}")

    def fns(self, inn: str) -> dict:
        return self._request("fns", "GET", f"/fns/{inn}")

    def disburse(self, *, contract_number: str, inn: str, amount: int) -> dict:
        """Перевод суммы кредита на счёт клиента. Номер договора — ключ идемпотентности (Idempotency-Key):
        повтор запроса после сбоя связи не приведёт к двойной выдаче."""
        return self._request(
            "abs",
            "POST",
            "/abs/disbursements",
            json={"contract_number": contract_number, "inn": inn, "amount": amount},
            # Заголовки HTTP — только ASCII, а в номере договора кириллица («КД-…»).
            headers={"Idempotency-Key": quote(contract_number, safe="")},
        )


@lru_cache
def get_breaker() -> CircuitBreaker | None:
    """Один предохранитель на процесс: его видят и запросы к источникам, и /health/deps."""
    return CircuitBreaker.from_settings(get_settings())


@lru_cache
def get_sources() -> ExternalSources:
    settings = get_settings()
    client = httpx.Client(base_url=settings.mocks_url)
    return ExternalSources(
        client, timeout=settings.integration_timeout_s, retries=settings.integration_retries, breaker=get_breaker()
    )
