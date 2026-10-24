"""Правила пояснения решения: первое предложение пишет код, часть модели проверяет детерминированная проверка.

Чистые модульные тесты без базы и сети: данные решения (Facts) строятся прямо в тесте, а «модель» — это фейковый
провайдер из эмулятора (mockapi.llm.answer) и тексты, написанные вручную.
"""

import re
from dataclasses import replace

import pytest

from app.explanation.facts import Facts, OfferFacts, eligible, lead, next_step, rub
from app.explanation.prompt import user_message
from app.explanation.validate import Invalid, check, compose
from mockapi.llm import answer

NB = "\u00a0"

# Одобрение: условия те, что запрошены.
APPROVED = Facts(
    "approved", "Экспресс-оборот", 3_000_000, 12,
    OfferFacts("Экспресс-оборот", 3_000_000, 12, "22,9", 282_345, False, False),
    ("Компания давно на рынке — 7 лет", "Кредиты обслуживаются без просрочек", "Бизнес стабильно прибыльный"), (),
)
# Контрпредложение на том же продукте: меньше сумма, дольше срок.
COUNTER_SAME = Facts(
    "counter_offer", "Экспресс-оборот", 5_000_000, 12,
    OfferFacts("Экспресс-оборот", 1_800_000, 18, "24,9", 120_000, False, False),
    ("Сумма ограничена выручкой: при 1,2 млн ₽ в месяц по этому продукту доступно до 1,8 млн ₽",
     "Срок увеличен до 18 мес., чтобы ежемесячный платёж был посильным", "Ставка 24,9% учитывает оценку заявки"), (),
)
# Контрпредложение на другом продукте: овердрафт, платёж — это проценты.
COUNTER_OTHER = Facts(
    "counter_offer", "Экспресс-оборот", 300_000, 12,
    OfferFacts("Овердрафт", 150_000, 12, "26,9", 3_363, True, False),
    ("По продукту «Экспресс-оборот» условия не проходят даже на минимальную сумму — под ваши показатели подходит "
     "«Овердрафт»: 150 000 ₽ на 12 мес.", "Ставка 26,9% учитывает оценку заявки"), (),
)
# Отказ с подсказками и без них.
REJECTED = Facts(
    "rejected", "Экспресс-оборот", 2_000_000, 12, None,
    ("Были просрочки по кредитам больше двух месяцев", "По данным налоговой бизнес работает в убыток",
     "Есть задолженность по налогам"),
    ("Обслуживайте кредиты без просрочек — через 6–12 месяцев оценка улучшится",
     "Когда бизнес выйдет в плюс, шансы на одобрение вырастут", "Погасите долг перед налоговой"),
)
REJECTED_NO_TIPS = replace(REJECTED, tips=())
# Кредит с залогом: другой текст следующего шага.
COLLATERAL = Facts(
    "approved", "Инвестиционный кредит", 10_000_000, 24,
    OfferFacts("Инвестиционный кредит", 10_000_000, 24, "19,9", 509_000, False, True),
    ("Проект подтверждён документами",), (),
)

# Общие концовки и куски ответов «модели».
SIGN = "Подпишите договор кодом в кабинете, пока предложение действует."
SIGN_IF_SUITS = "Если всё подходит, подпишите договор кодом в кабинете."
NEW_APPLICATION = "Погасите долг перед налоговой и подайте новую заявку."
CLAUSE = ", кредиты обслуживаются без просрочек"

ROUND_TRIP = [
    pytest.param(APPROVED, id="approval"),
    pytest.param(COUNTER_SAME, id="counter-same-product"),
    pytest.param(COUNTER_OTHER, id="counter-other-product"),
    pytest.param(REJECTED, id="rejection-with-tips"),
    pytest.param(REJECTED_NO_TIPS, id="rejection-without-tips"),
]


def assert_invalid(text: str, facts: Facts, rule: str, finish_reason: str | None = "stop") -> None:
    with pytest.raises(Invalid) as e:
        check(text, finish_reason, facts)
    assert e.value.rule == rule


def sized(length: int) -> str:
    """Ответ из слов данных ровно в length знаков: одно предложение, в конце слово-заполнитель из одной буквы."""
    text = "Компания давно на рынке — 7 лет"
    while len(text) + len(CLAUSE) + 3 <= length:
        text += CLAUSE
    result = f"{text} {'а' * (length - len(text) - 2)}."
    assert len(result) == length
    return result


# --- Первое предложение и следующий шаг пишет код --------------------------------------------------


@pytest.mark.parametrize(
    ("facts", "expected"),
    [
        pytest.param(
            APPROVED,
            "Банк одобрил «Экспресс-оборот» на запрошенных условиях: 3\u00a0000\u00a0000\u00a0₽ на 12 мес. "
            "под 22,9% годовых, платёж 282\u00a0345\u00a0₽ в месяц.",
            id="approval",
        ),
        pytest.param(
            COUNTER_SAME,
            "Банк готов выдать «Экспресс-оборот» на других условиях: 1\u00a0800\u00a0000\u00a0₽ на 18 мес. "
            "под 24,9% годовых, платёж 120\u00a0000\u00a0₽ в месяц — "
            "вы запрашивали 5\u00a0000\u00a0000\u00a0₽ на 12 мес.",
            id="counter-same-product",
        ),
        pytest.param(
            COUNTER_OTHER,
            "Вместо «Экспресс-оборот» на 300\u00a0000\u00a0₽ банк предлагает «Овердрафт»: "
            "лимит 150\u00a0000\u00a0₽ на 12 мес. под 26,9% годовых, проценты 3\u00a0363\u00a0₽ в месяц.",
            id="counter-other-product-overdraft",
        ),
        pytest.param(
            REJECTED,
            "Банк отказал в кредите «Экспресс-оборот» (вы запрашивали 2\u00a0000\u00a0000\u00a0₽ на 12 мес.).",
            id="rejection",
        ),
    ],
)
def test_lead_is_written_by_code_with_exact_terms(facts, expected):
    assert lead(facts) == expected


