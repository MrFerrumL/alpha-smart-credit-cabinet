"""Клиент OpenAI-совместимого chat API (Ollama, vLLM, llama.cpp, облачные провайдеры) для пояснения решения.

Только то, что понимают все такие серверы: один запрос `POST {base_url}/chat/completions` без потоковой выдачи
и без специальных полей. Повторов нет: пояснение необязательно, лучше быстро сдаться, чем держать очередь.
В лог попадает только исход (код ошибки) и время вызова — ни текст запроса, ни ответ, ни ключ.
"""

import json
import logging
import time
from dataclasses import dataclass
from functools import lru_cache

import httpx

from app.config import get_settings

log = logging.getLogger("app.llm")

LLM_TIMEOUT_S = 60.0  # общий срок одного вызова
CONNECT_TIMEOUT_S = 3.0  # недоступный сервер выясняется быстро, а не за весь срок


class LLMError(Exception):
    """Сбой вызова модели. code: timeout | connect | http_<код> | model_missing | bad_response."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Completion:
    text: str
    finish_reason: str | None
    latency_ms: int


class ChatClient:
    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: str = "",
        *,
        timeout_s: float = LLM_TIMEOUT_S,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._url = f"{base_url.strip().rstrip('/')}/chat/completions"
        self._model = model
        self._timeout_s = timeout_s
        api_key = api_key.strip()
        self._headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        # Таймаут httpx — на каждую операцию отдельно; общий срок вызова держит _post по часам.
        self._client = httpx.Client(timeout=httpx.Timeout(timeout_s, connect=CONNECT_TIMEOUT_S), transport=transport)

    def complete(self, system: str, user: str, *, max_tokens: int, temperature: float) -> Completion:
        body = {
            "model": self._model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
        started = time.monotonic()
        try:
            text, finish_reason = _parse(self._post(body, deadline=started + self._timeout_s))
        except LLMError as exc:
            log.warning("llm call failed", extra={"outcome": exc.code, "duration_ms": _elapsed_ms(started)})
            raise
        latency_ms = _elapsed_ms(started)
        log.info("llm call", extra={"outcome": "ok", "duration_ms": latency_ms})
        return Completion(text=text, finish_reason=finish_reason, latency_ms=latency_ms)

    def close(self) -> None:
        self._client.close()

    def _post(self, body: dict, *, deadline: float) -> bytes:
        """Тело ответа целиком. Читаем кусками и после каждого сверяемся с часами: сервер, который отдаёт
        ответ по байту, не продлит вызов сверх срока (таймаут httpx на такое не реагирует)."""
        try:
            with self._client.stream("POST", self._url, json=body, headers=self._headers) as response:
                if not response.is_success:
                    raise LLMError("model_missing" if response.status_code == 404 else f"http_{response.status_code}")
                chunks: list[bytes] = []
                for chunk in response.iter_bytes():
                    chunks.append(chunk)
                    if time.monotonic() > deadline:
                        raise LLMError("timeout")
        except httpx.TimeoutException as exc:
            raise LLMError("timeout") from exc
        except (httpx.TransportError, httpx.InvalidURL) as exc:
            raise LLMError("connect") from exc
        except httpx.HTTPError as exc:  # например, не распаковался сжатый ответ
            raise LLMError("bad_response") from exc
        return b"".join(chunks)


def _parse(raw: bytes) -> tuple[str, str | None]:
    """Текст и причина остановки из ответа в формате OpenAI; всё остальное — bad_response."""
    try:
        choice = json.loads(raw)["choices"][0]
        text = choice["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise LLMError("bad_response") from exc
    if not isinstance(text, str):
        raise LLMError("bad_response")
    finish_reason = choice.get("finish_reason")
    return text, finish_reason if isinstance(finish_reason, str) else None


def _elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


@lru_cache
def get_llm_client() -> ChatClient:
    settings = get_settings()
    return ChatClient(settings.llm_base_url, settings.llm_model, settings.llm_api_key.get_secret_value())
