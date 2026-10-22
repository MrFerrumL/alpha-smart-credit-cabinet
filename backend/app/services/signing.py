"""Предложение банка → договор → подписание кодом в кабинете.

Подпись — простая электронная подпись: одноразовый код приходит в уведомления кабинета (SMS по
условиям задачи не используется). В промышленной версии здесь будет подтверждение в мобильном банке
или УКЭП руководителя; интерфейс запроса и проверки кода останется тем же.
"""

import hashlib
import hmac
import secrets
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.config import get_settings
from app.domain.products import PRODUCTS, PURPOSES, Purpose, schedule
from app.domain.statuses import Actor, Status
from app.errors import BusinessValidationError, Conflict, Forbidden, NotFound
from app.models import Application, Offer, SigningChallenge, User, utcnow
from app.pipeline.queue import enqueue
from app.schemas import ContractOut, ContractSection, ScheduleRowOut
from app.services.notifications import notify_users
from app.services.state_machine import apply_transition, record_event

OFFER_STATUSES = (Status.APPROVED.value, Status.COUNTER_OFFER.value)

COLLATERAL_TITLES = {
    "real_estate": "недвижимость",
    "vehicle": "транспорт",
    "equipment": "оборудование",
    "guarantee": "поручительство собственника",
}


def current_offer(db: Session, app: Application) -> Offer | None:
    return db.scalar(select(Offer).where(Offer.application_id == app.id).order_by(Offer.id.desc()).limit(1))


def _require_owner(app: Application, user: User) -> None:
    if user.role != "client" or user.company_id != app.company_id:
        raise NotFound("Заявка не найдена")


def _require_signer(user: User) -> None:
    if not user.can_sign:
        raise Forbidden("Принять предложение и подписать договор может только руководитель компании")


def _require_offer(db: Session, app: Application, *statuses: str) -> Offer:
    offer = current_offer(db, app)
    if offer is None or offer.status not in statuses:
        raise Conflict("Предложение недоступно")
    return offer


def accept_offer(db: Session, user: User, app: Application) -> Offer:
    _require_owner(app, user)
    _require_signer(user)
    if app.status not in OFFER_STATUSES:
        raise Conflict("Принять можно только действующее предложение банка")
    offer = _require_offer(db, app, "active")
    if offer.valid_until and offer.valid_until.replace(tzinfo=None) < utcnow().replace(tzinfo=None):
        raise Conflict("Срок предложения истёк — подайте новую заявку")
    offer.status = "accepted"
    offer.accepted_at = utcnow()
    offer.contract_number = f"КД-{utcnow().year}-{app.id:06d}"
    apply_transition(
        db, app, Status.SIGNING, Actor.CLIENT, actor_id=user.id, event="offer_accepted",
        payload={"offer_id": offer.id, "amount": int(offer.amount), "term_months": offer.term_months},
    )
    db.commit()
    return offer


def decline_offer(db: Session, user: User, app: Application, comment: str | None) -> Application:
    _require_owner(app, user)
    if app.status not in OFFER_STATUSES:
        raise Conflict("Сейчас нет предложения, от которого можно отказаться")
    offer = _require_offer(db, app, "active")
    offer.status = "declined"
    apply_transition(
        db, app, Status.CANCELLED, Actor.CLIENT, actor_id=user.id, event="offer_declined", comment=comment
    )
    db.commit()
    return app


def _hash(challenge_salt: str, code: str) -> str:
    key = get_settings().secret_key.encode()
    return hmac.new(key, f"{challenge_salt}:{code}".encode(), hashlib.sha256).hexdigest()


def request_code(db: Session, user: User, app: Application) -> SigningChallenge:
    _require_owner(app, user)
    _require_signer(user)
    if app.status != Status.SIGNING.value:
        raise Conflict("Договор сейчас не ждёт подписи")
    offer = _require_offer(db, app, "accepted")
    settings = get_settings()
    # Новый код отменяет все прежние.
    db.execute(
        update(SigningChallenge)
        .where(SigningChallenge.application_id == app.id, SigningChallenge.used_at.is_(None))
        .values(attempts_left=0)
    )
    code = f"{secrets.randbelow(1_000_000):06d}"
    challenge = SigningChallenge(
        application_id=app.id,
        user_id=user.id,
        code_hash="",
        expires_at=utcnow() + timedelta(seconds=settings.signing_code_ttl_s),
        attempts_left=settings.signing_max_attempts,
    )
    db.add(challenge)
    db.flush()
    challenge.code_hash = _hash(str(challenge.id), code)
    notify_users(
        db,
        [user.id],
        kind="signing_code",
        title=f"Код для подписания договора: {code}",
        body=f"Договор {offer.contract_number} на {int(offer.amount):,} ₽. Код действует "
        f"{settings.signing_code_ttl_s // 60} минут. Никому его не сообщайте.".replace(",", " "),
        link=f"/applications/{app.id}",
    )
    record_event(db, app, "signing_code_sent", Actor.CLIENT, actor_id=user.id)
    db.commit()
    return challenge


