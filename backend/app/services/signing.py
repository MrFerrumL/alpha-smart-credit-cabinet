"""Предложение банка → договор → подписание кодом в кабинете.

Подпись — простая электронная подпись (смоделирована): одноразовый код показывается в окне подписания
прямо в кабинете (SMS и почта по условиям задачи не используются). В БД хранится только HMAC кода,
связанный с хешем условий договора: подписать можно ровно те условия, которые клиент видел. В
промышленной версии код придёт в мобильный банк или подпись будет УКЭП руководителя — интерфейс запроса
и проверки кода останется тем же.
"""

import hashlib
import hmac
import json
import math
import secrets
from datetime import timedelta, timezone

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_by_id
from app.domain.authority import may_sign
from app.domain.products import PRODUCTS, PURPOSES, Purpose, schedule
from app.domain.statuses import Actor, Status
from app.errors import BusinessValidationError, Conflict, Forbidden, NotFound, TooManyRequests
from app.models import Application, ApplicationEvent, ClientTask, Offer, SigningChallenge, User, utcnow
from app.pipeline.queue import enqueue
from app.schemas import ContractOut, ContractSection, ScheduleRowOut
from app.services.applications import handed_off, user_may_sign
from app.services.notifications import notify_users
from app.services.tasks import BEFORE_ISSUE, open_issue_conditions
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


def _require_signer(user: User, app: Application | None = None) -> None:
    """Подписывает руководитель с правом подписи. Полномочия сверяются с руководителем компании по ЕГРЮЛ:
    сменился директор в реестре — прежний сотрудник подписать уже не сможет."""
    if not user.can_sign:
        raise Forbidden("Принять предложение и подписать договор может только руководитель компании")
    director = app.company.director if app is not None else None
    if not may_sign(user.full_name, user.can_sign, director):
        raise Forbidden(
            f"По данным ЕГРЮЛ руководитель компании — {director}. Подписать договор от её имени может только он"
        )


def handoff_to_signer(db: Session, user: User, app: Application) -> Application:
    """Сотрудник без права подписи (бухгалтер) передаёт предложение руководителю: тому приходит уведомление
    в кабинете, а в журнале остаётся, кто подготовил и кому передал."""
    _require_owner(app, user)
    if user_may_sign(user, app):
        raise Conflict("Вы можете принять предложение сами")
    if app.status not in OFFER_STATUSES:
        raise Conflict("Сейчас нет предложения, которое нужно подписать")
    offer = _require_offer(db, app, "active")
    db.refresh(offer, with_for_update=True)  # два одновременных запроса не пришлют руководителю два уведомления
    if handed_off(db, app, offer):
        raise Conflict("Предложение уже передано руководителю")
    director = app.company.director
    signers = [
        s
        for s in db.scalars(select(User).where(User.company_id == app.company_id, User.can_sign.is_(True)))
        if may_sign(s.full_name, s.can_sign, director)
    ]
    if not signers:
        raise Conflict("В кабинете компании пока нет руководителя с правом подписи — он может подключиться по ИНН")
    notify_users(
        db,
        [s.id for s in signers],
        kind="signature_requested",
        title=f"{user.full_name} просит подписать кредит по заявке № {app.number}",
        body=f"{int(offer.amount):,} ₽ на {offer.term_months} мес. Проверьте условия и примите предложение.".replace(",", " "),
        link=f"/applications/{app.id}",
    )
    record_event(
        db, app, "handed_to_signer", Actor.CLIENT, actor_id=user.id,
        payload={"offer_id": offer.id, "signers": [s.full_name for s in signers]},
    )
    app.updated_at = utcnow()
    db.commit()
    return app


def _require_offer(db: Session, app: Application, *statuses: str) -> Offer:
    offer = current_offer(db, app)
    if offer is None or offer.status not in statuses:
        raise Conflict("Предложение недоступно")
    return offer


def issue_conditions(product) -> list[dict]:
    """Условия выдачи зависят от продукта: для кредита с обеспечением — документы по залогу и поручительство
    собственника. Договор можно подписать сразу, но деньги переводятся только после закрытия условий."""
    if not product.collateral:
        return []
    return [
        {
            "kind": "document",
            "title": "Загрузите документы по залогу",
            "description": "Договор купли-продажи или спецификация имущества и документ об оценке. "
                           "Без них банк не сможет оформить залог и перевести деньги.",
            "payload": {"condition": BEFORE_ISSUE, "document_kind": "collateral"},
        },
        {
            "kind": "question",
            "title": "Подтвердите поручительство собственника",
            "description": "Напишите ФИО собственника, который поручается по кредиту. В промышленной версии — "
                           "отдельный договор поручительства с подписью.",
            "payload": {"condition": BEFORE_ISSUE},
        },
    ]