def test_rub_uses_non_breaking_spaces():
    assert rub(3_000_000) == "3\u00a0000\u00a0000\u00a0₽"
    assert rub(150) == "150\u00a0₽"
    assert rub(1000) == "1\u00a0000\u00a0₽"


@pytest.mark.parametrize(
    "facts",
    [APPROVED, COUNTER_SAME, COUNTER_OTHER, REJECTED],
    ids=["approval", "counter", "overdraft", "rejection"],
)
def test_no_amount_in_the_lead_breaks_on_a_plain_space(facts):
    text = lead(facts)
    assert f"{NB}₽" in text
    assert not re.search(r"\d \d{3}|\d ₽", text)


TAIL = ("Если всё подходит, руководитель компании принимает предложение в кабинете и подписывает договор кодом, "
        "пока предложение действует.")


@pytest.mark.parametrize(
    ("facts", "expected"),
    [
        pytest.param(
            COUNTER_OTHER,
            f"{TAIL} После подписания банк откроет лимит овердрафта на расчётном счёте.",
            id="overdraft",
        ),
        pytest.param(
            COLLATERAL,
            f"{TAIL} После подписания и оформления залога или поручительства банк переведёт деньги на расчётный счёт.",
            id="collateral",
        ),
        pytest.param(APPROVED, f"{TAIL} После подписания банк переведёт деньги на расчётный счёт.", id="plain"),
        pytest.param(COUNTER_SAME, f"{TAIL} После подписания банк переведёт деньги на расчётный счёт.", id="counter"),
        pytest.param(
            REJECTED,
            "Выполните рекомендации из раздела «Что можно сделать» и подайте новую заявку. "
            "Другой продукт можно подобрать кнопкой «Подобрать другой вариант».",
            id="rejection-with-tips",
        ),
        pytest.param(
            REJECTED_NO_TIPS,
            "Другой продукт можно подобрать кнопкой «Подобрать другой вариант».",
            id="rejection-without-tips",
        ),
    ],
)
def test_next_step_wording(facts, expected):
    assert next_step(facts) == expected


@pytest.mark.parametrize("facts", ROUND_TRIP)
def test_compose_is_lead_then_the_model_part(facts):
    part = "Главное: есть причина. Следующий шаг понятен."
    assert compose(facts, part) == lead(facts) + " " + part


# --- Кому вообще пишется пояснение ------------------------------------------------------------------


@pytest.mark.parametrize("outcome", ["approved", "counter_offer", "rejected"])
def test_eligible_for_automatic_approval_counter_offer_and_rejection(outcome):
    assert eligible({"outcome": outcome, "reasons": [], "tips": [], "stop_factors": []}) is True


@pytest.mark.parametrize(
    "decision",
    [
        pytest.param({"outcome": "needs_info"}, id="needs-info"),
        pytest.param({"outcome": "manual_review"}, id="manual-review"),
        pytest.param({"outcome": "withdrawn"}, id="unknown-outcome"),
        pytest.param({"reasons": ["Причина"]}, id="no-outcome"),
        pytest.param(None, id="no-decision"),
        pytest.param({}, id="empty-decision"),
        pytest.param({"outcome": "approved", "decided_by": "analyst"}, id="analyst-approval"),
        pytest.param({"outcome": "rejected", "decided_by": "analyst", "reasons": ["Решение специалиста"]},
                     id="analyst-rejection"),
        pytest.param({"outcome": "rejected", "stop_factors": ["Компания ликвидируется"]}, id="stop-factor-rejection"),
        pytest.param({"outcome": "counter_offer", "stop_factors": ["Компания ликвидируется"]},
                     id="stop-factor-counter"),
    ],
)
def test_not_eligible(decision):
    assert eligible(decision) is False


# --- Сообщение с данными для модели -----------------------------------------------------------------


def test_user_message_has_the_documented_data_block():
    assert user_message(APPROVED).split("\n") == [
        "<данные>",
        f"Решение банка: {lead(APPROVED)}",
        "Причины:",
        "- Компания давно на рынке — 7 лет",
        "- Кредиты обслуживаются без просрочек",
        "- Бизнес стабильно прибыльный",
        "Что можно сделать:",
        "- —",
        f"Следующий шаг: {next_step(APPROVED)}",
        "</данные>",
        "Напиши продолжение пояснения по правилам.",
    ]


def test_user_message_lists_tips_when_there_are_some():
    lines = user_message(REJECTED).split("\n")
    start = lines.index("Что можно сделать:")
    assert lines[start : start + 4] == [
        "Что можно сделать:",
        "- Обслуживайте кредиты без просрочек — через 6–12 месяцев оценка улучшится",
        "- Когда бизнес выйдет в плюс, шансы на одобрение вырастут",
        "- Погасите долг перед налоговой",
    ]
    assert lines[start + 4].startswith("Следующий шаг: ")


