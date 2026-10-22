"""Работа кредитного аналитика: карточка заявки и ручное решение.

Аналитик видит, почему заявка пришла к нему, оценку с факторами, стоп-факторы и условия, которые
предложил бы конвейер. Решение проходит через ту же машину состояний и те же правила, что и
автоматическое: стоп-факторы не переопределяются, ставка не ниже ставки грейда, нагрузка не выше
политики банка, сумма в пределах полномочий аналитика. Отклонение от рекомендации конвейера
помечается в журнале аудита, обоснование обязательно и клиенту не показывается.
"""

from datetime import timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.domain.products import PRODUCTS, Product, monthly_payment
from app.domain.statuses import Actor, Status
from app.errors import BusinessValidationError, Conflict, Forbidden
from app.models import Application, CheckResult, ClientTask, Offer, ScoringResult, User, utcnow
from app.pipeline.queue import enqueue
from app.pipeline.steps import SOURCE_TITLES, SOURCES
from app.schemas import AnalystDecisionIn, AssessmentOut, FactorOut, RevenueOut, StopCheckOut, TermsOut
from app.scoring.decision import (
    MAX_DSR,
    MIN_DSCR,
    POLICY_VERSION,
    affordability_problem,
    coverage,
    debt_service_ratio,
    grade_rate,
    monthly_profit,
    revenue_limit,
    stop_checks,
)
from app.scoring.features import Features
from app.services.state_machine import apply_transition

REVIEW_REASONS = {
    "manual_product": "По этому продукту решение всегда принимает специалист",
    "grade": "Оценка в серой зоне (грейд C или D) — автоматического решения недостаточно",
    "source_failure": "Внешний источник не ответил — оценки нет, сначала повторите проверки",
    "pipeline_failure": "Автоматическая обработка не завершилась — оценки нет; разберите заявку вручную",
    "current_overdue": "По действующему кредиту есть текущая просрочка",
    "reorganization": "Компания в процессе реорганизации — проверьте правопреемство",
    "unverified_revenue": "Выручка подтверждена только выпиской — сверьте её с оборотами по счёту",
    "no_expenses": "В налоговой нет данных о расходах — оцените прибыльность по отчётности",
    "other": "Заявка передана специалисту",
}

DEFAULT_CLIENT_MESSAGE = {
    "approve": "Кредитный специалист одобрил заявку на запрошенных условиях.",
    "counter_offer": "Кредитный специалист предлагает другие условия — сравните их с запрошенными.",
    "request_info": "Кредитному специалисту нужна дополнительная информация.",
    "reject": "Кредитный специалист рассмотрел заявку и не смог её одобрить.",
    "retry_checks": "Повторяем проверку данных компании.",
}


def latest_scoring(db: Session, app: Application) -> ScoringResult | None:
    query = select(ScoringResult).where(ScoringResult.application_id == app.id).order_by(ScoringResult.id.desc())
    return db.scalar(query.limit(1))


def _features(scoring: ScoringResult | None) -> Features | None:
    if scoring is None or not scoring.features:
        return None
    return Features(**scoring.features)


def _failed_sources(db: Session, app: Application) -> list[str]:
    rows = db.scalars(select(CheckResult).where(CheckResult.application_id == app.id))
    failed = {row.source for row in rows if row.status == "failed"}
    return [SOURCE_TITLES[s] for s in SOURCES if s in failed]


def _dsr(value: float | None) -> float | None:
    return round(value, 4) if value is not None else None


def _terms(product: Product, f: Features | None, amount: int, term: int, rate: Decimal) -> TermsOut:
    return TermsOut(
        amount=amount,
        term_months=term,
        rate=float(rate),
        monthly_payment=int(monthly_payment(amount, rate, term, product.repayment)),
        dsr=_dsr(debt_service_ratio(f, product, amount, term, rate)) if f else None,
        coverage=round(c, 2) if f and (c := coverage(f, product, amount, term, rate)) is not None else None,
    )


