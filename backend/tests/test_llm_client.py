"""Клиент OpenAI-совместимого API и настройки пояснения: без сети, на httpx.MockTransport."""

import json
import logging
import time

import httpx
import pytest

from app.config import Settings
from app.observability import JsonFormatter
from app.services import llm
from app.services.llm import ChatClient, Completion, LLMError

BASE = "http://llm.test/v1"
SECRET = "sk-very-secret-key"


def answer(text: str = "Готово.", finish_reason: str | None = "stop") -> httpx.Response:
    choice = {"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": finish_reason}
    return httpx.Response(200, json={"id": "x", "object": "chat.completion", "choices": [choice]})


def make_client(handler, *, base_url: str = BASE, api_key: str = "", timeout_s: float = 5.0) -> ChatClient:
    return ChatClient(base_url, "test-model", api_key, timeout_s=timeout_s, transport=httpx.MockTransport(handler))


def ask(client: ChatClient) -> Completion:
    return client.complete("система", "вопрос", max_tokens=50, temperature=0.3)


# --- запрос ---


def test_request_body_and_url():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return answer()

    ask(make_client(handler))

    (request,) = seen
    assert request.method == "POST"
    assert str(request.url) == "http://llm.test/v1/chat/completions"
    assert json.loads(request.content) == {
        "model": "test-model",
        "messages": [{"role": "system", "content": "система"}, {"role": "user", "content": "вопрос"}],
        "temperature": 0.3,
        "max_tokens": 50,
        "stream": False,
    }


@pytest.mark.parametrize("base_url", ["http://llm.test/v1", "http://llm.test/v1/", " http://llm.test/v1// "])
def test_url_has_no_double_slash(base_url):
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return answer()

    ask(make_client(handler, base_url=base_url))
    assert seen == ["http://llm.test/v1/chat/completions"]


def test_authorization_only_with_key():
    seen: list[httpx.Headers] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers)
        return answer()

    ask(make_client(handler, api_key=SECRET))
    ask(make_client(handler, api_key=""))
    ask(make_client(handler, api_key="  "))

    assert seen[0]["Authorization"] == f"Bearer {SECRET}"
    assert "Authorization" not in seen[1]
    assert "Authorization" not in seen[2]


# --- ответ ---


def test_normal_answer():
    completion = ask(make_client(lambda request: answer("Главное: сумма велика.", "stop")))
    assert completion.text == "Главное: сумма велика."
    assert completion.finish_reason == "stop"
    assert isinstance(completion.latency_ms, int) and completion.latency_ms >= 0


def test_finish_reason_length_and_missing():
    assert ask(make_client(lambda request: answer("текст", "length"))).finish_reason == "length"
    assert ask(make_client(lambda request: answer("текст", None))).finish_reason is None


def test_answer_in_several_chunks_is_joined():
    body = json.dumps(
        {"choices": [{"message": {"content": "Привет, мир"}, "finish_reason": "stop"}]}, ensure_ascii=False
    ).encode()

    class Chunked(httpx.SyncByteStream):
        def __iter__(self):
            for i in range(0, len(body), 7):  # границы кусков падают и внутрь многобайтных символов
                yield body[i : i + 7]

    completion = ask(make_client(lambda request: httpx.Response(200, stream=Chunked())))
    assert completion.text == "Привет, мир"


# --- ошибки ---


@pytest.mark.parametrize(
    ("status", "code"),
    [(503, "http_503"), (500, "http_500"), (401, "http_401"), (429, "http_429"), (404, "model_missing")],
)
def test_http_errors(status, code):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(status, json={"error": {"message": "нет"}})

    with pytest.raises(LLMError) as info:
        ask(make_client(handler))
    assert info.value.code == code
    assert len(calls) == 1  # повторов нет


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, content=b"not json"),
        httpx.Response(200, content=b""),
        httpx.Response(200, content=b"\xff\xfe\x00"),
        httpx.Response(200, json=[]),
        httpx.Response(200, json={}),
        httpx.Response(200, json={"choices": []}),
        httpx.Response(200, json={"choices": "x"}),
        httpx.Response(200, json={"choices": [{}]}),
        httpx.Response(200, json={"choices": [{"message": {}}]}),
        httpx.Response(200, json={"choices": [{"message": {"content": None}}]}),
        httpx.Response(200, json={"choices": [{"message": {"content": ["часть"]}}]}),
    ],
    ids=lambda response: response.content[:20].decode("latin-1"),
)
def test_bad_response(response):
    with pytest.raises(LLMError) as info:
        ask(make_client(lambda request: response))
    assert info.value.code == "bad_response"


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (httpx.ConnectError("refused"), "connect"),
        (httpx.ReadError("reset"), "connect"),
        (httpx.RemoteProtocolError("closed"), "connect"),
        (httpx.ReadTimeout("slow"), "timeout"),
        (httpx.ConnectTimeout("slow"), "timeout"),
    ],
    ids=lambda value: type(value).__name__ if isinstance(value, Exception) else value,
)
def test_transport_errors(error, code):
    def handler(request: httpx.Request) -> httpx.Response:
        raise error

    with pytest.raises(LLMError) as info:
        ask(make_client(handler))
    assert info.value.code == code


