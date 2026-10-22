"""Кредитное решение: стоп-факторы, правила продукта, лимит, контрпредложение.

Исход не бинарный: одобрение, контрпредложение (меньше сумма или дольше срок), запрос
информации, передача специалисту или отказ — с объяснением для клиента в каждом случае.
"""

from dataclasses import dataclass, field
from decimal import Decimal

from app.domain.products import CATALOGUE, Product, Purpose, monthly_payment
from app.domain.statuses import Status
from app.scoring.features import Features
from app.scoring.rules import ScoreResult

POLICY_VERSION = "policy-1.1"
MAX_DSR = 0.5  # все кредитные платежи — не больше половины выручки
MIN_DSCR = 1.2  # прибыль по данным ФНС покрывает платёж по новому кредиту с запасом 20 %
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


def service_payment(product: Product, amount: int, term: int, rate: Decimal) -> int:
    """Платёж, по которому проверяется посильность. Для продуктов с уплатой только процентов (овердрафт)
    берётся аннуитет на тот же срок — как будто лимит гасится равными долями: иначе возврат всего долга в
    конце срока не попал бы ни в нагрузку, ни в покрытие."""
    return int(monthly_payment(amount, rate, term, "annuity"))


def debt_service_ratio(f: Features, product: Product, amount: int, term: int, rate: Decimal) -> float | None:
    """Доля выручки, которая уйдёт на все кредитные платежи при этих условиях (без округления — для
    сравнения с политикой; округлять только для показа)."""
    if not f.revenue_monthly:
        return None
    return (f.existing_payments + service_payment(product, amount, term, rate)) / f.revenue_monthly


def monthly_profit(f: Features) -> int | None:
    """Прибыль в месяц по данным ФНС (выручка − расходы). Если в налоговой нет расходов, покрытие не считается."""
    if f.revenue_source != "fns" or f.revenue_monthly is None or f.margin is None:
        return None
    return int(f.revenue_monthly * f.margin)


def coverage(f: Features, product: Product, amount: int, term: int, rate: Decimal) -> float | None:
    """Во сколько раз месячная прибыль по ФНС покрывает платёж по новому кредиту.

    Это упрощённый показатель, а не полный DSCR: прибыль по ФНС уже за вычетом процентов по действующим
    кредитам, но погашение их основного долга сюда не входит — его ограничивает нагрузка к выручке (≤ 50 %).
    """
    profit = monthly_profit(f)
    if profit is None:
        return None
    payment = service_payment(product, amount, term, rate)
    return profit / payment if payment else None


def affordability_problem(f: Features, product: Product, amount: int, term: int, rate: Decimal) -> str | None:
    """Почему условия не проходят по политике нагрузки, или None, если проходят. Общая проверка для конвейера
    и для решения аналитика."""
    dsr = debt_service_ratio(f, product, amount, term, rate)
    if dsr is None:
        return "Выручка компании не подтверждена"
    if dsr > MAX_DSR:
        return f"Платежи по кредитам составят {dsr:.0%} выручки при лимите политики {MAX_DSR:.0%}"
    dscr = coverage(f, product, amount, term, rate)
    if dscr is not None and dscr < MIN_DSCR:
        return (
            f"Прибыль по данным ФНС покрывает платёж только в {dscr:.2f} раза при минимуме {MIN_DSCR:.1f}".replace(".", ",")
        )
    profit = monthly_profit(f)
    if profit is not None and profit <= 0:
        return "По данным ФНС бизнес не приносит прибыли — платёж нечем обслуживать"
    return None


def revenue_limit(f: Features, product: Product, grade: str) -> int | None:
    """Лимит по выручке: выручка × множитель продукта × доля по грейду, не больше максимума продукта."""
    if not f.revenue_monthly:
        return None
    raw = f.revenue_monthly * float(product.revenue_multiplier) * LIMIT_SHARE[grade]
    return min(_floor(raw), product.max_amount)