def _require_valid(offer: Offer) -> None:
    if offer.valid_until and offer.valid_until.replace(tzinfo=None) < utcnow().replace(tzinfo=None):
        raise Conflict("Срок предложения истёк — подайте новую заявку")


def terms_hash(app: Application, offer: Offer) -> str:
    """SHA-256 условий договора и графика платежей в каноническом виде: подпись привязывается к ним."""
    product = PRODUCTS[offer.product_code]
    rows = schedule(offer.amount, offer.rate, offer.term_months, product.repayment)
    terms = {
        "contract_number": offer.contract_number,
        "company_inn": app.company.inn,
        "product_code": offer.product_code,
        "purpose": app.purpose,
        "amount": int(offer.amount),
        "term_months": offer.term_months,
        "rate": str(offer.rate),
        "monthly_payment": int(offer.monthly_payment),
        "schedule": [[r.n, int(r.payment), int(r.principal), int(r.interest)] for r in rows],
    }
    canonical = json.dumps(terms, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def accept_offer(db: Session, user: User, app: Application) -> Offer:
    _require_owner(app, user)
    _require_signer(user, app)
    if app.status not in OFFER_STATUSES:
        raise Conflict("Принять можно только действующее предложение банка")
    offer = _require_offer(db, app, "active")
    _require_valid(offer)
    offer.status = "accepted"
    offer.accepted_at = utcnow()
    offer.contract_number = f"КД-{utcnow().year}-{app.id:06d}"
    for spec in issue_conditions(PRODUCTS[offer.product_code]):
        db.add(ClientTask(application_id=app.id, created_by_type="system", **spec))
    apply_transition(
        db, app, Status.SIGNING, Actor.CLIENT, actor_id=user.id, event="offer_accepted",
        payload={
            "offer_id": offer.id,
            "amount": int(offer.amount),
            "term_months": offer.term_months,
            "terms_hash": terms_hash(app, offer),
        },
    )
    db.commit()
    return offer


def decline_offer(db: Session, user: User, app: Application, comment: str | None) -> Application:
    _require_owner(app, user)
    # Отказ от одобренного кредита — решение руководителя, как и согласие.
    _require_signer(user, app)
    if app.status not in OFFER_STATUSES:
        raise Conflict("Сейчас нет предложения, от которого можно отказаться")
    offer = _require_offer(db, app, "active")
    offer.status = "declined"
    apply_transition(
        db, app, Status.CANCELLED, Actor.CLIENT, actor_id=user.id, event="offer_declined", comment=comment
    )
    db.commit()
    return app


def _signing_key() -> bytes:
    # Отдельный ключ для кодов подписи, выведенный из секрета приложения: токены и коды не делят ключ.
    return hmac.new(get_settings().secret_key.encode(), b"signing-codes", hashlib.sha256).digest()


def _hash(challenge_salt: str, terms: str, code: str) -> str:
    return hmac.new(_signing_key(), f"{challenge_salt}:{terms}:{code}".encode(), hashlib.sha256).hexdigest()


def request_code(db: Session, user: User, app: Application) -> tuple[SigningChallenge, str]:
    """Создаёт одноразовый код. Возвращает его один раз — интерфейс показывает код в окне подписания."""
    _require_owner(app, user)
    _require_signer(user, app)
    if app.status != Status.SIGNING.value:
        raise Conflict("Договор сейчас не ждёт подписи")
    offer = _require_offer(db, app, "accepted")
    _require_valid(offer)
    settings = get_settings()
    now = utcnow()
    recent, oldest = db.execute(
        select(func.count(SigningChallenge.id), func.min(SigningChallenge.created_at)).where(
            SigningChallenge.application_id == app.id,
            SigningChallenge.created_at > now - timedelta(hours=1),
        )
    ).one()
    if recent >= settings.signing_codes_per_hour:
        # Окно скользящее: новый код можно запросить, когда самому раннему из последних кодов исполнится час.
        oldest = oldest if oldest.tzinfo else oldest.replace(tzinfo=timezone.utc)  # SQLite отдаёт время без пояса
        wait = oldest + timedelta(hours=1) - now
        minutes = max(1, math.ceil(wait.total_seconds() / 60))
        raise TooManyRequests(f"Слишком много запросов кода. Новый код можно запросить через {minutes} мин.")
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
    challenge.code_hash = _hash(str(challenge.id), terms_hash(app, offer), code)
    notify_users(
        db,
        [user.id],
        kind="signing_code",
        title="Код для подписания договора готов",
        body=f"Договор {offer.contract_number} на {int(offer.amount):,} ₽. Код показан в окне подписания и "
        f"действует {settings.signing_code_ttl_s // 60} минут. Никому его не сообщайте.".replace(",", " "),
        link=f"/applications/{app.id}",
    )
    record_event(db, app, "signing_code_sent", Actor.CLIENT, actor_id=user.id)
    db.commit()
    return challenge, code


def confirm(db: Session, user: User, app: Application, challenge_id: int, code: str) -> Offer:
    _require_owner(app, user)
    _require_signer(user, app)
    if app.status != Status.SIGNING.value:
        raise Conflict("Договор сейчас не ждёт подписи")
    offer = _require_offer(db, app, "accepted")
    challenge = get_by_id(db, SigningChallenge, challenge_id)
    if challenge is None or challenge.application_id != app.id or challenge.user_id != user.id:
        raise NotFound("Запросите код ещё раз")
    if challenge.used_at is not None or challenge.attempts_left <= 0:
        raise Conflict("Этот код больше не действует — запросите новый")
    if challenge.expires_at.replace(tzinfo=None) < utcnow().replace(tzinfo=None):
        raise Conflict("Срок действия кода истёк — запросите новый")
    _require_valid(offer)
    terms = terms_hash(app, offer)
    if not hmac.compare_digest(challenge.code_hash, _hash(str(challenge.id), terms, code.strip())):
        # Попытка списывается атомарно: параллельные неверные вводы не обходят лимит.
        db.execute(
            update(SigningChallenge)
            .where(SigningChallenge.id == challenge.id, SigningChallenge.attempts_left > 0)
            .values(attempts_left=SigningChallenge.attempts_left - 1)
        )
        record_event(db, app, "signing_code_rejected", Actor.CLIENT, actor_id=user.id)
        db.commit()
        db.refresh(challenge)
        left = challenge.attempts_left
        message = f"Неверный код. Осталось попыток: {left}" if left else "Неверный код. Запросите новый"
        raise BusinessValidationError(message, errors=[{"field": "code", "message": message}])

    # Код погашается условным обновлением: второй параллельный запрос с тем же кодом не пройдёт.
    used = db.execute(
        update(SigningChallenge)
        .where(
            SigningChallenge.id == challenge.id,
            SigningChallenge.used_at.is_(None),
            SigningChallenge.attempts_left > 0,
        )
        .values(used_at=utcnow())
    )
    if used.rowcount != 1:
        db.rollback()
        raise Conflict("Этот код больше не действует — запросите новый")
    offer.status = "signed"
    offer.signed_at = utcnow()
    offer.signed_by_id = user.id
    # Изменение заявки увеличивает её версию: параллельный отзыв заявки получит 409, а не пройдёт молча.
    app.updated_at = utcnow()
    record_event(
        db, app, "contract_signed", Actor.CLIENT, actor_id=user.id,
        payload={
            "contract_number": offer.contract_number,
            "challenge_id": challenge.id,
            "terms_hash": terms,
            "signer_authority": f"руководитель по ЕГРЮЛ: {app.company.director}" if app.company.director else None,
        },
    )
    # Выдачу выполняет конвейер: запрос в АБС с ретраями и идемпотентностью по номеру договора. Если по
    # продукту есть условия выдачи и они не закрыты — выдача начнётся, когда клиент закроет последнее.
    if open_issue_conditions(db, app):
        record_event(db, app, "issue_waiting_conditions", Actor.SYSTEM)
    else:
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
                (
                    "Лимит овердрафта открывается на расчётном счёте Заёмщика в день подписания договора; "
                    "проценты начисляются только на использованную сумму."
                    if product.repayment == "interest_only"
                    else "Денежные средства зачисляются на расчётный счёт Заёмщика после выполнения условий "
                    "выдачи: предоставления документов по залогу и подтверждения поручительства собственника."
                    if issue_conditions(product)
                    else "Денежные средства зачисляются на расчётный счёт Заёмщика в день подписания договора."
                ),
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
                "одноразовым кодом подтверждения. Подпись привязана к хешу условий договора и графика.",
                "В прототипе электронная подпись смоделирована: код показывается в окне подписания.",
            ],
        )
    )
    signer = db.get(User, offer.signed_by_id) if offer.signed_by_id else None
    delayed = offer.status == "signed" and app.status == Status.SIGNING.value and db.scalar(
        select(ApplicationEvent.id)
        .where(ApplicationEvent.application_id == app.id, ApplicationEvent.event == "disbursement_delayed")
        .limit(1)
    ) is not None
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
        terms_hash=terms_hash(app, offer),
        issue_delayed=delayed,
    )