@pytest.mark.parametrize("facts", [APPROVED, COUNTER_SAME, REJECTED_NO_TIPS], ids=["approval", "counter", "rejection"])
def test_user_message_shows_a_dash_when_there_are_no_tips(facts):
    lines = user_message(facts).split("\n")
    start = lines.index("Что можно сделать:")
    assert lines[start + 1 : start + 3] == ["- —", f"Следующий шаг: {next_step(facts)}"]


def test_user_message_shows_a_dash_when_there_are_no_reasons():
    lines = user_message(replace(REJECTED, reasons=())).split("\n")
    assert lines[2:4] == ["Причины:", "- —"]


def test_user_message_keeps_the_order_of_reasons_and_tips():
    facts = replace(REJECTED, reasons=("Я причина", "Б причина", "А причина"), tips=("Ю совет", "Б совет", "А совет"))
    lines = user_message(facts).split("\n")
    assert lines[3:6] == ["- Я причина", "- Б причина", "- А причина"]
    assert lines[7:10] == ["- Ю совет", "- Б совет", "- А совет"]


@pytest.mark.parametrize("facts", ROUND_TRIP)
def test_user_message_ends_with_the_instruction(facts):
    lines = user_message(facts).split("\n")
    assert lines[-1] == "Напиши продолжение пояснения по правилам."
    assert lines[-2] == "</данные>"
    assert lines[0] == "<данные>"
    assert lines[1] == f"Решение банка: {lead(facts)}"


# --- Фейковая модель и проверка работают вместе --------------------------------------------------------


@pytest.mark.parametrize("facts", ROUND_TRIP)
def test_fake_provider_normal_answer_passes_the_check(facts):
    raw = answer(user_message(facts))
    assert check(raw, "stop", facts) == raw
    assert compose(facts, raw).startswith(lead(facts))


@pytest.mark.parametrize("facts", ROUND_TRIP)
def test_fake_provider_contradiction_is_rejected_as_outcome(facts):
    assert_invalid(answer(user_message(facts), "contradict"), facts, "outcome")


@pytest.mark.parametrize("facts", ROUND_TRIP)
def test_fake_provider_wrong_numbers_are_rejected_as_numbers(facts):
    assert_invalid(answer(user_message(facts), "wrong_numbers"), facts, "numbers")


# --- Числа: только те, что назвал банк, с той же единицей и рядом с тем же словом ----------------------------


@pytest.mark.parametrize(
    ("facts", "text"),
    [
        pytest.param(
            COUNTER_SAME,
            f"Сумма ограничена выручкой: при 1,2 млн ₽ в месяц доступно до 5 млн ₽. {SIGN_IF_SUITS}",
            id="requested-amount-instead-of-the-offered",
        ),
        pytest.param(
            COUNTER_SAME,
            f"Сумма ограничена выручкой: при 1,2 млн ₽ в месяц доступно до 5 000 000 ₽. {SIGN_IF_SUITS}",
            id="requested-amount-in-full-digits",
        ),
        pytest.param(
            COUNTER_SAME,
            f"Сумма кредита — 1,2 млн ₽, потому что так позволяет выручка. {SIGN_IF_SUITS}",
            id="revenue-presented-as-the-loan-amount",
        ),
        pytest.param(
            COUNTER_SAME,
            f"Ставка 18% учитывает оценку заявки. {SIGN_IF_SUITS}",
            id="term-shown-as-a-rate",
        ),
        pytest.param(
            COUNTER_SAME,
            f"Срок увеличен до 18 лет, чтобы ежемесячный платёж был посильным. {SIGN_IF_SUITS}",
            id="months-shown-as-years",
        ),
        pytest.param(
            APPROVED,
            f"Компания давно на рынке — 7 мес. {SIGN}",
            id="years-shown-as-months",
        ),
        pytest.param(
            REJECTED,
            f"Обслуживайте кредиты без просрочек — через 8 месяцев оценка улучшится. {NEW_APPLICATION}",
            id="number-outside-the-quoted-range",
        ),
        pytest.param(
            APPROVED,
            f"Компания давно на рынке — 7 лет, а прибыль выросла на 15%. {SIGN}",
            id="number-not-in-the-data",
        ),
        pytest.param(
            APPROVED,
            f"Компания давно на рынке — семь лет. {SIGN}",
            id="number-word-not-in-the-data",
        ),
        pytest.param(
            COUNTER_SAME,
            f"Кредит на год поможет бизнесу, платёж посильный. {SIGN_IF_SUITS}",
            id="term-in-words-year",
        ),
        pytest.param(
            COUNTER_SAME,
            f"Кредит на полгода поможет бизнесу, платёж посильный. {SIGN_IF_SUITS}",
            id="term-in-words-half-year",
        ),
        pytest.param(
            COUNTER_SAME,
            f"Платёж посильный, а первый квартал можно пережить без труда. {SIGN_IF_SUITS}",
            id="term-in-words-quarter",
        ),
    ],
)
def test_numbers_in_the_wrong_place_are_rejected(facts, text):
    assert_invalid(text, facts, "numbers")


