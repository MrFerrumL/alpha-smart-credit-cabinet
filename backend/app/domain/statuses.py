"""Статусы заявки и разрешённые переходы между ними.

Это единственный источник правды о жизненном цикле заявки: API, воркер конвейера и интерфейс
опираются на эту таблицу. Любой переход, которого здесь нет, отклоняется с ошибкой 409.
"""

from dataclasses import dataclass
from enum import StrEnum


class Status(StrEnum):
    DRAFT = "draft"
    SUBMITTED = "submitted"
    VALIDATION = "validation"
    NEEDS_INFO = "needs_info"
    ENRICHMENT = "enrichment"
    SCORING = "scoring"
    MANUAL_REVIEW = "manual_review"
    APPROVED = "approved"
    COUNTER_OFFER = "counter_offer"
    REJECTED = "rejected"
    SIGNING = "signing"
    ISSUED = "issued"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


class Actor(StrEnum):
    CLIENT = "client"
    ANALYST = "analyst"
    SYSTEM = "system"


# Этапы, которые клиент видит на таймлайне заявки.
STAGES: tuple[str, ...] = (
    "Заявка",
    "Проверка данных",
    "Проверка компании",
    "Оценка",
    "Решение",
    "Подписание",
    "Выдача",
)


@dataclass(frozen=True)
class StatusInfo:
    title: str  # как статус называется для клиента
    hint: str  # что происходит и что делать, простыми словами
    stage: int  # индекс этапа в STAGES
    tone: str  # neutral | info | warning | success | danger
    action_required: bool = False
    terminal: bool = False


S = Status

STATUS_INFO: dict[Status, StatusInfo] = {
    S.DRAFT: StatusInfo(
        "Черновик",
        "Заявка сохранена, но ещё не отправлена. Можно вернуться и дозаполнить её в любой момент.",
        0, "neutral", action_required=True,
    ),
    S.SUBMITTED: StatusInfo(
        "Заявка отправлена",
        "Мы получили заявку и уже начинаем проверку. От вас ничего не нужно.",
        1, "info",
    ),
    S.VALIDATION: StatusInfo(
        "Проверяем данные",
        "Смотрим, всё ли заполнено и нет ли ошибок в анкете. От вас ничего не нужно.",
        1, "info",
    ),
    S.NEEDS_INFO: StatusInfo(
        "Нужна информация",
        "Нам не хватает данных. Откройте задачи по заявке — после ответа проверка продолжится сама.",
        1, "warning", action_required=True,
    ),
    S.ENRICHMENT: StatusInfo(
        "Проверяем компанию",
        "Сверяем данные с ЕГРЮЛ, налоговой и бюро кредитных историй. Обычно это пара минут.",
        2, "info",
    ),
    S.SCORING: StatusInfo(
        "Оцениваем заявку",
        "Рассчитываем, какие условия можем предложить. От вас ничего не нужно.",
        3, "info",
    ),
    S.MANUAL_REVIEW: StatusInfo(
        "Рассматривает специалист",
        "Заявку изучает кредитный специалист банка. Обычно это занимает 1–2 рабочих дня.",
        3, "info",
    ),
    S.APPROVED: StatusInfo(
        "Одобрено",
        "Банк готов выдать кредит. Посмотрите условия и примите предложение.",
        4, "success", action_required=True,
    ),
    S.COUNTER_OFFER: StatusInfo(
        "Есть предложение",
        "Банк готов выдать кредит на других условиях. Сравните их с запрошенными и решите, подходят ли они.",
        4, "warning", action_required=True,
    ),
    S.REJECTED: StatusInfo(
        "Отказ",
        "Сейчас банк не может выдать кредит на этих условиях. Посмотрите, что можно сделать, и попробуйте другой вариант.",
        4, "danger", terminal=True,
    ),
    S.SIGNING: StatusInfo(
        "Подписание договора",
        "Ознакомьтесь с договором и подпишите его кодом прямо в кабинете.",
        5, "warning", action_required=True,
    ),
    S.ISSUED: StatusInfo(
        "Деньги зачислены",
        "Кредит выдан, деньги уже на расчётном счёте компании.",
        6, "success", terminal=True,
    ),
    S.CANCELLED: StatusInfo(
        "Заявка отозвана",
        "Заявка закрыта по вашему решению. Новую можно подать в любой момент.",
        0, "neutral", terminal=True,
    ),
    S.EXPIRED: StatusInfo(
        "Срок предложения истёк",
        "Предложение больше не действует. Подайте новую заявку — данные компании подставятся автоматически.",
        4, "neutral", terminal=True,
    ),
}