class Trickle(httpx.SyncByteStream):
    """Ответ, который идёт по байту с паузами: каждый кусок приходит вовремя, а целиком — слишком долго."""

    def __init__(self, pause_s: float, count: int) -> None:
        self.pause_s = pause_s
        self.count = count

    def __iter__(self):
        for _ in range(self.count):
            time.sleep(self.pause_s)
            yield b" "
        yield json.dumps({"choices": [{"message": {"content": "поздно"}}]}).encode()


def test_total_deadline_cuts_a_trickling_response():
    client = make_client(lambda request: httpx.Response(200, stream=Trickle(0.05, 40)), timeout_s=0.3)

    started = time.monotonic()
    with pytest.raises(LLMError) as info:
        ask(client)
    elapsed = time.monotonic() - started

    assert info.value.code == "timeout"
    assert elapsed < 1.5  # без общего срока ответ шёл бы около 2 секунд


def test_trickling_response_within_deadline_is_accepted():
    completion = ask(make_client(lambda request: httpx.Response(200, stream=Trickle(0.01, 3)), timeout_s=5.0))
    assert completion.text == "поздно"


# --- лог ---


def test_log_has_outcome_and_time_but_no_content(caplog):
    prompt = "секретный промпт про ИНН 7700000000"
    reply = "секретный ответ модели"
    caplog.set_level(logging.DEBUG, logger="app.llm")

    make_client(lambda request: answer(reply), api_key=SECRET).complete(prompt, prompt, max_tokens=5, temperature=0)
    with pytest.raises(LLMError):
        make_client(lambda request: httpx.Response(503, text=reply), api_key=SECRET).complete(
            prompt, prompt, max_tokens=5, temperature=0
        )

    records = [r for r in caplog.records if r.name == "app.llm"]
    assert [r.outcome for r in records] == ["ok", "http_503"]
    assert all(isinstance(r.duration_ms, int) for r in records)
    logged = " ".join(JsonFormatter().format(r) for r in records)  # строки лога целиком, со всеми полями
    for secret in (prompt, reply, SECRET):
        assert secret not in caplog.text
        assert secret not in logged


# --- фабрика ---


def test_get_llm_client_is_built_once_from_settings(monkeypatch):
    built: list[tuple] = []

    class Recorder:
        def __init__(self, *args) -> None:
            built.append(args)

    settings = Settings(_env_file=None, llm_base_url="http://x.test/v1", llm_model="m", llm_api_key=SECRET)
    monkeypatch.setattr(llm, "get_settings", lambda: settings)
    monkeypatch.setattr(llm, "ChatClient", Recorder)
    llm.get_llm_client.cache_clear()
    try:
        assert llm.get_llm_client() is llm.get_llm_client()
    finally:
        llm.get_llm_client.cache_clear()
    assert built == [("http://x.test/v1", "m", SECRET)]


# --- настройки ---


@pytest.fixture
def clean_env(monkeypatch):
    for name in ("LLM_ENABLED", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"):
        monkeypatch.delenv(name, raising=False)


def test_llm_is_off_by_default(clean_env):
    settings = Settings(_env_file=None)
    assert settings.llm_enabled is False
    assert settings.llm_active is False
    assert settings.llm_api_key.get_secret_value() == ""


@pytest.mark.parametrize(
    ("enabled", "base_url", "model", "active"),
    [
        (True, "http://localhost:11434/v1", "m", True),
        (False, "http://localhost:11434/v1", "m", False),
        (True, "", "m", False),
        (True, "   ", "m", False),
        (True, "http://localhost:11434/v1", "", False),
        (True, "http://localhost:11434/v1", "  ", False),
    ],
)
def test_llm_active_needs_flag_url_and_model(clean_env, enabled, base_url, model, active):
    settings = Settings(_env_file=None, llm_enabled=enabled, llm_base_url=base_url, llm_model=model)
    assert settings.llm_active is active


def test_llm_settings_come_from_environment(clean_env, monkeypatch):
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("LLM_BASE_URL", "http://ollama:11434/v1")
    monkeypatch.setenv("LLM_MODEL", "fake-explainer")
    monkeypatch.setenv("LLM_API_KEY", SECRET)
    settings = Settings(_env_file=None)
    assert settings.llm_active is True
    assert settings.llm_base_url == "http://ollama:11434/v1"
    assert settings.llm_model == "fake-explainer"
    assert settings.llm_api_key.get_secret_value() == SECRET


def test_api_key_is_hidden_in_repr(clean_env):
    settings = Settings(_env_file=None, llm_api_key=SECRET)
    assert SECRET not in repr(settings)
    assert SECRET not in str(settings)
    assert SECRET not in settings.model_dump_json()
    assert settings.llm_api_key.get_secret_value() == SECRET