@pytest.mark.parametrize(
    ("facts", "text"),
    [
        pytest.param(APPROVED, f"Компания давно на рынке — 7 лет, кредиты обслуживаются без просрочек. {SIGN}",
                     id="same-number-same-word"),
        pytest.param(COUNTER_SAME, f"Срок увеличен до 18 мес., чтобы ежемесячный платёж был посильным. {SIGN_IF_SUITS}",
                     id="term-in-months-as-in-the-reason"),
        pytest.param(COUNTER_SAME, f"Срок станет 18 мес., чтобы ежемесячный платёж был посильным. {SIGN_IF_SUITS}",
                     id="same-following-word-is-enough"),
        pytest.param(COUNTER_SAME, f"Ставка 24,9% учитывает оценку заявки. {SIGN_IF_SUITS}",
                     id="rate-as-in-the-reason"),
        pytest.param(COUNTER_SAME,
                     f"Сумма ограничена выручкой: при 1,2 млн ₽ в месяц доступно до 1,8 млн ₽. {SIGN_IF_SUITS}",
                     id="amounts-in-millions"),
        pytest.param(COUNTER_SAME,
                     f"Сумма ограничена выручкой: при 1 200 000 ₽ в месяц доступно до 1,8 млн ₽. {SIGN_IF_SUITS}",
                     id="million-written-in-digits"),
        pytest.param(COUNTER_SAME,
                     f"Сумма ограничена выручкой: при 1\u00a0200\u00a0000\u00a0₽ в месяц доступно до 1,8 млн ₽. "
                     f"{SIGN_IF_SUITS}",
                     id="million-written-with-non-breaking-spaces"),
        pytest.param(COUNTER_SAME,
                     f"Сумма ограничена выручкой: при 1200 тыс. ₽ в месяц доступно до 1,8 млн ₽. {SIGN_IF_SUITS}",
                     id="million-written-in-thousands"),
        pytest.param(REJECTED,
                     f"Обслуживайте кредиты без просрочек — через 6–12 месяцев оценка улучшится. {NEW_APPLICATION}",
                     id="range-from-a-tip"),
        pytest.param(REJECTED, f"Просрочки по кредитам были больше двух месяцев. {NEW_APPLICATION}",
                     id="number-word-from-the-data"),
    ],
)
def test_numbers_as_in_the_data_are_allowed(facts, text):
    assert check(text, "stop", facts) == text.replace("\u00a0", " ")


def test_same_amount_is_the_same_value_in_either_notation():
    facts = replace(COUNTER_SAME, reasons=("Сумма ограничена выручкой: при 1 200 000 ₽ в месяц доступно до 1,8 млн ₽",))
    text = f"Сумма ограничена выручкой: при 1,2 млн ₽ в месяц доступно до 1 800 000 ₽. {SIGN_IF_SUITS}"
    assert check(text, "stop", facts) == text


@pytest.mark.parametrize(
    "word", ["одиннадцать", "двенадцать", "пятнадцать", "восемнадцать", "шестьдесят", "девяносто", "двести"]
)
def test_every_number_word_outside_the_data_is_rejected(word):
    assert_invalid(f"Компания давно на рынке — {word} лет. {SIGN}", APPROVED, "numbers")


# --- Отрицание после слова, будущее время, обещания ----------------------------------------------------


@pytest.mark.parametrize(
    ("facts", "text"),
    [
        pytest.param(
            APPROVED,
            "Одобрить заявку не удалось из-за просрочек. Попробуйте позже подать заявку снова в кабинете.",
            id="approval-described-with-negation-after-the-word",
        ),
        pytest.param(
            REJECTED,
            "Это не отказ: подайте заявку снова, когда бизнес выйдет в плюс. Погасите долг перед налоговой.",
            id="rejection-is-not-a-refusal",
        ),
        pytest.param(
            REJECTED,
            "Отказа нет, это лишь рекомендация. Погасите долг перед налоговой и подайте новую заявку.",
            id="rejection-there-is-no-refusal",
        ),
        pytest.param(
            REJECTED,
            "Погасите долг перед налоговой и подайте новую заявку, тогда банк её одобрит.",
            id="rejection-bank-will-approve",
        ),
        pytest.param(
            REJECTED,
            "Погасите долг перед налоговой, и вы получите кредит. Затем подайте новую заявку.",
            id="rejection-you-will-get-the-loan",
        ),
        pytest.param(
            REJECTED,
            "Погасите долг перед налоговой, и вы сможете получить кредит. Затем подайте новую заявку.",
            id="rejection-you-will-be-able-to-get",
        ),
    ],
)
def test_outcome_words_are_caught_even_when_negated_or_in_future_tense(facts, text):
    assert_invalid(text, facts, "outcome")


@pytest.mark.parametrize(
    "text",
    [
        pytest.param("Погасите долг перед налоговой, и в следующий раз заявка пройдёт. Подайте новую заявку.",
                     id="next-time"),
        pytest.param("Мы гарантируем, что после погашения долга перед налоговой заявка пройдёт. Подайте новую.",
                     id="we-guarantee"),
        pytest.param("Погасите долг перед налоговой, скорее всего это поможет. Затем подайте новую заявку.",
                     id="most-likely"),
        pytest.param("Погасите долг перед налоговой, и в будущем заявка пройдёт. Затем подайте новую заявку.",
                     id="in-the-future"),
        pytest.param("Погасите долг перед налоговой, это наверняка поможет. Затем подайте новую заявку.",
                     id="surely"),
        pytest.param("Шансы вырастут, если погасить долг перед налоговой. Затем подайте новую заявку.",
                     id="chances-in-another-phrase"),
    ],
)
def test_promises_are_rejected(text):
    assert_invalid(text, REJECTED, "promise")


# --- Все пары «исход решения — описанный исход» ----------------------------------------------------------


