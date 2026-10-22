"""Симулятор изменения кредитной политики на сохранённых заявках.

Риск-менеджер задаёт пороги — максимальную нагрузку к выручке и минимальное покрытие платежа прибылью — и
видит, у каких заявок изменился бы исход и как сдвинулись бы доля одобрений и объём предложений. Расчёт
идёт теми же функциями скоринга и решения, что и в конвейере, на сохранённых снимках признаков. Заявки,
решения и журнал не меняются.
"""

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.domain.products import PRODUCTS, Purpose
from app.domain.statuses import Status
from app.models import Application, ScoringResult
from app.schemas import PolicySimulationIn, PolicySimulationOut, SimulatedApplicationOut
from app.scoring import rules
from app.scoring.decision import decide, policy, policy_override
from app.scoring.features import Features

POSITIVE = {Status.APPROVED.value, Status.COUNTER_OFFER.value}


def _latest_snapshots(db: Session) -> list[tuple[Application, dict]]:
    latest = (
        select(ScoringResult.application_id, func.max(ScoringResult.id).label("id"))
        .group_by(ScoringResult.application_id)
        .subquery()
    )
    rows = db.execute(
        select(Application, ScoringResult.features)
        .options(selectinload(Application.company))
        .join(latest, latest.c.application_id == Application.id)
        .join(ScoringResult, ScoringResult.id == latest.c.id)
        .order_by(Application.id)
    )
    return [(app, features) for app, features in rows if features]


def _offered(decision) -> int:
    """Сумма, которую банк предложил бы: условия предложения, а для специалиста — рекомендация конвейера."""
    if decision.offer is not None:
        return int(decision.offer.amount)
    if decision.recommendation:
        return int(decision.recommendation["amount"])
    return 0


def simulate(db: Session, data: PolicySimulationIn) -> PolicySimulationOut:
    current_params = policy()
    rows, changed = [], []
    for app, snapshot in _latest_snapshots(db):
        try:
            f = Features(**snapshot)
            product = PRODUCTS[app.product_code]
            purpose = Purpose(app.purpose)
        except (TypeError, KeyError, ValueError):  # снимок или справочник от другой версии — пропускаем
            continue
        score = rules.score(f)
        args = (f, score, product, int(app.amount), app.term_months, purpose)
        now = decide(*args)
        with policy_override(max_dsr=data.max_dsr, min_dscr=data.min_coverage):
            then = decide(*args)
        rows.append((now, then))
        if now.outcome != then.outcome or _offered(now) != _offered(then):
            changed.append(
                SimulatedApplicationOut(
                    id=app.id,
                    number=app.number,
                    company=app.company.short_name,
                    status=app.status,
                    product=product.name,
                    requested=int(app.amount),
                    outcome_now=now.outcome.value,
                    outcome_then=then.outcome.value,
                    offered_now=_offered(now),
                    offered_then=_offered(then),
                )
            )

    def summary(index: int) -> dict:
        outcomes = [pair[index].outcome.value for pair in rows]
        counts = {status: outcomes.count(status) for status in sorted(set(outcomes))}
        positive = sum(1 for o in outcomes if o in POSITIVE)
        return {
            "counts": counts,
            "approval_share": round(positive / len(rows), 3) if rows else 0.0,
            "offered_total": sum(_offered(pair[index]) for pair in rows),
        }

    return PolicySimulationOut(
        applications=len(rows),
        current={"max_dsr": current_params.max_dsr, "min_coverage": current_params.min_dscr, **summary(0)},
        simulated={"max_dsr": data.max_dsr, "min_coverage": data.min_coverage, **summary(1)},
        changed=changed,
    )
