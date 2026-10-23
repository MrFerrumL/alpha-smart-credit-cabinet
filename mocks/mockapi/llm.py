"""Фейковая языковая модель: OpenAI-совместимый /llm/v1/chat/completions для тестов и CI вместо настоящей модели.

Это не модель, а шаблон: ответ детерминирован и собирается из блока «<данные>» последнего сообщения пользователя.
Сбои включаются через /admin/faults с источником «llm»: error и timeout (503), contradict и wrong_numbers
(ответ 200, но с плохим текстом — чтобы проверить, что backend такой текст не покажет).
"""

import time
import uuid
from dataclasses import dataclass, field

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/llm/v1", tags=["Языковая модель"])


class Message(BaseModel):
    role: str
    content: str


class ChatIn(BaseModel):
    """Нужны только модель и сообщения: temperature, max_tokens, stream и прочее принимается и игнорируется."""

    model: str
    messages: list[Message]


@dataclass
class Data:
    decision: str = ""
    reasons: list[str] = field(default_factory=list)
    next_step: str = ""


# Ответы, противоречащие решению, — по исходу решения.
_CONTRADICTION = {
    "approved": "К сожалению, банк отказал в кредите. Подайте заявку позже.",
    "counter": "Кредит одобрен на запрошенных условиях. Подпишите договор в кабинете.",
    "rejected": "Поздравляем, банк одобрил заявку. Подпишите договор в кабинете.",
}


def _parse(text: str) -> Data | None:
    """Разбирает блок «<данные>…</данные>»; блока нет — None (запрос прогрева)."""
    start, end = text.find("<данные>"), text.find("</данные>")
    if start < 0 or end < start:
        return None
    data = Data()
    section = ""  # раздел, к которому относятся строки «- …»
    for line in text[start + len("<данные>") : end].splitlines():
        line = line.strip()
        if line.startswith("Решение банка:"):
            data.decision, section = line.removeprefix("Решение банка:").strip(), ""
        elif line == "Причины:":
            section = "reasons"
        elif line == "Что можно сделать:":
            section = "hints"
        elif line.startswith("Следующий шаг:"):
            data.next_step, section = line.removeprefix("Следующий шаг:").strip(), ""
        elif line.startswith("- ") and section == "reasons" and line[2:].strip() != "—":
            data.reasons.append(line[2:].strip())
    return data


def _outcome(decision: str) -> str:
    """Исход по первому предложению решения: approved | counter | rejected."""
    low = decision.lower()
    if "отказал" in low:
        return "rejected"
    if "на других условиях" in low or low.startswith("вместо"):
        return "counter"
    return "approved"


def answer(user_text: str, fault: str | None = None) -> str:
    """Текст ответа. fault — содержательный сбой (contradict | wrong_numbers) или None."""
    data = _parse(user_text)
    if data is None:
        return "Готово."
    if fault == "contradict":
        return _CONTRADICTION[_outcome(data.decision)]
    if fault == "wrong_numbers":
        return f"Главное: сумма 9 999 999 ₽ подобрана под вашу выручку. {data.next_step}".rstrip()
    reason = min(data.reasons, key=len, default=data.decision).rstrip().rstrip(".")
    return f"Главное: {reason[:1].lower()}{reason[1:]}. {data.next_step}".rstrip()


@router.post("/chat/completions", summary="Ответ фейковой языковой модели (формат OpenAI)")
def chat_completions(data: ChatIn) -> dict:
    # Импорт здесь: main.py подключает этот роутер, а общий механизм сбоев живёт в main.py.
    from mockapi.main import _maybe_fail

    fault = _maybe_fail("llm")
    user = next((m.content for m in reversed(data.messages) if m.role == "user"), "")
    text = answer(user, fault)
    prompt_tokens = sum(len(m.content) for m in data.messages) // 4
    completion_tokens = len(text) // 4
    return {
        "id": f"chatcmpl-fake-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": data.model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }
