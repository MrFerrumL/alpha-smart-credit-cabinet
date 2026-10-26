"""Граница одобрения по сроку: сколько банк одобрит по тому же продукту на каждом стандартном сроке.

Карта считается теми же функциями скоринга и решения, что и конвейер, на последнем сохранённом снимке признаков.
Для каждой пары «сумма — срок» признаки, которые от них зависят (платёж по запрошенным условиям и нагрузка к
выручке), пересчитываются так же, как при оценке новой заявки в scoring/features.py. Поэтому сумма на карте —
не прогноз, а гарантия: заявку на эти условия конвейер одобрит, пока данные компании в источниках не изменились.
Заявка, решение и журнал не меняются.
"""

from dataclasses import replace

from sqlalchemy.orm import Session

from app.domain.products import PRODUCTS, Product, Purpose, monthly_payment
from app.domain.statuses import Status
from app.models import Application
from app.schemas import ApprovalAlternativeOut, ApprovalMapOut, ApprovalTermOut
from app.scoring import rules
from app.scoring.decision import (
    STEP,
    Decision,
    coverage,
    debt_service_ratio,
    decide,
    grade_rate,
    monthly_profit,
    other_product_terms,
    policy,
    revenue_limit,
    stop_factors,
)
from app.scoring.features import Features
from app.services.applications import latest_offer
from app.services.decisions import latest_scoring

# Сроки, на которые обычно берут кредит; на карту попадают те, что разрешены продуктом, плюс срок заявки, срок
# предложения банка и самый долгий срок продукта (по нему объясняется, почему не проходит ни один). Сроков не больше
# десяти, на каждый — около десяти вызовов decide (двоичный поиск по сумме).
STANDARD_TERMS = (6, 12, 18, 24, 36, 48, 60)
AMOUNT_STEP = STEP  # шаг суммы — тот же, с которым правила решения подбирают сумму


def features_for(f: Features, product: Product, amount: int, term: int) -> Features:
    """Снимок признаков, каким он был бы у заявки на эти сумму и срок. Как в build_features: платёж — по базовой
    ставке продукта, нагрузка — вместе с действующими платежами, с тем же округлением до четырёх знаков."""
    payment = int(monthly_payment(amount, product.rate, term, product.repayment))
    dsr = round((f.existing_payments + payment) / f.revenue_monthly, 4) if f.revenue_monthly else None
    return replace(f, requested_payment=payment, dsr=dsr)


def evaluate(f: Features, product: Product, amount: int, term: int, purpose: Purpose | None) -> Decision:
    """Решение конвейера по заявке на эти сумму и срок: скоринг и правила — на пересчитанном снимке признаков."""
    g = features_for(f, product, amount, term)
    return decide(g, rules.score(g), product, amount, term, purpose)


def _approved(f: Features, product: Product, amount: int, term: int, purpose: Purpose | None) -> Decision | None:
    d = evaluate(f, product, amount, term, purpose)
    return d if d.outcome == Status.APPROVED else None


