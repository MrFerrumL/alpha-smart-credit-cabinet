"""Шаги конвейера. Каждый шаг ожидает заявку в определённом статусе: если статус уже другой
(например, клиент отозвал заявку), шаг пропускается. Поэтому повторный запуск задачи безопасен."""

import logging
from collections.abc import Callable
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.domain.products import PRODUCTS
from app.domain.statuses import Actor, Status
from app.models import Application, CheckResult, ClientTask, Document, Offer, ScoringResult, utcnow
from app.pipeline.queue import enqueue
from app.scoring import rules
from app.scoring.decision import Decision, decide
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
    app.decision = {"outcome": Status.MANUAL_REVIEW.value, "reasons": [reason], "tips": []}


def _apply_decision(db: Session, app: Application, decision: Decision, result: rules.ScoreResult) -> None:
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


def score(db: Session, app: Application, _: ExternalSources) -> None:
    checks = _checks(db, app)
    product = PRODUCTS[app.product_code]
    has_statement = db.scalar(
        select(Document.id).where(Document.application_id == app.id, Document.kind == "bank_statement").limit(1)
    ) is not None
    finance = (app.form or {}).get("finance") or {}
    features = build_features(
        egrul=checks["egrul"].data,
        fns=checks["fns"].data,
        bki=checks["bki"].data,
        declared_revenue=finance.get("monthly_revenue"),
        has_statement=has_statement,
        product=product,
        amount=int(app.amount),
        term_months=app.term_months,
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
    decision = decide(features, result, product, int(app.amount), app.term_months)
    _apply_decision(db, app, decision, result)


Step = Callable[[Session, Application, ExternalSources], None]

# Задача → (статус, в котором должна быть заявка, шаг).
STEPS: dict[str, tuple[Status, Step]] = {
    "pipeline.start": (Status.SUBMITTED, start),
    "pipeline.validate": (Status.VALIDATION, validate),
    "pipeline.enrich": (Status.ENRICHMENT, enrich),
    "pipeline.score": (Status.SCORING, score),
}

# Что делать, если шаг так и не удалось выполнить за все попытки.
ON_EXHAUSTED: dict[str, Callable[[Session, Application, str], None]] = {
    "pipeline.enrich": enrich_exhausted,
}
