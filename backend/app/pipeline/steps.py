"""Шаги конвейера. Каждый шаг ожидает заявку в определённом статусе: если статус уже другой
(например, клиент отозвал заявку), шаг пропускается. Поэтому повторный запуск задачи безопасен."""

import logging
from collections.abc import Callable
from datetime import timedelta

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.domain.products import PRODUCTS, Purpose
from app.domain.statuses import LIMIT_OPENED, Actor, Status
from app.models import Application, CheckResult, ClientTask, Document, Loan, Offer, ScoringResult, utcnow
from app.pipeline.queue import enqueue
from app.scoring import rules
from app.scoring.decision import POLICY_VERSION, Decision, decide, explain, snapshot
from app.scoring.features import build_features
from app.services.integrations import ExternalSources, NotInSource, SourceUnavailable
from app.services.state_machine import apply_transition, record_event

log = logging.getLogger("app.pipeline")

SOURCES = ("egrul", "fns", "bki")
SOURCE_TITLES = {"egrul": "ЕГРЮЛ", "fns": "ФНС «Прозрачный бизнес»", "bki": "Бюро кредитных историй"}


class RetryLater(Exception):
    """Шаг нельзя выполнить сейчас (например, источник недоступен) — повторить позже."""


def _delay() -> float:
    return get_settings().pipeline_step_delay_s


def _next(db: Session, app: Application, kind: str) -> None:
    enqueue(db, kind, app.id, delay_s=_delay())


# --- Шаги ----------------------------------------------------------------------------------------


def start(db: Session, app: Application, _: ExternalSources) -> None:
    apply_transition(db, app, Status.VALIDATION, Actor.SYSTEM)
    _next(db, app, "pipeline.validate")


def completeness_tasks(app: Application) -> list[ClientTask]:
    """Проверка полноты анкеты: чего не хватает, чтобы продолжить."""
    form = app.form or {}
    finance = form.get("finance") or {}
    tasks: list[ClientTask] = []
    if not finance.get("monthly_revenue"):
        tasks.append(
            ClientTask(
                kind="field",
                title="Укажите среднемесячную выручку",
                description="Примерная сумма поступлений от клиентов в месяц за последние полгода.",
                payload={"field": "finance.monthly_revenue", "input": "money"},
                created_by_type="system",
            )
        )
    product = PRODUCTS[app.product_code]
    collateral = form.get("collateral") or {}
    if product.collateral and not (collateral.get("kind") or collateral.get("description")):
        tasks.append(
            ClientTask(
                kind="question",
                title="Опишите обеспечение по кредиту",
                description=f"Для этого продукта нужно обеспечение: {product.collateral.lower()}. "
                "Напишите, что можете предложить и примерную стоимость.",
                payload={"field": "collateral.description"},
                created_by_type="system",
            )
        )
    return tasks


def validate(db: Session, app: Application, _: ExternalSources) -> None:
    tasks = completeness_tasks(app)
    if tasks:
        for task in tasks:
            task.application_id = app.id
            db.add(task)
        apply_transition(
            db, app, Status.NEEDS_INFO, Actor.SYSTEM, payload={"tasks": [t.title for t in tasks]}
        )
        app.decision = {"outcome": Status.NEEDS_INFO.value, "reasons": [t.title for t in tasks], "tips": []}
        return
    apply_transition(db, app, Status.ENRICHMENT, Actor.SYSTEM)
    _next(db, app, "pipeline.enrich")


def _checks(db: Session, app: Application) -> dict[str, CheckResult]:
    rows = db.scalars(select(CheckResult).where(CheckResult.application_id == app.id).order_by(CheckResult.id))
    return {row.source: row for row in rows}