def assessment(db: Session, user: User, app: Application) -> AssessmentOut:
    settings = get_settings()
    product = PRODUCTS[app.product_code]
    scoring = latest_scoring(db, app)
    f = _features(scoring)
    decision = app.decision or {}
    # Причина показывается, только пока заявка у специалиста.
    reason = None
    if app.status == Status.MANUAL_REVIEW.value:
        reason = decision.get("review_reason") or ("source_failure" if scoring is None else "other")
    min_rate = grade_rate(product, scoring.grade) if scoring and scoring.grade != "E" else None
    rec = decision.get("recommendation")
    revenue = None
    if f is not None:
        gap = None
        if f.declared_revenue_monthly and f.revenue_monthly:
            gap = round((f.declared_revenue_monthly / f.revenue_monthly - 1) * 100, 1)
        revenue = RevenueOut(
            declared_monthly=f.declared_revenue_monthly,
            confirmed_monthly=f.revenue_monthly,
            source=f.revenue_source,
            gap_pct=gap,
        )
    return AssessmentOut(
        review_reason=reason,
        review_reason_title=REVIEW_REASONS[reason] if reason else None,
        scored=scoring is not None,
        failed_sources=_failed_sources(db, app),
        method=scoring.method if scoring else None,
        model_version=scoring.model_version if scoring else None,
        score=scoring.score if scoring else None,
        grade=scoring.grade if scoring else None,
        probability_default=(
            float(scoring.probability_default) if scoring and scoring.probability_default is not None else None
        ),
        factors=[FactorOut(**factor) for factor in (scoring.factors if scoring else [])],
        stop_checks=[StopCheckOut(title=c.title, passed=c.passed) for c in stop_checks(f)] if f else [],
        revenue=revenue,
        existing_payments=f.existing_payments if f else None,
        monthly_profit=monthly_profit(f) if f else None,
        requested=_terms(product, f, int(app.amount), app.term_months, min_rate or product.rate),
        recommendation=_terms(product, f, rec["amount"], rec["term_months"], Decimal(rec["rate"])) if rec else None,
        min_rate=float(min_rate) if min_rate is not None else None,
        max_dsr=MAX_DSR,
        min_coverage=MIN_DSCR,
        policy_version=decision.get("policy_version") or ("policy-1.0" if scoring else POLICY_VERSION),
        authority_limit=settings.analyst_authority_limit,
        revenue_limit=revenue_limit(f, product, scoring.grade) if f and scoring else None,
        repayment=product.repayment,
        product_limits={
            "min_amount": product.min_amount,
            "max_amount": product.max_amount,
            "min_term": product.min_term,
            "max_term": product.max_term,
        },
        can_decide=user.role == "analyst" and app.status == Status.MANUAL_REVIEW.value,
    )


def _invalid(field: str, message: str) -> BusinessValidationError:
    return BusinessValidationError(message, errors=[{"field": field, "message": message}])


def _offer_terms(
    data: AnalystDecisionIn, app: Application, product: Product, scoring: ScoringResult, f: Features
) -> tuple[int, int, Decimal]:
    settings = get_settings()
    if data.outcome == "approve":
        if (data.amount and data.amount != int(app.amount)) or (data.term_months and data.term_months != app.term_months):
            raise _invalid("outcome", "Одобрение — на запрошенных условиях. Чтобы изменить сумму или срок, выберите контрпредложение")
        amount, term = int(app.amount), app.term_months
    else:
        if not data.amount or not data.term_months:
            raise _invalid("amount", "Для контрпредложения укажите сумму и срок")
        amount, term = data.amount, data.term_months
        if (amount, term) == (int(app.amount), app.term_months):
            raise _invalid("amount", "Условия совпадают с запрошенными — выберите одобрение")
    if data.outcome == "counter_offer" and amount > int(app.amount):
        raise _invalid("amount", "Контрпредложение не может быть больше запрошенной суммы")
    if not product.min_amount <= amount <= product.max_amount:
        raise _invalid("amount", f"Сумма по продукту — от {product.min_amount:,} до {product.max_amount:,} ₽".replace(",", " "))
    if not product.min_term <= term <= product.max_term:
        raise _invalid("term_months", f"Срок по продукту — от {product.min_term} до {product.max_term} мес.")
    if amount > settings.analyst_authority_limit:
        raise Forbidden(
            f"Сумма выше полномочий аналитика ({settings.analyst_authority_limit:,} ₽) — нужно решение кредитного "
            "комитета".replace(",", " ")
        )
    cap = revenue_limit(f, product, scoring.grade)
    if cap is not None and amount > cap:
        raise _invalid(
            "amount",
            f"Сумма выше лимита по выручке для грейда {scoring.grade}: до {cap:,} ₽".replace(",", " "),
        )
    floor = grade_rate(product, scoring.grade)
    # Ставка хранится с точностью до сотых — платёж считается по той же ставке, что попадёт в договор.
    rate = Decimal(str(data.rate)).quantize(Decimal("0.01")) if data.rate is not None else floor
    if rate < floor:
        raise _invalid("rate", f"Ставка для грейда {scoring.grade} — не ниже {str(floor).replace('.', ',')}%")
    if debt_service_ratio(f, product, amount, term, rate) is None:
        raise Conflict("Выручка компании не подтверждена — запросите выписку")
    problem = affordability_problem(f, product, amount, term, rate)
    if problem:
        raise _invalid("amount", f"{problem}. Уменьшите сумму или увеличьте срок")
    return amount, term, rate