@pytest.mark.parametrize(
    ("facts", "text"),
    [
        pytest.param(APPROVED, "К сожалению, заявка не прошла проверку. Подайте новую заявку позже, если захотите.",
                     id="approved-as-rejected-sorry"),
        pytest.param(APPROVED, "Банк отказал из-за просрочек в прошлом. Подайте новую заявку позже, если захотите.",
                     id="approved-as-rejected-refusal"),
        pytest.param(APPROVED, "Вместо этого можно взять меньшую сумму. Подпишите договор кодом в кабинете.",
                     id="approved-as-counter-instead"),
        pytest.param(APPROVED, "Компания давно на рынке — 7 лет, поэтому условия будут другими. Подпишите договор.",
                     id="approved-as-counter-other-terms"),
        pytest.param(COUNTER_SAME, "Сумма доступна в полном объёме, платёж посильный. Подпишите договор кодом.",
                     id="counter-as-approved-in-full"),
        pytest.param(COUNTER_SAME, "Всё как вы просили, платёж посильный. Если всё подходит, подпишите договор кодом.",
                     id="counter-as-approved-as-you-asked"),
        pytest.param(COUNTER_SAME, "Банк одобрил заявку на запрошенных условиях, платёж посильный. Подпишите договор.",
                     id="counter-as-approved-requested-terms"),
        pytest.param(COUNTER_SAME, "Банк отказал в запрошенной сумме, платёж посильный. Подпишите договор кодом.",
                     id="counter-as-rejected"),
        pytest.param(REJECTED, "Поздравляем, у вас всё хорошо. Погасите долг перед налоговой и подайте заявку.",
                     id="rejected-as-approved-congratulations"),
        pytest.param(REJECTED, "Мы рады сообщить, что всё хорошо. Погасите долг перед налоговой и подайте заявку.",
                     id="rejected-as-approved-glad"),
        pytest.param(REJECTED, "К счастью, всё хорошо. Погасите долг перед налоговой и подайте новую заявку.",
                     id="rejected-as-approved-fortunately"),
        pytest.param(REJECTED, "Поздравляем, банк одобрил заявку. Погасите долг перед налоговой и подайте новую.",
                     id="rejected-as-approved-bank-approved"),
        pytest.param(REJECTED, "Банк предлагает другой продукт, который подойдёт бизнесу. Подайте новую заявку.",
                     id="rejected-as-counter-another-product"),
    ],
)
def test_wrong_outcome_is_rejected_for_every_pair(facts, text):
    assert_invalid(text, facts, "outcome")


# --- Дословная цитата из данных ------------------------------------------------------------------------


QUOTED_TIP = "Когда бизнес выйдет в плюс, шансы на одобрение вырастут"


def test_verbatim_tip_with_outcome_and_promise_words_passes():
    text = f"{QUOTED_TIP}. {NEW_APPLICATION}"
    assert check(text, "stop", REJECTED) == text


@pytest.mark.parametrize(
    ("text", "rule"),
    [
        pytest.param(f"Подайте новую заявку, и одобрение станет вероятнее. {NEW_APPLICATION}", "outcome",
                     id="approval-in-another-phrase"),
        pytest.param(f"Бизнес выйдет в плюс, и вас ждёт одобрение. {NEW_APPLICATION}", "outcome",
                     id="approval-with-other-neighbours"),
        pytest.param(f"Шансы вырастут, если бизнес выйдет в плюс. {NEW_APPLICATION}", "promise",
                     id="chances-in-another-phrase"),
        pytest.param(f"Шансы высоки, когда бизнес выйдет в плюс. {NEW_APPLICATION}", "promise",
                     id="chances-with-other-neighbours"),
    ],
)
def test_outcome_and_promise_words_outside_the_verbatim_quote_fail(text, rule):
    assert_invalid(text, REJECTED, rule)


def test_the_quote_exception_does_not_leak_to_other_decisions():
    assert_invalid(f"{QUOTED_TIP}. {SIGN}", APPROVED, "outcome")


# --- Форма ответа ------------------------------------------------------------------------------------------

GOOD = f"Компания давно на рынке — 7 лет. {SIGN}"


def test_good_text_passes_unchanged():
    assert check(GOOD, "stop", APPROVED) == GOOD


@pytest.mark.parametrize(
    ("raw", "finish_reason"),
    [
        pytest.param(GOOD, "length", id="cut-off-by-length"),
        pytest.param("", "stop", id="empty"),
        pytest.param("   \n  ", "stop", id="blank"),
        pytest.param("<think></think>", "stop", id="only-an-empty-thought"),
        pytest.param(f"<think>Сначала разберусь с причинами. {GOOD}", "stop", id="unclosed-think"),
        pytest.param(f"{GOOD}</think>", "stop", id="closing-think-only"),
        pytest.param(None, "stop", id="not-a-string"),
    ],
)
def test_bad_shape(raw, finish_reason):
    assert_invalid(raw, APPROVED, "shape", finish_reason)


@pytest.mark.parametrize(
    "raw",
    [
        pytest.param(f"<think>рассуждаю</think>{GOOD}", id="think-glued"),
        pytest.param(f"<think>\nшаг 1\nшаг 2\n</think>\n\n{GOOD}", id="multiline-think"),
        pytest.param(f"<THINK>Рассуждаю.</Think> {GOOD}", id="think-in-any-case"),
        pytest.param(f"<think>раз</think><think>два</think>{GOOD}", id="two-think-blocks"),
    ],
)
def test_closed_think_block_is_removed(raw):
    assert check(raw, "stop", APPROVED) == GOOD