def confirm(db: Session, user: User, app: Application, challenge_id: int, code: str) -> Offer:
    _require_owner(app, user)
    _require_signer(user)
    if app.status != Status.SIGNING.value:
        raise Conflict("Договор сейчас не ждёт подписи")
    offer = _require_offer(db, app, "accepted")
    challenge = db.get(SigningChallenge, challenge_id)
    if challenge is None or challenge.application_id != app.id or challenge.user_id != user.id:
        raise NotFound("Запросите код ещё раз")
    if challenge.used_at is not None or challenge.attempts_left <= 0:
        raise Conflict("Этот код больше не действует — запросите новый")
    if challenge.expires_at.replace(tzinfo=None) < utcnow().replace(tzinfo=None):
        raise Conflict("Срок действия кода истёк — запросите новый")
    if not hmac.compare_digest(challenge.code_hash, _hash(str(challenge.id), code.strip())):
        challenge.attempts_left -= 1
        db.commit()
        left = challenge.attempts_left
        message = f"Неверный код. Осталось попыток: {left}" if left else "Неверный код. Запросите новый"
        raise BusinessValidationError(message, errors=[{"field": "code", "message": message}])

    challenge.used_at = utcnow()
    offer.status = "signed"
    offer.signed_at = utcnow()
    offer.signed_by_id = user.id
    record_event(
        db, app, "contract_signed", Actor.CLIENT, actor_id=user.id,
        payload={"contract_number": offer.contract_number, "challenge_id": challenge.id},
    )
    # Выдачу выполняет конвейер: запрос в АБС с ретраями и идемпотентностью по номеру договора.
    enqueue(db, "pipeline.disburse", app.id, delay_s=get_settings().pipeline_step_delay_s)
    db.commit()
    return offer


def contract(db: Session, app: Application) -> ContractOut:
    offer = current_offer(db, app)
    if offer is None or offer.status not in ("accepted", "signed") or not offer.contract_number:
        raise NotFound("Договор появится после того, как вы примете предложение банка")
    product = PRODUCTS[offer.product_code]
    company = app.company
    rows = schedule(offer.amount, offer.rate, offer.term_months, product.repayment)
    total = sum(r.payment for r in rows)
    rate = f"{float(offer.rate):g}".replace(".", ",")
    money = lambda v: f"{int(v):,} ₽".replace(",", " ")  # noqa: E731

    sections = [
        ContractSection(
            title="1. Стороны",
            paragraphs=[
                f"Кредитор: {get_settings().bank_name}.",
                f"Заёмщик: {company.name}, ИНН {company.inn}"
                + (f", ОГРН {company.ogrn}" if company.ogrn else "")
                + (f", в лице {company.director}" if company.director else "")
                + ".",
            ],
        ),
        ContractSection(
            title="2. Предмет договора",
            paragraphs=[
                f"Кредитор предоставляет Заёмщику кредит «{product.name}» в сумме {money(offer.amount)} "
                f"на срок {offer.term_months} мес. на цель: {PURPOSES[Purpose(app.purpose)].title.lower()}.",
                "Денежные средства зачисляются на расчётный счёт Заёмщика в день подписания договора.",
            ],
        ),
        ContractSection(
            title="3. Проценты и погашение",
            paragraphs=[
                f"Процентная ставка — {rate}% годовых.",
                (
                    f"Заёмщик ежемесячно уплачивает проценты, около {money(offer.monthly_payment)} при полном "
                    "использовании лимита; основной долг погашается в конце срока."
                    if product.repayment == "interest_only"
                    else f"Погашение ежемесячными аннуитетными платежами по {money(offer.monthly_payment)} "
                    "согласно графику платежей (приложение 1)."
                ),
                f"Полная сумма выплат по графику — {money(total)}, из них проценты — {money(total - offer.amount)}.",
                "Досрочное погашение — полностью или частично, без комиссий и ограничений.",
            ],
        ),
    ]
    collateral = (app.form or {}).get("collateral") or {}
    if product.collateral:
        kind = COLLATERAL_TITLES.get(collateral.get("kind") or "", "по согласованию сторон")
        value = collateral.get("value")
        sections.append(
            ContractSection(
                title="4. Обеспечение",
                paragraphs=[
                    f"Обеспечение: {kind}" + (f", оценочная стоимость {money(value)}" if value else "") + ".",
                    "Договор залога или поручительства оформляется отдельно.",
                ],
            )
        )
    sections.append(
        ContractSection(
            title=f"{len(sections) + 1}. Подписание",
            paragraphs=[
                "Договор подписывается простой электронной подписью Заёмщика в личном кабинете: "
                "одноразовым кодом подтверждения.",
            ],
        )
    )
    signer = db.get(User, offer.signed_by_id) if offer.signed_by_id else None
    return ContractOut(
        number=offer.contract_number,
        date=(offer.signed_at or offer.accepted_at or utcnow()).date(),
        bank_name=get_settings().bank_name,
        company_name=company.name,
        company_inn=company.inn,
        product_name=product.name,
        amount=int(offer.amount),
        term_months=offer.term_months,
        rate=float(offer.rate),
        monthly_payment=int(offer.monthly_payment),
        total_payments=int(total),
        sections=sections,
        schedule=[
            ScheduleRowOut(n=r.n, payment=int(r.payment), principal=int(r.principal), interest=int(r.interest), balance=int(r.balance))
            for r in rows
        ],
        signed=offer.status == "signed",
        signed_at=offer.signed_at,
        signed_by=signer.full_name if signer else None,
    )