def decide(db: Session, user: User, app: Application, data: AnalystDecisionIn) -> Application:
    if user.role != "analyst":
        raise Forbidden("Решение по заявке принимает кредитный аналитик")
    if app.status != Status.MANUAL_REVIEW.value:
        raise Conflict("Решение уже принято или заявка не на рассмотрении у специалиста")
    product = PRODUCTS[app.product_code]
    scoring = latest_scoring(db, app)
    f = _features(scoring)
    previous = dict(app.decision or {})
    message = (data.client_message or "").strip() or DEFAULT_CLIENT_MESSAGE[data.outcome]
    audit = {"outcome": data.outcome, "internal_comment": data.comment, "analyst_id": user.id,
             "policy_version": POLICY_VERSION}

    if data.outcome == "retry_checks":
        if not _failed_sources(db, app):
            raise Conflict("Все источники уже ответили — повторять проверки не нужно")
        apply_transition(db, app, Status.ENRICHMENT, Actor.ANALYST, actor_id=user.id, event="analyst_decision",
                         comment=message, payload=audit)
        enqueue(db, "pipeline.enrich", app.id)
        db.commit()
        return app

    if data.outcome == "request_info":
        if not data.task_title:
            raise _invalid("task_title", "Опишите, что нужно от клиента")
        task = ClientTask(
            application_id=app.id,
            kind=data.task_kind,
            title=data.task_title,
            description=data.task_description,
            payload={"document_kind": "other"} if data.task_kind == "document" else {},
            created_by_type="analyst",
        )
        db.add(task)
        app.decision = previous | {"outcome": Status.NEEDS_INFO.value, "reasons": [data.task_title], "tips": []}
        apply_transition(db, app, Status.NEEDS_INFO, Actor.ANALYST, actor_id=user.id, event="analyst_decision",
                         comment=message, payload=audit | {"task": data.task_title})
        db.commit()
        return app

    if data.outcome == "reject":
        reasons = [r.strip() for r in data.reasons if r.strip()]
        if not reasons:
            raise _invalid("reasons", "Укажите причину отказа для клиента")
        app.decision = previous | {
            "outcome": Status.REJECTED.value, "reasons": reasons, "tips": [t.strip() for t in data.tips if t.strip()],
            "decided_by": "analyst",
        }
        apply_transition(db, app, Status.REJECTED, Actor.ANALYST, actor_id=user.id, event="analyst_decision",
                         comment=message, payload=audit | {"reasons": reasons})
        db.commit()
        return app

    # Одобрение или контрпредложение — только при готовой оценке и без стоп-факторов.
    if scoring is None or f is None:
        raise Conflict("Оценки ещё нет: сначала повторите проверки во внешних источниках")
    failed = [c.title for c in stop_checks(f) if not c.passed]
    if failed:
        raise _invalid("outcome", f"Не пройден стоп-фактор «{failed[0]}» — одобрить нельзя")
    if scoring.grade == "E":
        raise _invalid("outcome", "Грейд E — за пределами кредитной политики, одобрить нельзя")
    amount, term, rate = _offer_terms(data, app, product, scoring, f)
    payment = int(monthly_payment(amount, rate, term, product.repayment))
    rec = previous.get("recommendation")
    # Без рекомендации конвейер не предложил бы условий вовсе — любое одобрение считается отклонением.
    deviations = ["no_recommendation"] if rec is None else [
        name
        for name, differs in (
            ("amount", amount > rec["amount"]),
            ("term", term != rec["term_months"]),
            ("rate", rate != Decimal(str(rec["rate"]))),
        )
        if differs
    ]
    deviation = bool(deviations)
    kind = "approved" if data.outcome == "approve" else "counter"
    db.add(
        Offer(
            application_id=app.id,
            kind=kind,
            product_code=product.code,
            amount=amount,
            term_months=term,
            rate=rate,
            monthly_payment=payment,
            explanation=[message],
            valid_until=utcnow() + timedelta(days=get_settings().offer_valid_days),
        )
    )
    status = Status.APPROVED if kind == "approved" else Status.COUNTER_OFFER
    app.decision = previous | {"outcome": status.value, "reasons": [message], "tips": [], "decided_by": "analyst"}
    terms = {"amount": amount, "term_months": term, "rate": str(rate), "monthly_payment": payment}
    apply_transition(db, app, status, Actor.ANALYST, actor_id=user.id, event="analyst_decision", comment=message,
                     payload=audit | {"terms": terms, "deviation": deviation, "deviations": deviations, "recommendation": rec})
    db.commit()
    return app
