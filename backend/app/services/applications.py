"""Сценарии работы с заявкой: черновик, редактирование, отправка, отзыв, доступ."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.products import PRODUCTS, PURPOSES, Purpose, monthly_payment
from app.domain.statuses import STATUS_INFO, Actor, Status, can_transition
from app.errors import BusinessValidationError, Conflict, Forbidden, NotFound
from app.models import Application, ApplicationEvent, ClientTask, Loan, Offer, User, utcnow
from app.pipeline.queue import enqueue
from app.pipeline.steps import SOURCE_TITLES
from app.schemas import (
    ApplicationCreate,
    ApplicationForm,
    ApplicationOut,
    ApplicationUpdate,
    CompanyRef,
    DecisionOut,
    EventOut,
    OfferOut,
    ProductRef,
    StatusInfoOut,
)
from app.services.state_machine import apply_transition, record_event

EVENT_TITLES = {
    "created": "Черновик создан",
    "updated": "Анкета обновлена",
    "submitted": "Заявка отправлена в банк",
    "cancelled": "Заявка отозвана",
    "check_completed": "Получены данные: {source}",
    "check_retry": "{source} не ответил — повторяем запрос",
    "scored": "Заявка оценена",
    "task_answered": "Вы ответили на запрос банка",
    "document_uploaded": "Загружен документ «{filename}»",
    "pipeline_failed": "Сбой обработки — заявку проверит специалист",
    "offer_accepted": "Предложение принято — договор готов к подписанию",
    "offer_declined": "Вы отказались от предложения банка",
    "signing_code_sent": "Код для подписи отправлен в уведомления",
    "contract_signed": "Договор подписан",
    "disbursement_retry": "Банковская система не ответила — повторяем перевод",
    "issued": "Деньги зачислены на расчётный счёт",
}


def status_out(status: Status) -> StatusInfoOut:
    info = STATUS_INFO[status]
    return StatusInfoOut(
        code=status.value,
        title=info.title,
        hint=info.hint,
        stage=info.stage,
        tone=info.tone,
        action_required=info.action_required,
        terminal=info.terminal,
    )


def allowed_actions(app: Application, user: User, offer: Offer | None = None) -> list[str]:
    status = Status(app.status)
    actions: list[str] = []
    if user.role == "client" and user.company_id == app.company_id:
        signed = offer is not None and offer.status == "signed"
        if status == Status.DRAFT:
            actions += ["edit", "submit"]
        if status == Status.NEEDS_INFO:
            actions.append("answer_tasks")
        if status in (Status.APPROVED, Status.COUNTER_OFFER) and offer is not None and offer.status == "active":
            if user.can_sign:
                actions.append("accept_offer")
            actions.append("decline_offer")
        if status == Status.SIGNING and user.can_sign and not signed:
            actions.append("sign")
        # После подписи договора отозвать заявку нельзя — деньги уже в пути.
        if can_transition(status, Status.CANCELLED, Actor.CLIENT) and not signed:
            actions.append("cancel")
    if user.role == "analyst" and status == Status.MANUAL_REVIEW:
        actions.append("decide")
    return actions


def latest_offer(db: Session, app: Application) -> Offer | None:
    return db.scalar(select(Offer).where(Offer.application_id == app.id).order_by(Offer.id.desc()).limit(1))


def open_tasks_count(db: Session, app: Application) -> int:
    query = select(ClientTask.id).where(ClientTask.application_id == app.id, ClientTask.status == "open")
    return len(db.scalars(query).all())


def to_out(app: Application, user: User, db: Session) -> ApplicationOut:
    product = PRODUCTS[app.product_code]
    offer = latest_offer(db, app)
    decision = app.decision or None
    return ApplicationOut(
        id=app.id,
        number=app.number,
        status=status_out(Status(app.status)),
        product=ProductRef(code=product.code, name=product.name, rate=float(product.rate)),
        purpose=Purpose(app.purpose),
        purpose_title=PURPOSES[Purpose(app.purpose)].title,
        amount=int(app.amount),
        term_months=app.term_months,
        monthly_payment=int(monthly_payment(app.amount, product.rate, app.term_months, product.repayment)),
        form=ApplicationForm.model_validate(app.form or {}),
        company=CompanyRef(id=app.company.id, inn=app.company.inn, name=app.company.short_name),
        allowed_actions=allowed_actions(app, user, offer),
        offer=OfferOut.model_validate(offer) if offer else None,
        decision=DecisionOut(
            outcome=decision["outcome"], reasons=decision.get("reasons", []), tips=decision.get("tips", [])
        )
        if decision
        else None,
        open_tasks=open_tasks_count(db, app),
        loan_id=db.scalar(select(Loan.id).where(Loan.application_id == app.id)),
        created_at=app.created_at,
        updated_at=app.updated_at,
        submitted_at=app.submitted_at,
        decided_at=app.decided_at,
    )


def event_out(ev: ApplicationEvent) -> EventOut:
    if ev.event in EVENT_TITLES:
        payload = ev.payload or {}
        title = EVENT_TITLES[ev.event].format(
            source=SOURCE_TITLES.get(payload.get("source", ""), "Источник"),
            filename=payload.get("filename", ""),
        )
    elif ev.to_status:
        title = STATUS_INFO[Status(ev.to_status)].title
    else:
        title = ev.event
    return EventOut(
        id=ev.id,
        created_at=ev.created_at,
        actor_type=ev.actor_type,
        actor_name=ev.actor.full_name if ev.actor else None,
        event=ev.event,
        title=title,
        from_status=ev.from_status,
        to_status=ev.to_status,
        comment=ev.comment,
    )


def _require_product(code: str):
    product = PRODUCTS.get(code)
    if product is None:
        raise BusinessValidationError(errors=[{"field": "product_code", "message": "Такого продукта нет"}])
    return product


def validate_for_submit(app: Application) -> None:
    product = PRODUCTS[app.product_code]
    errors: list[dict] = []
    amount = int(app.amount)
    if not product.min_amount <= amount <= product.max_amount:
        errors.append({
            "field": "amount",
            "message": f"Сумма для продукта «{product.name}» — от {product.min_amount:,} до {product.max_amount:,} ₽".replace(",", " "),
        })
    if not product.min_term <= app.term_months <= product.max_term:
        errors.append({
            "field": "term_months",
            "message": f"Срок для продукта «{product.name}» — от {product.min_term} до {product.max_term} мес.",
        })
    if Purpose(app.purpose) not in product.purposes:
        errors.append({"field": "purpose", "message": f"Продукт «{product.name}» не предназначен для этой цели"})
    if not (app.form or {}).get("consent_bki"):
        errors.append({"field": "form.consent_bki", "message": "Нужно согласие на запрос в бюро кредитных историй"})
    if errors:
        raise BusinessValidationError("Заявку нельзя отправить: параметры не подходят под продукт.", errors=errors)


def get_for_user(db: Session, user: User, application_id: int) -> Application:
    app = db.get(Application, application_id)
    if app is None:
        raise NotFound("Заявка не найдена")
    if user.role == "client" and app.company_id != user.company_id:
        raise NotFound("Заявка не найдена")
    if user.role == "analyst" and app.status == Status.DRAFT:
        raise NotFound("Заявка не найдена")
    return app


def list_for_user(db: Session, user: User, status: str | None = None) -> list[Application]:
    query = select(Application).order_by(Application.updated_at.desc(), Application.id.desc())
    if user.role == "client":
        if user.company_id is None:
            return []
        query = query.where(Application.company_id == user.company_id)
    else:
        query = query.where(Application.status != Status.DRAFT.value)
    if status:
        query = query.where(Application.status == status)
    return list(db.scalars(query))


def create_draft(db: Session, user: User, data: ApplicationCreate) -> Application:
    if user.role != "client":
        raise Forbidden("Заявку оформляет клиент")
    if user.company_id is None:
        raise Conflict("Сначала укажите компанию: введите ИНН в профиле")
    _require_product(data.product_code)
    app = Application(
        company_id=user.company_id,
        created_by_id=user.id,
        product_code=data.product_code,
        purpose=data.purpose.value,
        amount=data.amount,
        term_months=data.term_months,
        status=Status.DRAFT.value,
        form=data.form.model_dump(),
    )
    db.add(app)
    db.flush()
    app.number = f"{utcnow().year}-{app.id:06d}"
    record_event(db, app, "created", Actor.CLIENT, actor_id=user.id)
    db.commit()
    return app


def update_draft(db: Session, user: User, app: Application, data: ApplicationUpdate) -> Application:
    if "edit" not in allowed_actions(app, user, latest_offer(db, app)):
        raise Conflict("Редактировать можно только черновик")
    changes = data.model_dump(exclude_unset=True)
    if "product_code" in changes:
        _require_product(changes["product_code"])
    for field in ("product_code", "amount", "term_months"):
        if field in changes:
            setattr(app, field, changes[field])
    if "purpose" in changes:
        app.purpose = Purpose(changes["purpose"]).value
    if data.form is not None:
        app.form = data.form.model_dump()
    # Анкета сохраняется на каждом шаге; подряд идущие сохранения — одно событие в истории.
    last = app.events[-1] if app.events else None
    if last is not None and last.event == "updated" and last.actor_id == user.id:
        fields = set(last.payload.get("fields", [])) | set(changes)
        last.payload = {"fields": sorted(fields)}
        last.created_at = utcnow()
    else:
        record_event(db, app, "updated", Actor.CLIENT, actor_id=user.id, payload={"fields": sorted(changes)})
    db.commit()
    return app


def submit(db: Session, user: User, app: Application, idempotency_key: str | None) -> Application:
    # Повторная отправка с тем же ключом (двойной клик, ретрай сети) возвращает тот же результат.
    if idempotency_key and app.submit_key == idempotency_key:
        return app
    if "submit" not in allowed_actions(app, user, latest_offer(db, app)):
        raise Conflict("Эта заявка уже отправлена")
    validate_for_submit(app)
    app.submit_key = idempotency_key
    apply_transition(db, app, Status.SUBMITTED, Actor.CLIENT, actor_id=user.id, event="submitted")
    # Конвейер ставится в очередь в той же транзакции — шаг не потеряется.
    enqueue(db, "pipeline.start", app.id)
    db.commit()
    return app


def cancel(db: Session, user: User, app: Application, comment: str | None) -> Application:
    if "cancel" not in allowed_actions(app, user, latest_offer(db, app)):
        raise Conflict("Эту заявку уже нельзя отозвать")
    apply_transition(db, app, Status.CANCELLED, Actor.CLIENT, actor_id=user.id, event="cancelled", comment=comment)
    db.commit()
    return app
