"""Скоринг по правилам: балльная скоркарта.

Каждый признак добавляет или снимает баллы от базовых 50, итог (0–100) переводится в грейд A–E.
У каждого фактора есть объяснение для клиента и подсказка, что улучшить, — их показывает
интерфейс. Веса условные и задокументированы в docs/scoring.md.
"""

from dataclasses import asdict, dataclass

from app.scoring.features import Features

VERSION = "rules-1.0"
BASE_SCORE = 50

# Грейд по минимальному баллу и ориентировочная вероятность дефолта для мастер-шкалы.
GRADES: tuple[tuple[str, int, float], ...] = (
    ("A", 80, 0.01),
    ("B", 65, 0.03),
    ("C", 50, 0.07),
    ("D", 35, 0.15),
    ("E", 0, 0.30),
)


@dataclass(frozen=True)
class Factor:
    code: str
    title: str  # что оценивали
    value: str  # значение простыми словами
    points: int
    client_text: str  # как фактор звучит для клиента
    tip: str | None = None  # что можно улучшить

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class ScoreResult:
    method: str
    version: str
    score: int
    grade: str
    probability_default: float
    factors: tuple[Factor, ...]

    @property
    def negatives(self) -> list[Factor]:
        return sorted((f for f in self.factors if f.points < 0), key=lambda f: f.points)

    @property
    def positives(self) -> list[Factor]:
        return sorted((f for f in self.factors if f.points > 0), key=lambda f: -f.points)


def _years(value: float) -> str:
    n = int(value)
    if n == 0:
        return "меньше года"
    last, last2 = n % 10, n % 100
    word = "год" if last == 1 and last2 != 11 else "года" if 2 <= last <= 4 and not 12 <= last2 <= 14 else "лет"
    return f"{n} {word}"


def _age(f: Features) -> Factor:
    age = f.business_age_years
    if age is None:
        return Factor("business_age", "Срок работы бизнеса", "нет данных", 0, "Срок работы бизнеса неизвестен")
    value = _years(age)
    if age < 1:
        return Factor("business_age", "Срок работы бизнеса", value, -15, "Бизнесу меньше года",
                      "После первого года работы условия станут лучше")
    if age < 3:
        return Factor("business_age", "Срок работы бизнеса", value, 0, f"Бизнес работает {value}")
    if age < 5:
        return Factor("business_age", "Срок работы бизнеса", value, 8, f"Бизнес работает {value}")
    return Factor("business_age", "Срок работы бизнеса", value, 15, f"Компания давно на рынке — {value}")


def _debt_load(f: Features) -> Factor:
    if f.dsr is None:
        return Factor("debt_load", "Кредитная нагрузка", "выручка не подтверждена", 0, "Выручка пока не подтверждена")
    value = f"{f.dsr:.0%} выручки"
    tip = "Уменьшите сумму или увеличьте срок — платёж станет ниже"
    if f.dsr <= 0.2:
        return Factor("debt_load", "Кредитная нагрузка", value, 15, "Платежи по кредитам займут небольшую часть выручки")
    if f.dsr <= 0.35:
        return Factor("debt_load", "Кредитная нагрузка", value, 5, "Кредитная нагрузка умеренная")
    if f.dsr <= 0.5:
        return Factor("debt_load", "Кредитная нагрузка", value, -10, "Платежи по кредитам займут заметную часть выручки", tip)
    return Factor("debt_load", "Кредитная нагрузка", value, -25, "Платежи по кредитам займут больше половины выручки", tip)


def _history(f: Features) -> Factor:
    if not f.has_credit_history:
        return Factor("credit_history", "Кредитная история", "нет кредитов", 5, "Кредитной истории пока нет — это не минус")
    days = f.max_overdue_days_24m
    tip = "Обслуживайте кредиты без просрочек — через 6–12 месяцев оценка улучшится"
    if days == 0:
        return Factor("credit_history", "Кредитная история", "без просрочек", 15, "Кредиты обслуживаются без просрочек")
    if days <= 30:
        return Factor("credit_history", "Кредитная история", f"просрочка до {days} дн.", -5, "Были небольшие просрочки по кредитам", tip)
    if days <= 60:
        return Factor("credit_history", "Кредитная история", f"просрочка до {days} дн.", -15, "Были просрочки по кредитам до двух месяцев", tip)
    return Factor("credit_history", "Кредитная история", f"просрочка до {days} дн.", -25, "Были просрочки по кредитам больше двух месяцев", tip)


def _current_overdue(f: Features) -> Factor | None:
    if f.current_overdue_days <= 0:
        return None
    return Factor("current_overdue", "Текущая просрочка", f"{f.current_overdue_days} дн.", -20,
                  "Сейчас есть просроченный платёж по кредиту", "Погасите текущую просрочку и подайте заявку снова")


def _margin(f: Features) -> Factor:
    if f.margin is None:
        return Factor("margin", "Рентабельность", "нет данных", 0, "Данных о расходах в налоговой нет")
    value = f"{f.margin:.0%}"
    if f.margin > 0.10:
        return Factor("margin", "Рентабельность", value, 10, "Бизнес стабильно прибыльный")
    if f.margin >= 0:
        return Factor("margin", "Рентабельность", value, 3, "Бизнес работает с небольшой прибылью")
    return Factor("margin", "Рентабельность", value, -15, "По данным налоговой бизнес работает в убыток",
                  "Когда бизнес выйдет в плюс, шансы на одобрение вырастут")


def _tax_debt(f: Features) -> Factor | None:
    if f.tax_debt <= 0:
        return None
    return Factor("tax_debt", "Налоговая задолженность", f"{f.tax_debt:,} ₽".replace(",", " "), -10,
                  "Есть задолженность по налогам", "Погасите долг перед налоговой")


def _inquiries(f: Features) -> Factor:
    n = f.inquiries_90d
    if n >= 6:
        return Factor("inquiries", "Обращения за кредитами", f"{n} за 3 месяца", -10,
                      "За последние 3 месяца было много обращений за кредитами в разные банки",
                      "Не подавайте много заявок одновременно")
    if n >= 3:
        return Factor("inquiries", "Обращения за кредитами", f"{n} за 3 месяца", -3, "Было несколько обращений за кредитами")
    return Factor("inquiries", "Обращения за кредитами", f"{n} за 3 месяца", 3, "Компания редко обращается за кредитами")


def _mass_address(f: Features) -> Factor | None:
    if not f.mass_address:
        return None
    return Factor("mass_address", "Адрес регистрации", "массовый", -10, "Компания зарегистрирована по адресу массовой регистрации")


def grade_for(score: int) -> tuple[str, float]:
    for grade, threshold, pd in GRADES:
        if score >= threshold:
            return grade, pd
    return GRADES[-1][0], GRADES[-1][2]


def score(features: Features) -> ScoreResult:
    candidates = [
        _age(features),
        _debt_load(features),
        _history(features),
        _current_overdue(features),
        _margin(features),
        _tax_debt(features),
        _inquiries(features),
        _mass_address(features),
    ]
    factors = tuple(f for f in candidates if f is not None)
    total = max(0, min(100, BASE_SCORE + sum(f.points for f in factors)))
    grade, pd = grade_for(total)
    return ScoreResult("rules", VERSION, total, grade, pd, factors)
