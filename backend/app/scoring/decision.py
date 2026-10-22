"""Кредитное решение: стоп-факторы, правила продукта, лимит, контрпредложение.

Исход не бинарный: одобрение, контрпредложение (меньше сумма или дольше срок), запрос
информации, передача специалисту или отказ — с объяснением для клиента в каждом случае.
"""

from dataclasses import dataclass, field
from decimal import Decimal

from app.domain.products import Product, monthly_payment
from app.domain.statuses import Status
from app.scoring.features import Features
from app.scoring.rules import ScoreResult

MAX_DSR = 0.5  # все кредитные платежи — не больше половины выручки
STEP = 50_000  # шаг, с которым подбирается сумма

RATE_PREMIUM = {"A": Decimal("0"), "B": Decimal("2"), "C": Decimal("4"), "D": Decimal("6"), "E": Decimal("8")}
LIMIT_SHARE = {"A": 1.0, "B": 0.8, "C": 0.6, "D": 0.4, "E": 0.0}


@dataclass(frozen=True)
class OfferTerms:
    kind: str  # approved | counter
    product_code: str
    amount: int
    term_months: int
    rate: Decimal
    monthly_payment: int
    explanation: list[str]


@dataclass(frozen=True)
class TaskSpec:
    kind: str
    title: str
    description: str
    payload: dict


@dataclass
class Decision:
    outcome: Status
    reasons: list[str]  # для клиента
    tips: list[str] = field(default_factory=list)
    offer: OfferTerms | None = None
    tasks: list[TaskSpec] = field(default_factory=list)
    recommendation: dict | None = None  # для аналитика: какие условия предложил бы конвейер
    stop_factors: list[str] = field(default_factory=list)
    review_reason: str | None = None  # почему заявка ушла специалисту: manual_product | grade


def _money(value: int) -> str:
    if value >= 1_000_000:
        text = f"{value / 1_000_000:.2f}".rstrip("0").rstrip(".").replace(".", ",")
        return f"{text} млн ₽"
    return f"{value:,} ₽".replace(",", " ")


@dataclass(frozen=True)
class StopCheck:
    title: str  # что проверяется — для аналитика
    passed: bool
    client_text: str  # причина отказа для клиента, если проверка не пройдена


def stop_checks(f: Features) -> list[StopCheck]:
    """Стоп-факторы как чек-лист: аналитик видит и пройденные проверки, клиент — только причины отказа."""
    return [
        StopCheck("Компания действующая по ЕГРЮЛ", f.company_status == "active",
                  "Компания находится в стадии ликвидации — таким компаниям банк не выдаёт кредиты"),
        StopCheck("Руководитель не дисквалифицирован", not f.disqualified_director,
                  "Руководитель компании дисквалифицирован"),
        StopCheck("Счета не заблокированы налоговой", not f.blocked_accounts,
                  "Счета компании заблокированы налоговой"),
        StopCheck("Нет текущей просрочки больше 60 дней", f.current_overdue_days <= 60,
                  "Просрочка по действующему кредиту больше 60 дней"),
        StopCheck("Компании больше трёх месяцев",
                  f.business_age_years is None or f.business_age_years >= 0.25,
                  "Компания зарегистрирована меньше трёх месяцев назад"),
    ]


def stop_factors(f: Features) -> list[str]:
    return [check.client_text for check in stop_checks(f) if not check.passed]


def grade_rate(product: Product, grade: str) -> Decimal:
    """Минимальная ставка для грейда: ниже неё условия не может предложить ни конвейер, ни аналитик."""
    return product.rate + RATE_PREMIUM[grade]


def debt_service_ratio(f: Features, product: Product, amount: int, term: int, rate: Decimal) -> float | None:
    """Доля выручки, которая уйдёт на все кредитные платежи при этих условиях (без округления — для
    сравнения с политикой; округлять только для показа)."""
    if not f.revenue_monthly:
        return None
    payment = int(monthly_payment(amount, rate, term, product.repayment))
    return (f.existing_payments + payment) / f.revenue_monthly


def revenue_limit(f: Features, product: Product, grade: str) -> int | None:
    """Лимит по выручке: выручка × множитель продукта × доля по грейду, не больше максимума продукта."""
    if not f.revenue_monthly:
        return None
    raw = f.revenue_monthly * float(product.revenue_multiplier) * LIMIT_SHARE[grade]
    return min(_floor(raw), product.max_amount)


