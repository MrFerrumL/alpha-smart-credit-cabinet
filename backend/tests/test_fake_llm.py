"""Фейковая языковая модель эмулятора: нормальные ответы, прогрев и сбои через /admin/faults."""

import pytest
from fastapi.testclient import TestClient

from mockapi.data import COMPANIES
from mockapi.main import app as mock_app

URL = "/llm/v1/chat/completions"

NEXT_STEP = "Подпишите договор в кабинете до конца недели."
APPROVED = "Банк одобрил заявку на запрошенных условиях."
COUNTER = "Банк одобрил кредит на других условиях."
COUNTER_INSTEAD = "Вместо «Экспресс» банк предлагает «Оборотный»."
REJECTED = "Банк отказал в кредите."


@pytest.fixture
def fake():
    client = TestClient(mock_app)
    client.post("/admin/faults", json={"source": "all", "mode": "none"})
    yield client
    client.post("/admin/faults", json={"source": "all", "mode": "none"})


def data_block(decision: str, reasons: list[str], hints: list[str] | None = None, next_step: str = NEXT_STEP) -> str:
    hint_lines = [f"- {h}" for h in hints] if hints else ["- —"]
    lines = ["<данные>", f"Решение банка: {decision}", "Причины:", *[f"- {r}" for r in reasons]]
    lines += ["Что можно сделать:", *hint_lines, f"Следующий шаг: {next_step}", "</данные>"]
    return "\n".join(lines) + "\nНапиши продолжение пояснения по правилам."


def ask(client: TestClient, user: str, **extra):
    body = {
        "model": "fake-explainer",
        "messages": [{"role": "system", "content": "Ты объясняешь решение банка."}, {"role": "user", "content": user}],
        **extra,
    }
    return client.post(URL, json=body)


def content(response) -> str:
    assert response.status_code == 200, response.text
    return response.json()["choices"][0]["message"]["content"]


def set_fault(client: TestClient, source: str, mode: str, count: int | None = None):
    return client.post("/admin/faults", json={"source": source, "mode": mode, "count": count})


REASONS = ["Выручка за год подтверждается налоговой отчётностью.", "Просрочек по кредитам нет."]


def test_response_has_openai_chat_completion_shape(fake):
    response = ask(fake, data_block(APPROVED, REASONS))
    assert response.status_code == 200
    body = response.json()
    assert body["id"].startswith("chatcmpl-fake-") and len(body["id"]) > len("chatcmpl-fake-")
    assert body["object"] == "chat.completion"
    assert isinstance(body["created"], int)
    assert body["model"] == "fake-explainer"
    assert len(body["choices"]) == 1
    choice = body["choices"][0]
    assert choice["index"] == 0
    assert choice["message"]["role"] == "assistant"
    assert choice["finish_reason"] == "stop"
    usage = body["usage"]
    assert usage["total_tokens"] == usage["prompt_tokens"] + usage["completion_tokens"]
    assert usage["completion_tokens"] == len(choice["message"]["content"]) // 4


def test_model_is_echoed_and_extra_parameters_are_ignored(fake):
    response = fake.post(
        URL,
        json={
            "model": "any-model:7b",
            "messages": [{"role": "user", "content": "привет"}],
            "temperature": 0.3,
            "max_tokens": 200,
            "stream": False,
            "top_p": 0.9,
        },
        headers={"Authorization": "Bearer ci-dummy"},
    )
    assert response.status_code == 200
    assert response.json()["model"] == "any-model:7b"


def test_request_needs_model_and_messages(fake):
    assert fake.post(URL, json={"messages": [{"role": "user", "content": "x"}]}).status_code == 422
    assert fake.post(URL, json={"model": "m"}).status_code == 422


@pytest.mark.parametrize("decision", [APPROVED, COUNTER, COUNTER_INSTEAD, REJECTED])
def test_normal_answer_leads_with_the_shortest_reason_then_the_next_step(fake, decision):
    text = content(ask(fake, data_block(decision, REASONS)))
    assert text == f"Главное: просрочек по кредитам нет. {NEXT_STEP}"


def test_normal_answer_uses_the_shortest_of_several_reasons_and_ignores_hints(fake):
    long_one = "Действующие платежи по кредитам занимают слишком большую долю выручки."
    reasons = [long_one, "Прибыль мала.", "Выручка растёт."]
    text = content(ask(fake, data_block(REJECTED, reasons, hints=["Подайте заявку на меньшую сумму."])))
    assert text == f"Главное: прибыль мала. {NEXT_STEP}"


def test_reason_ends_with_a_single_period_whether_or_not_it_had_one(fake):
    without = content(ask(fake, data_block(APPROVED, ["Просрочек по кредитам нет"])))
    with_dot = content(ask(fake, data_block(APPROVED, ["Просрочек по кредитам нет."])))
    assert without == with_dot == f"Главное: просрочек по кредитам нет. {NEXT_STEP}"