def candidate_amounts(product: Product, cap: int) -> list[int]:
    """Суммы, среди которых ищется граница: от минимума продукта до cap с шагом подбора суммы, сам cap — тоже."""
    low = product.min_amount
    if cap < low:
        return []
    first = -(-low // AMOUNT_STEP) * AMOUNT_STEP
    return sorted({low, cap, *range(first, cap + 1, AMOUNT_STEP)})


def boundary(
    f: Features, product: Product, cap: int, term: int, purpose: Purpose | None
) -> tuple[int, Decision] | None:
    """Наибольшая сумма не больше cap, которую правила одобряют на этот срок, или None.

    Чем больше сумма, тем выше платёж и нагрузка, а оценка и лимит по выручке от этого только хуже — поэтому
    одобряемые суммы идут подряд от минимума продукта, и границу можно искать двоичным поиском."""
    amounts = candidate_amounts(product, cap)
    if not amounts:
        return None
    top = _approved(f, product, amounts[-1], term, purpose)
    if top is not None:
        return amounts[-1], top
    if len(amounts) == 1:
        return None
    best = _approved(f, product, amounts[0], term, purpose)
    if best is None:
        return None
    lo, hi = 0, len(amounts) - 1  # amounts[lo] одобряется, amounts[hi] — нет
    while hi - lo > 1:
        mid = (lo + hi) // 2
        d = _approved(f, product, amounts[mid], term, purpose)
        if d is not None:
            lo, best = mid, d
        else:
            hi = mid
    return amounts[lo], best


def _rub(value: int) -> str:
    return f"{value:,} ₽".replace(",", " ")


def _months(n: int) -> str:
    last, last2 = n % 10, n % 100
    word = "месяц" if last == 1 and last2 != 11 else "месяца" if 2 <= last <= 4 and not 12 <= last2 <= 14 else "месяцев"
    return f"{n} {word}"


def _lower_first(text: str) -> str:
    """«Были просрочки…» → «были просрочки…»; аббревиатуры («БКИ…») остаются как есть."""
    return text[0].lower() + text[1:] if len(text) > 1 and text[1].islower() else text


def _why_not(g: Features, product: Product, amount: int, term: int, d: Decision) -> str:
    """Почему не проходит самый мягкий вариант — словами для клиента. Проверки и пороги — те же, что у правил."""
    grade = rules.score(g).grade
    if grade == "E":
        return _lower_first(d.reasons[0]) if d.reasons else "оценка заявки ниже порога кредитной политики"
    limit = revenue_limit(g, product, grade)
    if limit is not None and limit < amount:
        return f"по выручке компании этот кредит доступен только до {_rub(limit)}"
    rate = grade_rate(product, grade)
    dsr = debt_service_ratio(g, product, amount, term, rate)
    if dsr is not None and dsr > policy().max_dsr:
        share = f"{dsr * 100:.1f}".replace(".", ",")
        return (
            f"вместе с действующими кредитами платежи займут {share}% выручки, "
            f"а банк допускает не больше {policy().max_dsr:.0%}"
        )
    dscr = coverage(g, product, amount, term, rate)
    if dscr is not None and dscr < policy().min_dscr:
        return (
            f"прибыль бизнеса покроет платёж только в {dscr:.2f} раза, а банку нужен запас — "
            f"хотя бы в {policy().min_dscr:.1f} раза"
        ).replace(".", ",")
    profit = monthly_profit(g)
    if profit is not None and profit <= 0:
        return "по данным налоговой бизнес не приносит прибыли — платёж нечем обслуживать"
    return _lower_first(d.reasons[0]) if d.reasons else "условия не проходят кредитную политику банка"


MAP_STATUSES = frozenset({Status.COUNTER_OFFER, Status.REJECTED})


def _terms_for(product: Product, *extra: int | None) -> list[int]:
    allowed = range(product.min_term, product.max_term + 1)
    return sorted({t for t in STANDARD_TERMS if t in allowed} | {t for t in extra if t is not None and t in allowed})


def approval_map(db: Session, app: Application) -> ApprovalMapOut:
    product = PRODUCTS[app.product_code]
    amount, term = int(app.amount), app.term_months
    offer = latest_offer(db, app)
    offered_term = offer.term_months if offer is not None and offer.product_code == product.code else None
    empty = ApprovalMapOut(
        product_code=product.code,
        product_name=product.name,
        repayment=product.repayment,
        requested_amount=amount,
        requested_term=term,
        offered_term=offered_term,
        terms=[],
        explanation=None,
        alternative=None,
    )
    # Карта нужна, только пока банк предлагает другие условия или отказал; решение специалиста она не оспаривает:
    # он учитывает то, чего нет в правилах.
    if Status(app.status) not in MAP_STATUSES or (app.decision or {}).get("decided_by") == "analyst":
        return empty
    scoring = latest_scoring(db, app)
    try:
        f = Features(**scoring.features) if scoring is not None and scoring.features else None
    except TypeError:  # снимок признаков от другой версии кода
        return empty
    # Без оценки, без выручки и при стоп-факторе другой срок ничего не изменит — карты нет.
    if f is None or f.revenue_monthly is None or stop_factors(f):
        return empty
    terms = _terms_for(product, term, offered_term, product.max_term)
    if not terms:
        return empty
    purpose = Purpose(app.purpose)
    cap = min(amount, product.max_amount)
    try:
        rows = []
        for t in terms:
            found = boundary(f, product, cap, t, purpose)
            offer_terms = found[1].offer if found else None
            rows.append(
                ApprovalTermOut(
                    term_months=t,
                    amount=found[0] if found else None,
                    rate=float(offer_terms.rate) if offer_terms else None,
                    monthly_payment=offer_terms.monthly_payment if offer_terms else None,
                    requested=t == term,
                    offered=t == offered_term,
                )
            )
        if any(r.amount is not None for r in rows):
            return empty.model_copy(update={"terms": rows})

        # Ни один срок не проходит. Почему — по самому мягкому варианту: минимальная сумма на самый долгий срок.
        # Чем срок короче, тем платёж и нагрузка выше, поэтому раз не проходит он — не проходит ни один.
        low, longest = product.min_amount, terms[-1]
        softest = evaluate(f, product, low, longest, purpose)
        if softest.outcome in (Status.MANUAL_REVIEW, Status.APPROVED):
            # При любых условиях решение за специалистом — обещать нечего. Одобрение возможно, только если запрошено
            # меньше минимума продукта, — тогда и объяснять нечего.
            return empty
        why = _why_not(features_for(f, product, low, longest), product, low, longest, softest)
        alt = other_product_terms(f, rules.score(f), product, amount, term, purpose)
    except OverflowError:  # числа в снимке, сохранённом до ограничения сумм, не помещаются в расчёт
        return empty
    alternative = None
    if alt is not None:
        alternative = ApprovalAlternativeOut(
            product_code=alt.product_code,
            product_name=PRODUCTS[alt.product_code].name,
            amount=alt.amount,
            term_months=alt.term_months,
            rate=float(alt.rate),
            monthly_payment=alt.monthly_payment,
        )
    return empty.model_copy(
        update={
            "terms": rows,
            "explanation": f"Даже {_rub(low)} на {_months(longest)} банк не одобрит: {why}",
            "alternative": alternative,
        }
    )