def _floor(value: float) -> int:
    return int(value // STEP * STEP)


def fit_terms(f: Features, s: ScoreResult, product: Product, amount: int, term: int) -> OfferTerms | None:
    """Подбирает условия, которые банк готов предложить: в пределах лимита по выручке, так, чтобы все
    платежи по кредитам были не больше половины выручки, а прибыль покрывала новый платёж с запасом."""
    assert f.revenue_monthly
    revenue = f.revenue_monthly
    rate = grade_rate(product, s.grade)
    limit = revenue_limit(f, product, s.grade)

    def ok(a: int, t: int) -> bool:
        return affordability_problem(f, product, a, t, rate) is None

    new_amount = min(amount, product.max_amount, limit)
    new_term = min(max(term, product.min_term), product.max_term)
    if not ok(new_amount, new_term) and product.repayment == "annuity":
        # Сначала самый короткий срок, при котором условия проходят: клиент не переплачивает лишнего.
        new_term = next((t for t in range(new_term, product.max_term + 1) if ok(new_amount, t)), product.max_term)
    while not ok(new_amount, new_term) and new_amount - STEP >= product.min_amount:
        new_amount -= STEP
    if new_amount < product.min_amount or not ok(new_amount, new_term):
        return None

    explanation = []
    if new_amount < amount:
        if new_amount == product.max_amount and new_amount < limit:
            explanation.append(f"Максимальная сумма по этому продукту — {_money(product.max_amount)}")
        elif new_amount == limit:
            explanation.append(
                f"Сумма ограничена выручкой: при {_money(revenue)} в месяц по этому продукту доступно до {_money(limit)}"
            )
        else:
            explanation.append(
                "Сумма уменьшена, чтобы платежи по кредитам не превышали половины выручки, а прибыль бизнеса "
                "покрывала ежемесячный платёж с запасом"
            )
    if new_term != term:
        explanation.append(f"Срок увеличен до {new_term} мес., чтобы ежемесячный платёж был посильным")
    if rate > product.rate:
        explanation.append(f"Ставка {str(rate).replace('.', ',')}% учитывает оценку заявки")

    payment = int(monthly_payment(new_amount, rate, new_term, product.repayment))
    kind = "approved" if (new_amount, new_term) == (amount, term) else "counter"
    return OfferTerms(kind, product.code, new_amount, new_term, rate, payment, explanation)


def other_product_terms(
    f: Features, s: ScoreResult, product: Product, amount: int, term: int, purpose: Purpose | None
) -> OfferTerms | None:
    """Запрошенный продукт не подходит даже на минимальную сумму — ищем другой продукт под ту же цель,
    который банк готов предложить автоматически. Берём вариант с наибольшей суммой."""
    best: OfferTerms | None = None
    for other in CATALOGUE:
        if other.code == product.code or other.decision != "auto" or (purpose and purpose not in other.purposes):
            continue
        wanted = min(max(amount, other.min_amount), other.max_amount)
        terms = fit_terms(f, s, other, wanted, min(max(term, other.min_term), other.max_term))
        if terms and (best is None or terms.amount > best.amount):
            best = terms
    if best is None:
        return None
    other = next(p for p in CATALOGUE if p.code == best.product_code)
    why = (
        f"По продукту «{product.name}» условия не проходят даже на минимальную сумму — под ваши "
        f"показатели подходит «{other.name}»: {_money(best.amount)} на {best.term_months} мес."
    )
    return OfferTerms("counter", best.product_code, best.amount, best.term_months, best.rate, best.monthly_payment,
                      [why, *best.explanation])


def decide(
    f: Features, s: ScoreResult, product: Product, amount: int, term: int, purpose: Purpose | None = None
) -> Decision:
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

    # Поводы для ручного рассмотрения — по порядку: первый сработавший и есть причина.
    manual = [
        (f.current_overdue_days > 0, "current_overdue",
         "По действующему кредиту есть текущая просрочка — заявку проверит специалист"),
        (f.revenue_source == "statement", "unverified_revenue",
         "Выручка подтверждена только выпиской — специалист сверит её с оборотами по счёту"),
        (f.revenue_source == "fns" and f.margin is None, "no_expenses",
         "В налоговой нет данных о расходах — прибыльность бизнеса оценит специалист"),
        (product.decision == "manual", "manual_product", "По этому продукту решение принимает кредитный специалист"),
        (s.grade in ("C", "D"), "grade", "Заявке нужен взгляд специалиста — автоматической оценки недостаточно"),
    ]
    for triggered, code, reason in manual:
        if triggered:
            return Decision(Status.MANUAL_REVIEW, reasons=[reason], recommendation=recommendation, review_reason=code)

    if terms is None:
        alternative = other_product_terms(f, s, product, amount, term, purpose)
        if alternative is not None:
            return Decision(Status.COUNTER_OFFER, reasons=alternative.explanation, offer=alternative)
        profit = monthly_profit(f)
        if profit is not None and profit <= 0:
            return Decision(
                Status.REJECTED,
                reasons=["По данным налоговой бизнес не приносит прибыли — платёж по кредиту нечем обслуживать"],
                tips=["Когда бизнес выйдет в плюс по итогам года, подайте заявку снова"],
            )
        return Decision(
            Status.REJECTED,
            reasons=["Текущая выручка не позволяет обслуживать кредит даже минимальной суммы по этому продукту"],
            tips=["Попробуйте меньшую сумму или более долгий срок", "Погасите часть действующих кредитов"],
        )

    if terms.kind == "approved":
        why = [x.client_text for x in s.positives[:3]]
        return Decision(Status.APPROVED, reasons=why, offer=OfferTerms(**{**terms.__dict__, "explanation": why}))
    return Decision(Status.COUNTER_OFFER, reasons=terms.explanation, offer=terms, recommendation=recommendation)
