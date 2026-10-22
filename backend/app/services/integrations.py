"""Клиент внешних систем: ЕГРЮЛ/ЕГРИП, бюро кредитных историй, ФНС «Прозрачный бизнес», АБС банка.

В прототипе все внешние системы эмулирует сервис mocks. Клиент делает то же, что делал бы с
настоящими интеграциями: ограничивает время ответа, повторяет запрос при сбоях с растущей
паузой и отличает «данных нет» от «источник недоступен».
"""

import logging
import time
from functools import lru_cache

import httpx

from app.config import get_settings

log = logging.getLogger("app.integrations")


class SourceUnavailable(Exception):
    def __init__(self, source: str, reason: str):
        super().__init__(f"{source}: {reason}")
        self.source = source
        self.reason = reason


class NotInSource(Exception):
    def __init__(self, source: str):
        super().__init__(f"{source}: not found")
        self.source = source


class ExternalSources:
    def __init__(self, client: httpx.Client, *, timeout: float, retries: int, backoff: float = 0.2):
        self._client = client
        self._timeout = timeout
        self._retries = max(1, retries)
        self._backoff = backoff

    def _request(self, source: str, method: str, path: str, json: dict | None = None) -> dict:
        last_error = "unknown error"
        for attempt in range(1, self._retries + 1):
            try:
                response = self._client.request(method, path, json=json, timeout=self._timeout)
                if response.status_code == 404:
                    raise NotInSource(source)
                if response.status_code >= 500:
                    last_error = f"HTTP {response.status_code}"
                else:
                    response.raise_for_status()
                    return response.json()
            except httpx.TimeoutException:
                last_error = "timeout"
            except httpx.TransportError as exc:
                last_error = f"transport error: {exc.__class__.__name__}"
            log.warning("integration attempt failed", extra={"path": path, "status": last_error})
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
        """Перевод суммы кредита на счёт клиента. Номер договора — ключ идемпотентности:
        повтор запроса после сбоя связи не приведёт к двойной выдаче."""
        return self._request(
            "abs",
            "POST",
            "/abs/disbursements",
            json={"contract_number": contract_number, "inn": inn, "amount": amount},
        )


@lru_cache
def get_sources() -> ExternalSources:
    settings = get_settings()
    client = httpx.Client(base_url=settings.mocks_url)
    return ExternalSources(client, timeout=settings.integration_timeout_s, retries=settings.integration_retries)