def enrich(db: Session, app: Application, sources: ExternalSources) -> None:
    checks = _checks(db, app)
    for source in SOURCES:
        existing = checks.get(source)
        if existing and existing.status == "ok":
            continue
        try:
            data = getattr(sources, source)(app.company.inn)
            status, error = "ok", None
        except NotInSource:
            data, status, error = {}, "ok", "not_found"
        except SourceUnavailable as exc:
            if existing:
                existing.attempts += 1
                existing.error = exc.reason
            else:
                db.add(CheckResult(application_id=app.id, source=source, status="failed", error=exc.reason))
            record_event(db, app, "check_retry", Actor.SYSTEM, payload={"source": source})
            db.commit()
            raise RetryLater(f"{source}: {exc.reason}") from exc
        if existing:
            existing.status, existing.data, existing.error = status, data, error
            existing.attempts += 1
        else:
            db.add(CheckResult(application_id=app.id, source=source, status=status, data=data, error=error))
        record_event(db, app, "check_completed", Actor.SYSTEM, payload={"source": source})
        # Каждый источник фиксируется сразу — клиент видит, как проверка продвигается.
        db.commit()
    apply_transition(db, app, Status.SCORING, Actor.SYSTEM)
    _next(db, app, "pipeline.score")


def enrich_exhausted(db: Session, app: Application, error: str) -> None:
    """Источник так и не ответил: заявка не теряется, а уходит специалисту с пометкой."""
    failed = [SOURCE_TITLES[s] for s, c in _checks(db, app).items() if c.status != "ok"]
    reason = f"Не удалось получить данные: {', '.join(failed) or 'внешний источник'}. Заявку проверит специалист."
    apply_transition(db, app, Status.MANUAL_REVIEW, Actor.SYSTEM, comment=reason, payload={"error": error})
    app.decision = {
        "outcome": Status.MANUAL_REVIEW.value, "reasons": [reason], "tips": [], "review_reason": "source_failure"
    }


def _apply_decision(
    db: Session, app: Application, decision: Decision, result: rules.ScoreResult, trace: list[dict]
) -> None:
    settings = get_settings()
    if decision.offer:
        o = decision.offer
        db.add(
            Offer(
                application_id=app.id,
                kind=o.kind,
                product_code=o.product_code,
                amount=o.amount,
                term_months=o.term_months,
                rate=o.rate,
                monthly_payment=o.monthly_payment,
                explanation=o.explanation,
                valid_until=utcnow() + timedelta(days=settings.offer_valid_days),
            )
        )
    for spec in decision.tasks:
        db.add(
            ClientTask(
                application_id=app.id,
                kind=spec.kind,
                title=spec.title,
                description=spec.description,
                payload=spec.payload,
                created_by_type="system",
            )
        )
    app.decision = {
        "outcome": decision.outcome.value,
        "reasons": decision.reasons,
        "tips": decision.tips,
        "stop_factors": decision.stop_factors,
        "recommendation": decision.recommendation,
        "review_reason": decision.review_reason,
        "policy_version": POLICY_VERSION,
        "trace": trace,
        "pipeline": snapshot(decision, result),
        "grade": result.grade,
        "score": result.score,
    }
    apply_transition(
        db,
        app,
        decision.outcome,
        Actor.SYSTEM,
        payload={"grade": result.grade, "score": result.score, "reasons": decision.reasons},
    )


def _own_loans(db: Session, app: Application) -> tuple[int, int]:
    """Платежи и долг по кредитам, которые этот банк уже выдал компании (погашение не моделируется)."""
    rows = db.execute(
        select(Loan.monthly_payment, Loan.amount).where(Loan.company_id == app.company_id, Loan.status == "active")
    ).all()
    return sum(int(r.monthly_payment) for r in rows), sum(int(r.amount) for r in rows)