@pytest.mark.parametrize(
    "raw",
    [
        pytest.param(f"«{GOOD}»", id="guillemets"),
        pytest.param(f'"{GOOD}"', id="straight-quotes"),
        pytest.param(f"“{GOOD}”", id="curly-quotes"),
        pytest.param(f"  «{GOOD}»\n", id="quotes-with-whitespace"),
        pytest.param(f"«  {GOOD}  »", id="quotes-with-inner-whitespace"),
    ],
)
def test_surrounding_quotes_are_stripped(raw):
    assert check(raw, "stop", APPROVED) == GOOD


def test_whitespace_and_line_breaks_are_collapsed():
    raw = "Компания давно на рынке — 7 лет.\n\nПодпишите договор кодом  в кабинете,\tпока предложение действует."
    assert check(raw, "stop", APPROVED) == GOOD


# --- Разметка ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        pytest.param(f"**Главное**: компания давно на рынке — 7 лет. {SIGN}", id="bold"),
        pytest.param(f"# Главное\nКомпания давно на рынке — 7 лет. {SIGN}", id="heading"),
        pytest.param(f"Компания давно на рынке — 7 лет.\n- {SIGN}", id="dash-list-line"),
        pytest.param(f"Компания давно на рынке — 7 лет.\n* {SIGN}", id="star-list-line"),
        pytest.param(f"Компания давно на рынке — 7 лет.\n• {SIGN}", id="bullet-list-line"),
        pytest.param(f"Компания давно на рынке — 7 лет.\n1. {SIGN}", id="numbered-list-line"),
        pytest.param(f"Компания давно на рынке — 7 лет.\n2) {SIGN}", id="numbered-bracket-list-line"),
        pytest.param(f"Компания давно на рынке — 7 лет.\n— {SIGN}", id="em-dash-line"),
        pytest.param(f"- Компания давно на рынке — 7 лет. {SIGN}", id="list-from-the-first-line"),
        pytest.param(f"Компания давно на рынке — 7 лет. {SIGN} Подробности: http://example.ru", id="http-link"),
        pytest.param(f"Компания давно на рынке — 7 лет. {SIGN} Подробности: https://example.ru", id="https-link"),
        pytest.param(f"Компания давно на рынке — 7 лет. {SIGN} Подробности: www.example.ru", id="www-link"),
        pytest.param(f"Компания давно на рынке — 7 лет. {SIGN} Пишите на help@example.ru", id="at-sign"),
        pytest.param(f"Компания давно на рынке — 7 лет. `{SIGN}`", id="backtick"),
        pytest.param(f"Компания давно на рынке — 7 лет. <b>{SIGN}</b>", id="html-tag"),
    ],
)
def test_markup(text):
    assert_invalid(text, APPROVED, "markup")


# --- Язык ----------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        pytest.param(f"{GOOD} 公司", id="chinese-characters"),
        pytest.param(f"{GOOD} こんにちは", id="japanese-kana"),
        pytest.param("Компанія давно на ринку — 7 лет. Підпишіть договір кодом у кабінеті, поки пропозиція діє.",
                     id="ukrainian-i"),
        pytest.param(f"Компания давно на рынке — 7 лет, это настоящий success. {SIGN}", id="latin-word"),
        pytest.param("The company has been on the market for 7 years. Sign the contract with the code.",
                     id="english-sentence"),
        pytest.param("1234567890 12345678901234567890. 1234567890.", id="no-letters-at-all"),
    ],
)
def test_language(text):
    assert_invalid(text, APPROVED, "language")


# --- Длина --------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        pytest.param("Подпишите договор в кабинете.", id="shorter-than-40"),
        pytest.param(sized(39), id="39-chars"),
        pytest.param(sized(451), id="451-chars"),
        pytest.param("Компания давно на рынке — 7 лет, подпишите договор кодом в кабинете", id="no-final-punctuation"),
        pytest.param("Компания давно на рынке — 7 лет, подпишите договор кодом в кабинете,", id="ends-with-comma"),
        pytest.param("Компания давно на рынке — 7 лет, подпишите договор кодом в кабинете:", id="ends-with-colon"),
        pytest.param(
            "Компания давно на рынке — 7 лет. Кредиты обслуживаются без просрочек. Бизнес стабильно прибыльный. "
            "Подпишите договор кодом в кабинете. Предложение пока действует.",
            id="five-sentences",
        ),
        pytest.param(
            "Компания давно на рынке — 7 лет! Кредиты обслуживаются без просрочек? Бизнес стабильно прибыльный… "
            "Подпишите договор кодом в кабинете. Предложение пока действует.",
            id="five-sentences-with-other-endings",
        ),
    ],
)
def test_length(text):
    assert_invalid(text, APPROVED, "length")


@pytest.mark.parametrize(
    "text",
    [
        pytest.param(sized(40), id="exactly-40-chars"),
        pytest.param(sized(450), id="exactly-450-chars"),
        pytest.param("Компания давно на рынке — 7 лет! Подпишите договор кодом в кабинете!", id="exclamation-mark"),
        pytest.param("Компания давно на рынке — 7 лет. Подпишите договор кодом в кабинете?", id="question-mark"),
        pytest.param("Компания давно на рынке — 7 лет. Подпишите договор кодом в кабинете…", id="ellipsis"),
        pytest.param(
            "Компания давно на рынке — 7 лет. Кредиты обслуживаются без просрочек. Бизнес стабильно прибыльный. "
            "Подпишите договор кодом в кабинете.",
            id="four-sentences",
        ),
    ],
)
def test_length_within_limits(text):
    assert check(text, "stop", APPROVED) == text


