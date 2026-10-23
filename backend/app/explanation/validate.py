"""Проверка ответа модели. Гарантию даёт она, а не промпт: любое нарушение — пояснения нет, клиент видит шаблон.

Модель пишет только продолжение после первого предложения (его пишет код, см. facts.lead). В её части:
- нет слов исхода решения и их синонимов — противоречие решению отсекается словарём (остаточный риск: исход,
  описанный словами вне словаря; рядом всегда официальные условия и причины банка);
- число — только если такое же число с той же единицей стоит в причинах или подсказках банка и рядом с тем же
  словом, что и там: выручку не выдать за сумму кредита, а срок — за ставку;
- сроки и числа словами, темы, внутренние термины, каналы связи и названия — только если они есть в данных;
- русский язык; без разметки, ссылок, обещаний и эха промпта.
Слово исхода или обещания допустимо только в дословной цитате из данных (слово вместе с соседями) — например,
подсказка банка «шансы на одобрение вырастут».
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal

from app.domain.products import CATALOGUE
from app.domain.statuses import Status
from app.explanation.facts import Facts, lead, next_step

MIN_CHARS = 40
MAX_CHARS = 450
MAX_SENTENCES = 4


class Invalid(Exception):
    """Ответ показывать нельзя; rule — какое правило сработало (пишется в error как invalid:<rule>)."""

    def __init__(self, rule: str) -> None:
        super().__init__(rule)
        self.rule = rule


def check(raw: str, finish_reason: str | None, f: Facts) -> str:
    """Часть пояснения, написанная моделью, после очистки. Правила идут по порядку, первое сработавшее побеждает."""
    text = _shape(raw, finish_reason)
    if _LIST_LINE.search(text) or _MARKUP.search(text):
        raise Invalid("markup")
    text = " ".join(text.split())
    d = _data(f)
    _language(text, d)
    _length(text)
    low = _norm(text)
    if _ECHO.search(low):
        raise Invalid("echo")
    _names(text, low, d)
    words = _words(text)
    _outcome(words, low, f.outcome, d)
    for i, word in enumerate(words):
        if _PROMISE.match(word) and not _quoted(words, i, d):
            raise Invalid("promise")
    if any(p in low and p not in d.bank for p in _PROMISE_PHRASES):
        raise Invalid("promise")
    for rule, pattern in (("internal", _INTERNAL), ("channel", _CHANNEL)):
        if any(pattern.match(w) and w not in d.words for w in words):
            raise Invalid(rule)
    _numbers_match(low, d)
    _topics(words, d)
    return text


def compose(f: Facts, part: str) -> str:
    """Текст для клиента: первое предложение банка и проверенное продолжение модели."""
    return f"{lead(f)} {part}"


# --- Данные, с которыми сверяется ответ ---------------------------------------------------------


@dataclass(frozen=True)
class _Data:
    numbers: dict[tuple[Decimal, str], set[str]]  # числа причин и подсказок с единицами → соседние слова
    items: tuple[tuple[str, ...], ...]  # слова каждого текста банка — для дословных цитат
    words: frozenset[str]  # все слова причин, подсказок и следующего шага
    bank: str  # те же тексты одной строкой, нормализованные
    names: str  # то же вместе с первым предложением — для названий


def _data(f: Facts) -> _Data:
    bank = [*f.reasons, *f.tips, next_step(f)]
    numbers: dict[tuple[Decimal, str], set[str]] = {}
    for text in (*f.reasons, *f.tips):
        for value, neighbours in _numbers(_norm(text)):
            numbers.setdefault(value, set()).update(neighbours)
    return _Data(
        numbers=numbers,
        items=tuple(tuple(_words(t)) for t in bank),
        words=frozenset(w for t in bank for w in _words(t)),
        bank=_norm(" ".join(bank)),
        names=_norm(" ".join([lead(f), *bank])),
    )


_SPACES = re.compile(r"[    ]")


def _norm(text: str) -> str:
    return _SPACES.sub(" ", text).lower().replace("ё", "е")


def _words(text: str) -> list[str]:
    return re.findall(r"[0-9a-zа-я]+", _norm(text))


def _quoted(words: list[str], i: int, d: _Data) -> bool:
    """Слово стоит вместе с соседями так же, как в одном из текстов банка."""
    window = words[max(0, i - 1) : i + 2]
    n = len(window)
    return n >= 2 and any(
        list(item[j : j + n]) == window for item in d.items for j in range(len(item) - n + 1)
    )


# --- Форма, разметка, язык, длина ---------------------------------------------------------------

_THINK = re.compile(r"<think>.*?</think>", re.S | re.I)
_PAIRS = {"«": "»", '"': '"', "“": "”", "„": "“"}
_LIST_LINE = re.compile(r"^\s*(?:[-*•–—]|\d+[.)])\s", re.M)
_MARKUP = re.compile(r"[*#`|<>\[\]{}_~@]|https?:|www\.")
# Греческий, иврит, арабский, тайский, кана, иероглифы, хангыль.
_FOREIGN = re.compile(
    r"[Ͱ-Ͽ֐-ۿ฀-๿぀-ヿ㐀-鿿가-힯豈-﫿]"
)
_NOT_RUSSIAN = re.compile(r"[іїєґўІЇЄҐЎ]")
_SENTENCE_END = re.compile(r"[.!?…]+(?=\s+[А-ЯЁA-Z«\"“]|$)")


def _shape(raw: object, finish_reason: str | None) -> str:
    """Обрезанный ответ, блоки рассуждений и обрамляющие кавычки."""
    if finish_reason == "length" or not isinstance(raw, str):
        raise Invalid("shape")
    text = _THINK.sub("", raw).strip()
    if "think>" in text.lower():
        raise Invalid("shape")
    closing = _PAIRS.get(text[:1])
    inner = text[1:-1]
    if closing and len(text) > 2 and text.endswith(closing) and text[0] not in inner and closing not in inner:
        text = inner.strip()
    if not text:
        raise Invalid("shape")
    return text


def _language(text: str, d: _Data) -> None:
    if _FOREIGN.search(text) or _NOT_RUSSIAN.search(text):
        raise Invalid("language")
    cyrillic = len(re.findall(r"[а-яё]", text, re.I))
    latin = len(re.findall(r"[a-z]", text, re.I))
    if cyrillic == 0 or cyrillic < 0.9 * (cyrillic + latin):
        raise Invalid("language")
    if any(word not in d.names for word in re.findall(r"[a-z]{2,}", _norm(text))):
        raise Invalid("language")


def _length(text: str) -> None:
    if not MIN_CHARS <= len(text) <= MAX_CHARS or not text.endswith((".", "!", "?", "…")):
        raise Invalid("length")
    if len(_SENTENCE_END.findall(text)) > MAX_SENTENCES:
        raise Invalid("length")


# --- Эхо промпта, личное, названия --------------------------------------------------------------

_ECHO = re.compile(
    r"уважаем|здравствуй|добрый день|привет|\bооо\b|\bип\b|\bинн\b|\bогрн\b|пояснени|по правилам|"
    r"решение банка:|следующий шаг:|причины:|что можно сделать:"
)
_QUOTED_NAME = re.compile(r"«([^«»]{1,80})»|\"([^\"]{1,80})\"|“([^“”]{1,80})”")
# Основа названия продукта: модель может просклонять его («овердрафта»).
_PRODUCT_STEMS = tuple(_norm(p.name).split()[0][:-2] for p in CATALOGUE)


def _names(text: str, low: str, d: _Data) -> None:
    """Любое название в кавычках и любой продукт из каталога — только из данных: не тот продукт модель не назовёт."""
    for m in _QUOTED_NAME.finditer(text):
        if _norm(next(g for g in m.groups() if g)) not in d.names:
            raise Invalid("names")
    if any(stem in low and stem not in d.names for stem in _PRODUCT_STEMS):
        raise Invalid("names")


# --- Исход решения, обещания, внутренняя кухня, каналы ------------------------------------------

_OUTCOME = re.compile(
    r"одобр|отказ|отклон|выда|получ(?:ит|ить|ат|ен|ил)|предлага|предлож(?:ит|им|ат|ил)|контрпредлож|услови|"
    r"предостав|кредитова|финансир|профинансир"
)
# Исход, пересказанный без слов исхода, — при любом решении.
_RESTATED = ("не прош", "не смож", "не станет")
# Признаки противоположного исхода, которые не ловятся словами исхода.
_CONTRARY = {
    Status.APPROVED.value: ("к сожалению", "вместо", "меньше запрошен"),
    Status.COUNTER_OFFER.value: ("в полном объем", "как вы просили", "как вы и просили"),
    Status.REJECTED.value: ("поздрав", "рады ", "к счастью"),
}
_PROMISE = re.compile(r"^(?:гарантир\w*|обязательно|наверняка|непременно|точно|шанс\w*|вероятн\w*)$")
_PROMISE_PHRASES = ("скорее всего", "в следующий раз", "в будущем")
_INTERNAL = re.compile(
    r"^(?:балл\w*|грейд\w*|скоринг\w*|скоркарт\w*|рейтинг\w*|алгоритм\w*|модел\w*|нейросет\w*|искусствен\w*|"
    r"коэффициент\w*|вес|веса|весов|весом|весу|дефолт\w*|внутренн\w*|политик\w*|порог\w*)$"
)
_CHANNEL = re.compile(
    r"^(?:позвон\w*|звон\w*|телефон\w*|офис\w*|отделени\w*|почта|почты|почте|почту|почтой|email|mail|смс|sms|"
    r"менеджер\w*|мессенджер\w*|свяж\w*|чат\w*|сайт\w*|консультант\w*|специалист\w*|обратитесь|обращайтесь|"
    r"приходите|приезжайте)$"
)


def _outcome(words: list[str], low: str, outcome: str, d: _Data) -> None:
    """Решение уже названо в первом предложении — в части модели слов исхода нет, кроме дословной цитаты."""
    for i, word in enumerate(words):
        if _OUTCOME.match(word) and not _quoted(words, i, d):
            raise Invalid("outcome")
    if any(p in low and p not in d.bank for p in (*_RESTATED, *_CONTRARY.get(outcome, ()))):
        raise Invalid("outcome")


# --- Числа и темы -------------------------------------------------------------------------------

_INT = r"\d{1,3}(?: \d{3})+|\d+"
_NUMBER = re.compile(
    rf"(?<![\w,.])({_INT})(?:[,.](\d+))?"
    rf"(?:\s?[–—-]\s?({_INT})(?:[,.](\d+))?)?"
    r"(?:\s?(тыс\b\.?|тысяч\w*|млн\b\.?|миллион\w*|млрд\b\.?|миллиард\w*))?"
    r"(?:\s?(₽|руб\w*\.?|%|процент\w*|мес\b\.?|месяц\w*|дн\b\.?|дня\b|дней\b|день\b|лет\b|год\w*|раза?\b))?"
)
_MULTIPLIERS = (("тыс", 1_000), ("млн", 1_000_000), ("миллион", 1_000_000), ("млрд", 10**9), ("миллиард", 10**9))
_UNITS = (
    ("₽", "rub"), ("руб", "rub"), ("%", "pct"), ("процент", "pct"), ("мес", "month"), ("дн", "day"), ("день", "day"),
    ("лет", "year"), ("год", "year"), ("раз", "times"),
)
# Числительные и доли словами во всех формах: «двенадцать лет» вместо «12 лет» — тоже число.
_COUNT_WORD = re.compile(
    r"^(?:(?:одиннадцат|двенадцат|тринадцат|четырнадцат|пятнадцат|шестнадцат|семнадцат|восемнадцат|девятнадцат|"
    r"двадцат|тридцат|пят|шест|сем|восем|девят|десят)(?:ь|и|ью)|два|две|двух|двум|двумя|три|трех|трем|тремя|"
    r"четыре|четырех|четырем|четырьмя|восьми|восьмью|сорок|сорока|девяносто|девяноста|сто|ста|сотн\w*|"
    r"(?:пять|шесть|семь|восемь)(?:десят|сот)|(?:пяти|шести|семи|восьми)(?:десяти|сот)|двести|двухсот|триста|"
    r"трехсот|четыреста|четырехсот|девятьсот|девятисот|тысяч\w*|миллион\w*|миллиард\w*|полтор\w*|половин\w*|"
    r"трет\w*|четверт\w*|вдвое|втрое|вчетверо|дважды|трижды)$"
)
_TIME_WORDS = frozenset(
    "год года году годом годы лет полгода полугода квартал квартала кварталы кварталов месяц месяца месяцу месяцем "
    "месяцы месяцев неделя недели неделю неделей недель сутки суток день дня дней".split()
)
_TOPICS = (
    "просроч", "выручк", "прибыл", "убыт", "рентабельн", "задолжен", "налог", "залог", "поручител", "обеспечен",
    "ликвид", "банкрот", "дисквалиф", "блокир", "заблокир", "реорганиз", "нагрузк", "обраща", "обращени", "адрес",
    "истори", "выписк", "ставк", "сумм", "лимит", "оценк", "зарегистр", "регистрац",
)
_DEBT = re.compile(r"^долг(?:а|у|ом|е|и|ов|ам|ами|ах)?$")


def _numbers(low: str) -> list[tuple[tuple[Decimal, str], set[str]]]:
    """Числа нормализованного текста как (значение, единица) и соседние слова: «3 млн ₽» и «3 000 000 ₽» — одно
    и то же, а «12 мес.» и «12%» — разное. Диапазон «6–12 месяцев» даёт оба числа."""
    found = []
    for m in _NUMBER.finditer(low):
        neighbours = {f"<{w}" for w in _words(low[: m.start()])[-1:]} | {f">{w}" for w in _words(low[m.end() :])[:1]}
        mult_word, unit_word = m.group(5), m.group(6)
        mult = next((v for k, v in _MULTIPLIERS if mult_word and mult_word.startswith(k)), 1)
        unit = next((u for k, u in _UNITS if unit_word and unit_word.startswith(k)), "rub" if mult_word else "none")
        for whole, frac in ((m.group(1), m.group(2)), (m.group(3), m.group(4))):
            if whole:
                value = Decimal(whole.replace(" ", "") + (f".{frac}" if frac else "")) * mult
                found.append(((value, unit), neighbours))
    return found


def _numbers_match(low: str, d: _Data) -> None:
    """Число — только такое, какое банк назвал в причинах или подсказках, и с тем же соседним словом (до или после);
    сроки и числа словами — только из данных."""
    for value, neighbours in _numbers(low):
        if value not in d.numbers or not neighbours & d.numbers[value]:
            raise Invalid("numbers")
    rest = _words(_NUMBER.sub(" ", low))  # единицы при числах уже проверены выше
    if any(_COUNT_WORD.match(w) or w in _TIME_WORDS for w in rest if w not in d.words):
        raise Invalid("numbers")


def _topics(words: list[str], d: _Data) -> None:
    """Тема причины — только если она есть в данных: модель не добавит причину, которой у банка нет."""
    for word in words:
        stem = next((s for s in _TOPICS if word.startswith(s)), None)
        if stem and not any(w.startswith(stem) for w in d.words):
            raise Invalid("topic")
        if _DEBT.match(word) and not any(_DEBT.match(w) for w in d.words):
            raise Invalid("topic")