def score(db: Session, app: Application, _: ExternalSources) -> None:
    checks = _checks(db, app)
    product = PRODUCTS[app.product_code]
    has_statement = db.scalar(
        select(Document.id).where(Document.application_id == app.id, Document.kind == "bank_statement").limit(1)
    ) is not None
    finance = (app.form or {}).get("finance") or {}
    own_payments, own_debt = _own_loans(db, app)
    features = build_features(
        egrul=checks["egrul"].data,
        fns=checks["fns"].data,
        bki=checks["bki"].data,
        declared_revenue=finance.get("monthly_revenue"),
        has_statement=has_statement,
        product=product,
        amount=int(app.amount),
        term_months=app.term_months,
        own_payments=own_payments,
        own_debt=own_debt,
        declared_debt_payments=finance.get("debt_payments"),
    )
    result = rules.score(features)
    db.add(
        ScoringResult(
            application_id=app.id,
            method=result.method,
            model_version=result.version,
            probability_default=result.probability_default,
            score=result.score,
            grade=result.grade,
            factors=[f.as_dict() for f in result.factors],
            features=features.as_dict(),
        )
    )
    record_event(db, app, "scored", Actor.SYSTEM, payload={"grade": result.grade, "score": result.score})
    decision = decide(features, result, product, int(app.amount), app.term_months, Purpose(app.purpose))
    trace = explain(features, result, product, int(app.amount), app.term_months, decision)
    _apply_decision(db, app, decision, result, trace)


def disburse(db: Session, app: Application, sources: ExternalSources) -> None:
    """Выдача: перевод через АБС, создание кредита с графиком, статус «Деньги зачислены»."""
    from app.services.loans import first_payment_date  # локальный импорт: loans → schemas → без циклов

    offer = db.scalar(select(Offer).where(Offer.application_id == app.id, Offer.status == "signed").limit(1))
    if offer is None:
        return
    open_conditions = db.scalars(
        select(ClientTask).where(ClientTask.application_id == app.id, ClientTask.status == "open")
    )
    if any((t.payload or {}).get("condition") == "before_issue" for t in open_conditions):
        return  # условия выдачи не закрыты: выдачу запустит закрытие последнего условия
    try:
        payment = sources.disburse(
            contract_number=offer.contract_number, inn=app.company.inn, amount=int(offer.amount)
        )
    except SourceUnavailable as exc:
        record_event(db, app, "disbursement_retry", Actor.SYSTEM, payload={"error": exc.reason})
        db.commit()
        raise RetryLater(f"abs: {exc.reason}") from exc

    issued_at = utcnow()
    if db.scalar(select(Loan.id).where(Loan.application_id == app.id)) is None:
        product = PRODUCTS[offer.product_code]
        db.add(
            Loan(
                application_id=app.id,
                company_id=app.company_id,
                contract_number=offer.contract_number,
                product_code=offer.product_code,
                amount=offer.amount,
                rate=offer.rate,
                term_months=offer.term_months,
                monthly_payment=offer.monthly_payment,
                repayment=product.repayment,
                issued_at=issued_at,
                first_payment_date=first_payment_date(issued_at.date()),
                payment_ref=payment["payment_id"],
            )
        )
    limit = PRODUCTS[offer.product_code].repayment == "interest_only"
    apply_transition(
        db, app, Status.ISSUED, Actor.SYSTEM, event="issued",
        payload={"payment_id": payment["payment_id"], "amount": int(offer.amount), "limit": limit},
        info=LIMIT_OPENED if limit else None,
    )


def step_exhausted(db: Session, app: Application, error: str) -> None:
    """Проверка или оценка так и не выполнились (ошибка в данных или коде): заявка уходит специалисту
    с пометкой, а не остаётся навсегда в «Проверяем данные» или «Оцениваем»."""
    reason = "Автоматическая обработка не завершилась — заявку проверит специалист."
    apply_transition(db, app, Status.MANUAL_REVIEW, Actor.SYSTEM, comment=reason, payload={"error": error})
    app.decision = {"outcome": Status.MANUAL_REVIEW.value, "reasons": [reason], "tips": [],
                    "review_reason": "pipeline_failure"}


def disburse_exhausted(db: Session, app: Application, error: str) -> None:
    """АБС долго не отвечает: договор уже подписан, поэтому выдача не отменяется, а продолжает повторяться
    с длинной паузой. Идемпотентность по номеру договора не даст выдать деньги дважды. Если же шаг падает
    по другой причине (ошибка в данных или коде), бесконечно повторять его бессмысленно — сбой фиксируется
    в журнале и разбирается вручную."""
    if not error.startswith("abs:"):
        record_event(db, app, "pipeline_failed", Actor.SYSTEM, payload={"step": "pipeline.disburse", "error": error})
        return
    record_event(db, app, "disbursement_delayed", Actor.SYSTEM, payload={"error": error})
    enqueue(db, "pipeline.disburse", app.id, delay_s=get_settings().disburse_retry_s)