# --- Эхо промпта и личное ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        pytest.param(f"Уважаемый клиент, компания давно на рынке — 7 лет. {SIGN}", id="dear-client"),
        pytest.param(f"УВАЖАЕМЫЙ КЛИЕНТ, компания давно на рынке — 7 лет. {SIGN}", id="dear-client-upper"),
        pytest.param(f"Здравствуйте! Компания давно на рынке — 7 лет. {SIGN}", id="hello"),
        pytest.param(f"Компания ООО давно на рынке — 7 лет. {SIGN}", id="llc-upper"),
        pytest.param(f"Компания ооо давно на рынке — 7 лет. {SIGN}", id="llc-lower"),
        pytest.param(f"Ваш ИП давно на рынке — 7 лет. {SIGN}", id="sole-proprietor-upper"),
        pytest.param(f"Ваш ип давно на рынке — 7 лет. {SIGN}", id="sole-proprietor-lower"),
        pytest.param(f"Компания с ИНН давно на рынке — 7 лет. {SIGN}", id="tax-id-upper"),
        pytest.param(f"Компания с инн давно на рынке — 7 лет. {SIGN}", id="tax-id-lower"),
        pytest.param(f"Решение банка: компания давно на рынке — 7 лет. {SIGN}", id="decision-label"),
        pytest.param(f"Причины: компания давно на рынке — 7 лет. {SIGN}", id="reasons-label"),
        pytest.param(f"Компания давно на рынке — 7 лет. Следующий шаг: {SIGN}", id="next-step-label"),
        pytest.param(f"Компания давно на рынке — 7 лет. Это пояснение к решению. {SIGN}", id="explanation-word"),
    ],
)
def test_echo(text):
    assert_invalid(text, APPROVED, "echo")


# --- Названия -----------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        pytest.param("Компания давно на рынке — 7 лет. Подойдёт также «Бизнес-старт» для вашей компании.",
                     id="unknown-name-in-guillemets"),
        pytest.param(f'Компания давно на рынке — 7 лет. {SIGN} Есть и "Бизнес-старт" для компаний.',
                     id="unknown-name-in-straight-quotes"),
        pytest.param("Компания давно на рынке — 7 лет. Для оборотных нужд подойдёт овердрафт, если удобнее.",
                     id="overdraft-for-an-express-only-approval"),
        pytest.param("Компания давно на рынке — 7 лет. Подойдёт также лимит овердрафта на расчётном счёте.",
                     id="inflected-overdraft"),
        pytest.param("Компания давно на рынке — 7 лет. Для вложений в оборудование есть инвестиционный кредит.",
                     id="investment-credit-for-an-express-only-approval"),
    ],
)
def test_names_not_in_the_data(text):
    assert_invalid(text, APPROVED, "names")


@pytest.mark.parametrize(
    ("facts", "text"),
    [
        pytest.param(APPROVED, f"Компания давно на рынке — 7 лет, поэтому «Экспресс-оборот» вам подходит. {SIGN}",
                     id="product-from-the-first-sentence"),
        pytest.param(REJECTED,
                     "Погасите долг перед налоговой, а другой продукт подберите кнопкой «Подобрать другой вариант».",
                     id="button-from-the-next-step"),
        pytest.param(COUNTER_OTHER, f"Овердрафт подходит под ваши показатели лучше. {SIGN_IF_SUITS}",
                     id="overdraft-when-it-is-the-offer"),
    ],
)
def test_names_from_the_data_are_allowed(facts, text):
    assert check(text, "stop", facts) == text


# --- Внутренняя кухня банка --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        pytest.param(f"Компания давно на рынке — 7 лет, и у неё высокий грейд. {SIGN}", id="grade"),
        pytest.param(f"Компания давно на рынке — 7 лет, и у неё высокий балл. {SIGN}", id="point"),
        pytest.param(f"Компания давно на рынке — 7 лет, это показали баллы. {SIGN}", id="points"),
        pytest.param(f"Компания давно на рынке — 7 лет, это показала модель банка. {SIGN}", id="model"),
        pytest.param(f"Компания давно на рынке — 7 лет, и это имеет вес. {SIGN}", id="weight"),
        pytest.param(f"Компания давно на рынке — 7 лет, это учтено с большим весом. {SIGN}", id="weight-instrumental"),
        pytest.param(f"Компания давно на рынке — 7 лет, так решил алгоритм. {SIGN}", id="algorithm"),
        pytest.param(f"Компания давно на рынке — 7 лет, так велит политика банка. {SIGN}", id="policy"),
    ],
)
def test_internal_terms(text):
    assert_invalid(text, APPROVED, "internal")


@pytest.mark.parametrize(
    "text",
    [
        pytest.param(f"Весь срок кредит обслуживается без просрочек, компания давно на рынке — 7 лет. {SIGN}",
                     id="whole"),
        pytest.param("Компания давно на рынке — 7 лет. Весной подпишите договор кодом в кабинете.", id="in-spring"),
    ],
)
def test_words_that_only_look_like_internal_terms_pass(text):
    assert check(text, "stop", APPROVED) == text