def _floor(value: float) -> int:
    return int(value // STEP * STEP)


def fit_terms(f: Features, s: ScoreResult, product: Product, amount: int, term: int) -> OfferTerms | None:
    """Подбирает условия, которые банк готов предложить: в пределах лимита по выручке и так,
    чтобы все платежи по кредитам были не больше половины выручки."""
    assert f.revenue_monthly
    revenue = f.revenue_monthly
    rate = grade_rate(product, s.grade)
    limit = revenue_limit(f, product, s.grade)

    def dsr(a: int, t: int) -> float:
        return (f.existing_payments + int(monthly_payment(a, rate, t, product.repayment))) / revenue

    new_amount = min(amount, limit)
    new_term = min(max(term, product.min_term), product.max_term)
    if dsr(new_amount, new_term) > MAX_DSR and product.repayment == "annuity":
        new_term = product.max_term
    while dsr(new_amount, new_term) > MAX_DSR and new_amount - STEP >= product.min_amount:
        new_amount -= STEP
    if new_amount < product.min_amount or dsr(new_amount, new_term) > MAX_DSR:
        return None

    explanation = []
    if new_amount < amount:
        if new_amount == limit:
            explanation.append(
                f"Сумма ограничена выручкой: при {_money(revenue)} в месяц по этому продукту доступно до {_money(limit)}"
            )
        else:
            explanation.append("Сумма уменьшена, чтобы платежи по кредитам не превышали половины выручки")
    if new_term != term:
        explanation.append(f"Срок увеличен до {new_term} мес., чтобы ежемесячный платёж был посильным")
    if rate > product.rate:
        explanation.append(f"Ставка {str(rate).replace('.', ',')}% учитывает оценку заявки")

    payment = int(monthly_payment(new_amount, rate, new_term, product.repayment))
    kind = "approved" if (new_amount, new_term) == (amount, term) else "counter"
    return OfferTerms(kind, product.code, new_amount, new_term, rate, payment, explanation)


def decide(f: Features, s: ScoreResult, product: Product, amount: int, term: int) -> Decision:
    stops = stop_factors(f)
    if stops:
        return Decision(Status.REJECTED, reasons=stops, stop_factors=stops)

    if f.revenue_monthly is None:
        return Decision(
            Status.NEEDS_INFO,
            reasons=["В налоговой нет данных о выручке компании — нужна выписка, чтобы её подтвердить"],
            tasks=[
                TaskSpec(
                    "document",
                    "Загрузите выписку по расчётному счёту",
                    "Выписка за последние 6 месяцев из любого банка. По ней мы подтвердим выручку, "
                    "и проверка продолжится автоматически.",
                    {"document_kind": "bank_statement"},
                )
            ],
        )

    negatives = s.negatives
    if s.grade == "E":
        return Decision(
            Status.REJECTED,
            reasons=[x.client_text for x in negatives[:3]],
            tips=[x.tip for x in negatives if x.tip][:3],
        )

    terms = fit_terms(f, s, product, amount, term)
    recommendation = (
        {
            "amount": terms.amount,
            "term_months": terms.term_months,
            "rate": str(terms.rate),
            "monthly_payment": terms.monthly_payment,
        }
        if terms
        else None
    )

    if product.decision == "manual" or s.grade in ("C", "D"):
        reason = (
            "По этому продукту решение принимает кредитный специалист"
            if product.decision == "manual"
            else "Заявке нужен взгляд специалиста — автоматической оценки недостаточно"
        )
        return Decision(
            Status.MANUAL_REVIEW,
            reasons=[reason],
            recommendation=recommendation,
            review_reason="manual_product" if product.decision == "manual" else "grade",
        )

    if terms is None:
        return Decision(
            Status.REJECTED,
            reasons=["Текущая выручка не позволяет обслуживать кредит даже минимальной суммы по этому продукту"],
            tips=["Попробуйте овердрафт или меньшую сумму", "Погасите часть действующих кредитов"],
        )

    if terms.kind == "approved":
        why = [x.client_text for x in s.positives[:3]]
        return Decision(Status.APPROVED, reasons=why, offer=OfferTerms(**{**terms.__dict__, "explanation": why}))
    return Decision(Status.COUNTER_OFFER, reasons=terms.explanation, offer=terms, recommendation=recommendation)
