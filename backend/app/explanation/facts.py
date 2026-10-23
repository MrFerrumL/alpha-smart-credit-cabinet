"""Данные решения для пояснения: только то, что клиент уже видит на экране решения.

Белый список: продукт и условия — из каталога и предложения банка, причины и подсказки — из автоматического
решения (это шаблоны банка, числа в них подставляет код). Название компании, реквизиты, руководитель, всё, что
клиент вписал свободным текстом, балл, грейд и пороги политики сюда не попадают, поэтому модель о них не узнаёт
и подменить ей инструкции через поле анкеты нельзя.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.products import PRODUCTS
from app.domain.statuses import Status
from app.models import Application, Offer

OUTCOMES = frozenset({Status.APPROVED.value, Status.COUNTER_OFFER.value, Status.REJECTED.value})
MAX_REASONS = 6
MAX_TIPS = 4
MAX_ITEM_CHARS = 300
_INVISIBLE = re.compile(r"[\x00-\x1f\x7f​-‏ -‮⁠-⁤﻿]")
NBSP = " "


@dataclass(frozen=True)
class OfferFacts:
    product_name: str
    amount: int
    term_months: int
    rate: str  # «22,9» — как в интерфейсе
    payment: int  # платёж в месяц; у овердрафта — проценты в месяц
    interest_only: bool
    collateral: bool


@dataclass(frozen=True)
class Facts:
    outcome: str  # approved | counter_offer | rejected
    requested_product: str
    requested_amount: int
    requested_term: int
    offer: OfferFacts | None
    reasons: tuple[str, ...]
    tips: tuple[str, ...]

    def as_dict(self) -> dict:
        return asdict(self)


def eligible(decision: dict | None) -> bool:
    """Пояснение — только к автоматическому одобрению, контрпредложению и отказу не по стоп-фактору.
    Решение аналитика объясняет он сам, а отказ по стоп-фактору уже называет юридическую причину."""
    if not decision or decision.get("outcome") not in OUTCOMES:
        return False
    return decision.get("decided_by") != "analyst" and not decision.get("stop_factors")


def build_facts(db: Session, app: Application) -> Facts | None:
    """Данные для модели из базы; None — решение не подходит или предложения уже нет."""
    decision = app.decision
    if not eligible(decision):
        return None
    offer = None
    if decision["outcome"] != Status.REJECTED.value:
        row = db.scalar(
            select(Offer)
            .where(Offer.application_id == app.id, Offer.status == "active")
            .order_by(Offer.id.desc())
            .limit(1)
        )
        if row is None:
            return None
        offer = offer_facts(row.product_code, int(row.amount), row.term_months, row.rate, int(row.monthly_payment))
    return Facts(
        outcome=decision["outcome"],
        requested_product=PRODUCTS[app.product_code].name,
        requested_amount=int(app.amount),
        requested_term=app.term_months,
        offer=offer,
        reasons=_items(decision.get("reasons"), MAX_REASONS),
        tips=_items(decision.get("tips"), MAX_TIPS),
    )


def offer_facts(product_code: str, amount: int, term_months: int, rate: Decimal, payment: int) -> OfferFacts:
    product = PRODUCTS[product_code]
    return OfferFacts(
        product_name=product.name,
        amount=amount,
        term_months=term_months,
        rate=_rate(rate),
        payment=payment,
        interest_only=product.repayment == "interest_only",
        collateral=product.collateral is not None,
    )


def lead(f: Facts) -> str:
    """Первое предложение пояснения. Его пишет код, а не модель: исход и точные условия из предложения банка."""
    requested = f"{rub(f.requested_amount)} на {f.requested_term} мес."
    if f.outcome == Status.REJECTED.value or f.offer is None:
        return f"Банк отказал в кредите «{f.requested_product}» (вы запрашивали {requested})."
    o = f.offer
    if f.outcome == Status.APPROVED.value:
        return f"Банк одобрил «{o.product_name}» на запрошенных условиях: {_terms(o)}."
    if o.product_name != f.requested_product:
        instead = f"Вместо «{f.requested_product}» на {rub(f.requested_amount)}"
        return f"{instead} банк предлагает «{o.product_name}»: {_terms(o)}."
    return f"Банк готов выдать «{o.product_name}» на других условиях: {_terms(o)} — вы запрашивали {requested}"


def next_step(f: Facts) -> str:
    """Что делать дальше — текст банка; модель пересказывает его, а не придумывает."""
    if f.offer is not None:
        if f.offer.interest_only:
            after = "После подписания банк откроет лимит овердрафта на расчётном счёте."
        elif f.offer.collateral:
            after = (
                "После подписания и оформления залога или поручительства банк переведёт деньги на расчётный счёт."
            )
        else:
            after = "После подписания банк переведёт деньги на расчётный счёт."
        return (
            "Если всё подходит, руководитель компании принимает предложение в кабинете и подписывает договор "
            f"кодом, пока предложение действует. {after}"
        )
    another = "Другой продукт можно подобрать кнопкой «Подобрать другой вариант»."
    if f.tips:
        return f"Выполните рекомендации из раздела «Что можно сделать» и подайте новую заявку. {another}"
    return another


def rub(value: int) -> str:
    """Сумма полностью, как в карточке решения: «3 000 000 ₽» (неразрывные пробелы)."""
    return f"{value:,}".replace(",", NBSP) + f"{NBSP}₽"


def _terms(o: OfferFacts) -> str:
    amount = f"лимит {rub(o.amount)}" if o.interest_only else rub(o.amount)
    payment = f"проценты {rub(o.payment)} в месяц" if o.interest_only else f"платёж {rub(o.payment)} в месяц"
    return f"{amount} на {o.term_months} мес. под {o.rate}% годовых, {payment}"


def _rate(rate: Decimal) -> str:
    # Из PostgreSQL ставка приходит как 22.90, в памяти — 22.9: показываем одинаково.
    return format(Decimal(rate).normalize(), "f").replace(".", ",")


def _items(values: object, limit: int) -> tuple[str, ...]:
    if not isinstance(values, list):
        return ()
    cleaned = (_clean(v) for v in values if isinstance(v, str))
    return tuple(v for v in cleaned if v)[:limit]


def _clean(text: str) -> str:
    return " ".join(_INVISIBLE.sub(" ", text).split())[:MAX_ITEM_CHARS]