_C, _A, _SYS = Actor.CLIENT, Actor.ANALYST, Actor.SYSTEM

_EXPLICIT: dict[tuple[Status, Status], frozenset[Actor]] = {
    (S.DRAFT, S.SUBMITTED): frozenset({_C}),
    (S.SUBMITTED, S.VALIDATION): frozenset({_SYS}),
    (S.VALIDATION, S.NEEDS_INFO): frozenset({_SYS}),
    (S.VALIDATION, S.ENRICHMENT): frozenset({_SYS}),
    # Клиент ответил на все задачи — заявка возвращается на проверку.
    (S.NEEDS_INFO, S.VALIDATION): frozenset({_C, _SYS}),
    (S.NEEDS_INFO, S.EXPIRED): frozenset({_SYS}),
    (S.ENRICHMENT, S.SCORING): frozenset({_SYS}),
    (S.SCORING, S.APPROVED): frozenset({_SYS}),
    (S.SCORING, S.COUNTER_OFFER): frozenset({_SYS}),
    (S.SCORING, S.MANUAL_REVIEW): frozenset({_SYS}),
    (S.SCORING, S.REJECTED): frozenset({_SYS}),
    (S.SCORING, S.NEEDS_INFO): frozenset({_SYS}),
    (S.MANUAL_REVIEW, S.APPROVED): frozenset({_A}),
    (S.MANUAL_REVIEW, S.COUNTER_OFFER): frozenset({_A}),
    (S.MANUAL_REVIEW, S.REJECTED): frozenset({_A}),
    (S.MANUAL_REVIEW, S.NEEDS_INFO): frozenset({_A}),
    (S.APPROVED, S.SIGNING): frozenset({_C}),
    (S.APPROVED, S.EXPIRED): frozenset({_SYS}),
    (S.COUNTER_OFFER, S.SIGNING): frozenset({_C}),
    (S.COUNTER_OFFER, S.EXPIRED): frozenset({_SYS}),
    (S.SIGNING, S.ISSUED): frozenset({_SYS}),
}


def _build_transitions() -> dict[tuple[Status, Status], frozenset[Actor]]:
    transitions = dict(_EXPLICIT)
    # Клиент может отозвать заявку на любом этапе, пока она не завершена.
    for status, info in STATUS_INFO.items():
        if not info.terminal:
            transitions[(status, S.CANCELLED)] = transitions.get((status, S.CANCELLED), frozenset()) | {_C}
    return transitions


TRANSITIONS = _build_transitions()


def can_transition(src: Status, dst: Status, actor: Actor) -> bool:
    return actor in TRANSITIONS.get((src, dst), frozenset())


def targets(src: Status, actor: Actor | None = None) -> list[Status]:
    return [
        dst for (s, dst), actors in TRANSITIONS.items() if s == src and (actor is None or actor in actors)
    ]


def to_mermaid() -> str:
    """Диаграмма состояний в формате Mermaid — из неё собран docs/state-machine.md."""
    lines = ["stateDiagram-v2", "    [*] --> draft"]
    for (src, dst), actors in TRANSITIONS.items():
        label = ", ".join(sorted(a.value for a in actors))
        lines.append(f"    {src.value} --> {dst.value}: {label}")
    for status, info in STATUS_INFO.items():
        if info.terminal:
            lines.append(f"    {status.value} --> [*]")
    return "\n".join(lines)


if __name__ == "__main__":
    print(to_mermaid())