# --- Каналы связи ------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        pytest.param("Компания давно на рынке — 7 лет. Позвоните нам, чтобы подписать договор кодом.", id="call"),
        pytest.param("Компания давно на рынке — 7 лет. Подпишите договор кодом в офисе банка.", id="office"),
        pytest.param("Компания давно на рынке — 7 лет. Подпишите договор кодом, ваш менеджер подскажет.",
                     id="manager"),
        pytest.param("Компания давно на рынке — 7 лет. Подпишите договор кодом, напишите на почту банка.",
                     id="mail"),
        pytest.param("Компания давно на рынке — 7 лет. Подпишите договор кодом, а вопросы задайте в чате.",
                     id="chat"),
    ],
)
def test_channels(text):
    assert_invalid(text, APPROVED, "channel")


def test_a_word_that_only_looks_like_a_channel_passes():
    text = f"Почти все кредиты обслуживаются без просрочек, компания давно на рынке — 7 лет. {SIGN}"
    assert check(text, "stop", APPROVED) == text


# --- Темы ------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        pytest.param(f"Компания давно на рынке — 7 лет, а налоги платятся вовремя. {SIGN}", id="tax"),
        pytest.param(f"Компания давно на рынке — 7 лет, налоговой задолженности нет. {SIGN}", id="tax-debt"),
        pytest.param(f"Компания давно на рынке — 7 лет, долгов у неё нет. {SIGN}", id="debts"),
        pytest.param(f"Компания давно на рынке — 7 лет, а долг перед налоговой погашен. {SIGN}", id="debt"),
        pytest.param(f"Компания давно на рынке — 7 лет, долгами не обременена. {SIGN}", id="debts-instrumental"),
        pytest.param(f"Компания давно на рынке — 7 лет, а выручка растёт. {SIGN}", id="revenue"),
        pytest.param(f"Компания давно на рынке — 7 лет, а залог не нужен. {SIGN}", id="collateral"),
    ],
)
def test_topics_missing_from_the_data(text):
    assert_invalid(text, APPROVED, "topic")


@pytest.mark.parametrize(
    ("facts", "text"),
    [
        pytest.param(APPROVED, f"Компания давно на рынке — 7 лет, поэтому долго проверять не пришлось. {SIGN}",
                     id="long-time"),
        pytest.param(REJECTED, f"{NEW_APPLICATION} Долг перед налоговой мешает.", id="debt-from-the-data"),
        pytest.param(REJECTED, "Налоги и задолженность по налогам мешают. Погасите долг перед налоговой.",
                     id="tax-from-the-data"),
    ],
)
def test_topics_present_in_the_data_or_only_similar_pass(facts, text):
    assert check(text, "stop", facts) == text


@pytest.mark.parametrize("form", ["просрочка", "просрочки", "просрочку", "просрочкой", "просрочках"])
def test_overdue_topic_is_caught_when_the_data_has_none(form):
    assert_invalid(f"Речь идёт о слове {form}. {SIGN_IF_SUITS}", COUNTER_SAME, "topic")


@pytest.mark.parametrize(
    "text",
    [
        pytest.param(f"У вас нет просрочек по кредитам. {SIGN_IF_SUITS}", id="genitive-plural"),
        pytest.param(f"Просроченные платежи не мешают. {SIGN_IF_SUITS}", id="adjective"),
    ],
)
def test_overdue_topic_in_every_form_is_rejected(text):
    assert_invalid(text, COUNTER_SAME, "topic")


# --- Порядок правил ----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "rule"),
    [
        pytest.param(f"**Компания** давно на рынке — 7 лет. {SIGN} 公司", "markup", id="markup-before-language"),
        pytest.param("Company has been on the market. 公司 7", "language", id="language-before-length"),
        pytest.param("Уважаемый клиент, нет точки", "length", id="length-before-echo"),
        pytest.param(f"Уважаемый клиент, компания отказал «Бизнес-старт». {SIGN}", "echo", id="echo-before-names"),
        pytest.param(f"Компания давно на рынке — 7 лет, банк отказал в «Бизнес-старт». {SIGN}", "names",
                     id="names-before-outcome"),
        pytest.param(f"Банк одобрил заявку, гарантируем успех. {SIGN}", "outcome", id="outcome-before-promise"),
        pytest.param(f"Гарантируем успех, у нас высокий грейд. {SIGN}", "promise", id="promise-before-internal"),
        pytest.param(f"Позвоните, у нас высокий грейд. {SIGN}", "internal", id="internal-before-channel"),
        pytest.param(f"Позвоните нам, компания давно на рынке — 8 лет. {SIGN}", "channel", id="channel-before-numbers"),
        pytest.param(f"Компания давно на рынке — 8 лет, налоги платятся. {SIGN}", "numbers", id="numbers-before-topic"),
    ],
)
def test_first_matching_rule_wins(text, rule):
    assert_invalid(text, APPROVED, rule)


@pytest.mark.parametrize(
    ("facts", "text"),
    [
        pytest.param(APPROVED, "Заявка не прошла проверку из-за выручки.", id="approved-not-passed"),
        pytest.param(APPROVED, "Кредит не будет предоставлен в этот раз.", id="approved-not-granted"),
        pytest.param(COUNTER_SAME, "Банк не станет кредитовать вас на всю сумму.", id="counter-will-not-lend"),
        pytest.param(REJECTED, "Банк сможет профинансировать бизнес позже.", id="rejected-will-finance"),
    ],
)
def test_outcome_restated_with_synonyms_is_rejected(facts, text):
    assert_invalid(f"{text} {SIGN_IF_SUITS}", facts, "outcome")


def test_turn_of_phrase_with_obratit_is_not_a_channel():
    text = f"Стоит обратить внимание: кредиты обслуживаются без просрочек. {SIGN_IF_SUITS}"
    assert check(text, "stop", APPROVED) == text