def expire_offers(db: Session) -> int:
    """Закрывает предложения, срок которых истёк: и не принятые, и принятые, но не подписанные. Заявка
    переходит в «Срок истёк». Сбой на одной заявке (например, клиент как раз принял
    предложение) не мешает остальным."""
    now = utcnow()
    query = (
        select(Offer.id, Application.id)
        .join(Application, Application.id == Offer.application_id)
        .where(
            Offer.valid_until < now,
            or_(
                (Offer.status == "active")
                & Application.status.in_((Status.APPROVED.value, Status.COUNTER_OFFER.value)),
                (Offer.status == "accepted") & (Application.status == Status.SIGNING.value),
            ),
        )
    )
    expired = 0
    for offer_id, app_id in db.execute(query).all():
        try:
            offer, app = db.get(Offer, offer_id), db.get(Application, app_id)
            # Между выборкой и загрузкой клиент мог принять или подписать предложение — тогда не трогаем.
            pending = (offer.status == "active" and app.status in (Status.APPROVED.value, Status.COUNTER_OFFER.value)) or (
                offer.status == "accepted" and app.status == Status.SIGNING.value
            )
            if not pending:
                db.rollback()
                continue
            offer.status = "expired"
            apply_transition(db, app, Status.EXPIRED, Actor.SYSTEM)
            db.commit()
            expired += 1
        except Exception:  # noqa: BLE001 — гонка с действием клиента: заявку пропускаем до следующего прохода
            db.rollback()
            log.warning("offer expiry skipped", extra={"status": f"application {app_id}"})
    return expired


def expire_requests(db: Session) -> int:
    """Закрывает заявки, по которым клиент так и не ответил на запрос банка за `NEEDS_INFO_TTL_DAYS`."""
    deadline = utcnow() - timedelta(days=get_settings().needs_info_ttl_days)
    stale = (
        select(ClientTask.application_id)
        .join(Application, Application.id == ClientTask.application_id)
        .where(Application.status == Status.NEEDS_INFO.value, ClientTask.status == "open",
               ClientTask.created_at < deadline)
        .distinct()
    )
    expired = 0
    for app_id in db.scalars(stale).all():
        try:
            app = db.get(Application, app_id)
            if app.status != Status.NEEDS_INFO.value:
                db.rollback()
                continue
            for task in db.scalars(select(ClientTask).where(ClientTask.application_id == app_id,
                                                             ClientTask.status == "open")):
                task.status = "expired"
            apply_transition(db, app, Status.EXPIRED, Actor.SYSTEM,
                             comment="Банк не получил ответ на запрос вовремя — заявка закрыта")
            db.commit()
            expired += 1
        except Exception:  # noqa: BLE001 — гонка с ответом клиента: заявку пропускаем до следующего прохода
            db.rollback()
            log.warning("request expiry skipped", extra={"status": f"application {app_id}"})
    return expired


Step = Callable[[Session, Application, ExternalSources], None]

# Задача → (статус, в котором должна быть заявка, шаг).
STEPS: dict[str, tuple[Status, Step]] = {
    "pipeline.start": (Status.SUBMITTED, start),
    "pipeline.validate": (Status.VALIDATION, validate),
    "pipeline.enrich": (Status.ENRICHMENT, enrich),
    "pipeline.score": (Status.SCORING, score),
    "pipeline.disburse": (Status.SIGNING, disburse),
}

# Что делать, если шаг так и не удалось выполнить за все попытки.
ON_EXHAUSTED: dict[str, Callable[[Session, Application, str], None]] = {
    "pipeline.validate": step_exhausted,
    "pipeline.enrich": enrich_exhausted,
    "pipeline.score": step_exhausted,
    "pipeline.disburse": disburse_exhausted,
}
