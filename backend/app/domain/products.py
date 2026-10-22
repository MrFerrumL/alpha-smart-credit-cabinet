"""Каталог кредитных продуктов, подбор продукта под задачу клиента и расчёт платежей.

Каталог задан в коде для прототипа; в промышленной версии это версионируемый справочник,
которым управляет продуктовая команда банка.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from enum import StrEnum


class Purpose(StrEnum):
    WORKING_CAPITAL = "working_capital"
    CASH_GAP = "cash_gap"
    EQUIPMENT = "equipment"
    EXPANSION = "expansion"
    CONTRACT = "contract"


@dataclass(frozen=True)
class PurposeInfo:
    title: str
    description: str
    icon: str


PURPOSES: dict[Purpose, PurposeInfo] = {
    Purpose.WORKING_CAPITAL: PurposeInfo(
        "Пополнить оборотные средства", "Закупить товар или сырьё, рассчитаться с поставщиками", "boxes"
    ),
    Purpose.CASH_GAP: PurposeInfo(
        "Закрыть кассовый разрыв", "Платить нужно сейчас, а деньги от клиентов придут позже", "clock"
    ),
    Purpose.EQUIPMENT: PurposeInfo(
        "Купить оборудование или транспорт", "Станки, техника, автомобили для работы", "truck"
    ),
    Purpose.EXPANSION: PurposeInfo(
        "Развить бизнес", "Открыть точку, запустить направление, сделать ремонт", "rocket"
    ),
    Purpose.CONTRACT: PurposeInfo(
        "Исполнить контракт или тендер", "Профинансировать работы до оплаты от заказчика", "contract"
    ),
}


@dataclass(frozen=True)
class Product:
    code: str
    name: str
    tagline: str
    min_amount: int
    max_amount: int
    min_term: int
    max_term: int
    rate: Decimal  # годовая ставка «от», %
    purposes: tuple[Purpose, ...]  # первая цель — основная для продукта
    repayment: str  # annuity | interest_only
    collateral: str | None
    decision: str  # auto | manual
    decision_time: str
    documents: tuple[str, ...]
    highlights: tuple[str, ...]
    # Максимальный лимит относительно среднемесячной выручки — используется правилами решения.
    revenue_multiplier: Decimal = Decimal("1")


CATALOGUE: tuple[Product, ...] = (
    Product(
        code="express",
        name="Экспресс-оборот",
        tagline="Деньги на оборот за 15 минут без залога",
        min_amount=300_000,
        max_amount=10_000_000,
        min_term=3,
        max_term=24,
        rate=Decimal("22.9"),
        purposes=(Purpose.WORKING_CAPITAL, Purpose.CONTRACT, Purpose.CASH_GAP, Purpose.EXPANSION),
        repayment="annuity",
        collateral=None,
        decision="auto",
        decision_time="до 15 минут",
        documents=("Выписка по расчётному счёту за 6 месяцев",),
        highlights=("Без залога и поручителей", "Решение автоматически", "Досрочное погашение без комиссии"),
        revenue_multiplier=Decimal("1.5"),
    ),
    Product(
        code="invest",
        name="Инвестиционный кредит",
        tagline="Крупная сумма на оборудование и развитие",
        min_amount=1_000_000,
        max_amount=50_000_000,
        min_term=12,
        max_term=60,
        rate=Decimal("19.5"),
        purposes=(Purpose.EQUIPMENT, Purpose.EXPANSION),
        repayment="annuity",
        collateral="Залог приобретаемого имущества или поручительство собственника",
        decision="manual",
        decision_time="1–3 рабочих дня",
        documents=(
            "Выписка по расчётному счёту за 12 месяцев",
            "Бухгалтерская отчётность за последний год",
            "Документы по залогу",
        ),
        highlights=("Ставка ниже за счёт залога", "Срок до 5 лет", "Отсрочка первого платежа до 3 месяцев"),
        revenue_multiplier=Decimal("6"),
    ),
    Product(
        code="overdraft",
        name="Овердрафт",
        tagline="Запас денег на счёте на случай кассового разрыва",
        min_amount=100_000,
        max_amount=5_000_000,
        min_term=12,
        max_term=12,
        rate=Decimal("24.9"),
        purposes=(Purpose.CASH_GAP, Purpose.WORKING_CAPITAL),
        repayment="interest_only",
        collateral=None,
        decision="auto",
        decision_time="до 15 минут",
        documents=("Выписка по расчётному счёту за 6 месяцев",),
        highlights=(
            "Проценты только за использованные деньги",
            "Лимит восстанавливается после поступлений",
            "Работает прямо на расчётном счёте",
        ),
        revenue_multiplier=Decimal("0.5"),
    ),
)

PRODUCTS: dict[str, Product] = {p.code: p for p in CATALOGUE}

_RUBLE = Decimal("1")


def _rub(value: Decimal) -> Decimal:
    return value.quantize(_RUBLE, rounding=ROUND_HALF_UP)


def monthly_payment(amount: Decimal | int, rate: Decimal, months: int, repayment: str = "annuity") -> Decimal:
    amount = Decimal(amount)
    r = rate / Decimal(100) / Decimal(12)
    if repayment == "interest_only":
        return _rub(amount * r)
    if r == 0:
        return _rub(amount / months)
    return _rub(amount * r / (1 - (1 + r) ** -months))


@dataclass(frozen=True)
class ScheduleRow:
    n: int
    payment: Decimal
    principal: Decimal
    interest: Decimal
    balance: Decimal


def schedule(amount: Decimal | int, rate: Decimal, months: int, repayment: str = "annuity") -> list[ScheduleRow]:
    balance = Decimal(amount)
    r = rate / Decimal(100) / Decimal(12)
    payment = monthly_payment(balance, rate, months, repayment)
    rows: list[ScheduleRow] = []
    for n in range(1, months + 1):
        interest = _rub(balance * r)
        if repayment == "interest_only":
            principal = balance if n == months else Decimal(0)
        elif n == months:
            principal = balance
        else:
            principal = payment - interest
        balance = balance - principal
        rows.append(ScheduleRow(n, _rub(principal + interest), _rub(principal), interest, _rub(balance)))
    return rows


@dataclass
class ProductMatch:
    product: Product
    fit: str  # best | good | partial
    amount: int
    term_months: int
    monthly_payment: Decimal
    overpayment: Decimal
    reasons: list[str] = field(default_factory=list)
    caveats: list[str] = field(default_factory=list)
    score: int = 0


def _money(value: int) -> str:
    if value >= 1_000_000 and value % 100_000 == 0:
        text = f"{value / 1_000_000:.1f}".rstrip("0").rstrip(".").replace(".", ",")
        return f"{text} млн ₽"
    return f"{value:,} ₽".replace(",", " ")


def match_products(purpose: Purpose, amount: int, term_months: int) -> list[ProductMatch]:
    """Подбирает продукты под цель, сумму и срок. Возвращает их от лучшего к худшему с объяснением,
    почему продукт подходит и что придётся изменить, если параметры выходят за его рамки."""
    matches: list[ProductMatch] = []
    for product in CATALOGUE:
        if purpose not in product.purposes:
            continue
        score = 10 if product.purposes[0] == purpose else 6
        reasons = [f"Подходит, чтобы {PURPOSES[purpose].title.lower()}"]
        caveats: list[str] = []

        fitted_amount = min(max(amount, product.min_amount), product.max_amount)
        if amount < product.min_amount:
            score -= 6
            caveats.append(f"Минимальная сумма — {_money(product.min_amount)}")
        elif amount > product.max_amount:
            score -= 4
            caveats.append(f"Максимальная сумма — {_money(product.max_amount)}")

        fitted_term = min(max(term_months, product.min_term), product.max_term)
        if product.min_term == product.max_term and term_months != product.min_term:
            score -= 1
            caveats.append(f"Лимит открывается на {product.min_term} месяцев с возможностью продления")
        elif fitted_term != term_months:
            score -= 2
            caveats.append(f"Срок — от {product.min_term} до {product.max_term} месяцев")

        if product.collateral is None:
            reasons.append("Без залога и поручителей")
        else:
            reasons.append(f"Нужно обеспечение: {product.collateral.lower()}")
        reasons.append(f"Решение {product.decision_time}")
        if product.repayment == "interest_only":
            reasons.append("Проценты начисляются только на использованную сумму")

        payment = monthly_payment(fitted_amount, product.rate, fitted_term, product.repayment)
        if product.repayment == "interest_only":
            overpayment = payment * fitted_term
        else:
            overpayment = payment * fitted_term - fitted_amount
        matches.append(
            ProductMatch(
                product=product,
                fit="good",
                amount=fitted_amount,
                term_months=fitted_term,
                monthly_payment=payment,
                overpayment=_rub(overpayment),
                reasons=reasons,
                caveats=caveats,
                score=score,
            )
        )

    matches.sort(key=lambda m: (-m.score, m.product.rate))
    for i, m in enumerate(matches):
        m.fit = "best" if i == 0 and not m.caveats else ("partial" if m.caveats else "good")
    return matches