def test_last_user_message_is_the_one_that_is_parsed(fake):
    body = {
        "model": "fake-explainer",
        "messages": [
            {"role": "user", "content": data_block(APPROVED, ["Старая причина."])},
            {"role": "assistant", "content": "Готово."},
            {"role": "user", "content": data_block(APPROVED, ["Новая причина."])},
        ],
    }
    assert content(fake.post(URL, json=body)) == f"Главное: новая причина. {NEXT_STEP}"


def test_warm_up_request_without_a_data_block_gets_a_short_answer(fake):
    assert content(ask(fake, "Ответь одним словом.")) == "Готово."


def test_error_fault_gives_503(fake):
    assert set_fault(fake, "llm", "error").status_code == 200
    assert ask(fake, data_block(APPROVED, REASONS)).status_code == 503
    assert ask(fake, data_block(APPROVED, REASONS)).status_code == 503


def test_timeout_fault_gives_503_after_the_sleep(fake, monkeypatch):
    monkeypatch.setenv("MOCK_TIMEOUT_SLEEP_S", "0")
    set_fault(fake, "llm", "timeout")
    assert ask(fake, data_block(APPROVED, REASONS)).status_code == 503


@pytest.mark.parametrize(
    ("decision", "expected"),
    [
        (APPROVED, "К сожалению, банк отказал в кредите. Подайте заявку позже."),
        (COUNTER, "Кредит одобрен на запрошенных условиях. Подпишите договор в кабинете."),
        (COUNTER_INSTEAD, "Кредит одобрен на запрошенных условиях. Подпишите договор в кабинете."),
        (REJECTED, "Поздравляем, банк одобрил заявку. Подпишите договор в кабинете."),
    ],
)
def test_contradict_fault_says_the_opposite_of_the_decision(fake, decision, expected):
    assert set_fault(fake, "llm", "contradict").status_code == 200
    assert content(ask(fake, data_block(decision, REASONS))) == expected


def test_wrong_numbers_fault_adds_a_number_that_is_not_in_the_data(fake):
    set_fault(fake, "llm", "wrong_numbers")
    text = content(ask(fake, data_block(APPROVED, REASONS)))
    assert text == f"Главное: сумма 9 999 999 ₽ подобрана под вашу выручку. {NEXT_STEP}"


def test_content_faults_leave_the_warm_up_answer_alone(fake):
    set_fault(fake, "llm", "contradict")
    assert content(ask(fake, "Ответь одним словом.")) == "Готово."


def test_fault_with_a_count_is_consumed_after_that_many_requests(fake):
    set_fault(fake, "llm", "error", count=1)
    assert ask(fake, data_block(APPROVED, REASONS)).status_code == 503
    assert fake.get("/admin/faults").json() == {}
    assert content(ask(fake, data_block(APPROVED, REASONS))) == f"Главное: просрочек по кредитам нет. {NEXT_STEP}"


def test_content_fault_with_a_count_is_consumed_too(fake):
    set_fault(fake, "llm", "contradict", count=2)
    bad = "К сожалению, банк отказал в кредите. Подайте заявку позже."
    assert content(ask(fake, data_block(APPROVED, REASONS))) == bad
    assert content(ask(fake, data_block(APPROVED, REASONS))) == bad
    assert content(ask(fake, data_block(APPROVED, REASONS))).startswith("Главное: ")
    assert fake.get("/admin/faults").json() == {}


def test_fault_on_all_does_not_touch_the_model(fake):
    set_fault(fake, "all", "error")
    inn = next(iter(COMPANIES))
    assert fake.get(f"/egrul/{inn}").status_code == 503
    assert content(ask(fake, data_block(APPROVED, REASONS))).startswith("Главное: ")


def test_fault_on_the_model_does_not_touch_other_sources(fake):
    set_fault(fake, "llm", "error")
    inn = next(iter(COMPANIES))
    assert fake.get(f"/egrul/{inn}").status_code == 200
    assert fake.get("/health").status_code == 200


@pytest.mark.parametrize("source", ["egrul", "bki", "fns", "abs", "all"])
@pytest.mark.parametrize("mode", ["contradict", "wrong_numbers"])
def test_text_faults_exist_only_for_the_model(fake, source, mode):
    assert set_fault(fake, source, mode).status_code == 422
    assert fake.get("/admin/faults").json() == {}


def test_error_and_timeout_faults_are_valid_for_the_model(fake):
    assert set_fault(fake, "llm", "error").status_code == 200
    assert set_fault(fake, "llm", "timeout").status_code == 200


def test_none_clears_the_model_fault_for_its_source_and_for_all(fake):
    set_fault(fake, "llm", "error")
    assert fake.get("/admin/faults").json() == {"llm": {"mode": "error", "count": None}}
    assert set_fault(fake, "llm", "none").json() == {}
    assert ask(fake, data_block(APPROVED, REASONS)).status_code == 200

    set_fault(fake, "llm", "contradict")
    set_fault(fake, "bki", "error")
    assert set_fault(fake, "all", "none").json() == {}
    assert content(ask(fake, data_block(APPROVED, REASONS))).startswith("Главное: ")
