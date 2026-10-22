"""Модель данных кредитного конвейера.

Заявка (Application) — центральная сущность. Всё, что с ней происходит, пишется в журнал
ApplicationEvent (аудит и таймлайн для клиента). Результаты внешних проверок, скоринга,
предложения банка, задачи клиенту и документы хранятся отдельными таблицами, чтобы каждый
этап конвейера оставлял воспроизводимый след.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import JSON, Boolean, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

JsonType = JSON().with_variant(JSONB(), "postgresql")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Company(Base):
    __tablename__ = "companies"

    id: Mapped[int] = mapped_column(primary_key=True)
    inn: Mapped[str] = mapped_column(String(12), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255))
    short_name: Mapped[str] = mapped_column(String(255))
    legal_form: Mapped[str] = mapped_column(String(16))  # ООО | ИП
    ogrn: Mapped[str | None] = mapped_column(String(15))
    registered_at: Mapped[date | None] = mapped_column(Date)
    okved: Mapped[str | None] = mapped_column(String(16))
    okved_name: Mapped[str | None] = mapped_column(String(255))
    address: Mapped[str | None] = mapped_column(String(512))
    director: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    users: Mapped[list[User]] = relationship(back_populates="company")


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(255))
    position: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(16))  # client | analyst
    # Право подписи: бухгалтер может готовить заявку, но подписывает договор только руководитель.
    can_sign: Mapped[bool] = mapped_column(Boolean, default=False)
    password_hash: Mapped[str] = mapped_column(String(255))
    company_id: Mapped[int | None] = mapped_column(ForeignKey("companies.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    company: Mapped[Company | None] = relationship(back_populates="users")


class Application(Base):
    __tablename__ = "applications"

    id: Mapped[int] = mapped_column(primary_key=True)
    number: Mapped[str | None] = mapped_column(String(32), unique=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))

    product_code: Mapped[str] = mapped_column(String(32))
    purpose: Mapped[str] = mapped_column(String(32))
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    term_months: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(32), index=True)
    # Анкета: финансы, залог, контактное лицо. Схема описана в app.schemas.ApplicationForm.
    form: Mapped[dict] = mapped_column(JsonType, default=dict)

    # Итог конвейера: исход, причины и подсказки для клиента (см. app.scoring.decision).
    decision: Mapped[dict | None] = mapped_column(JsonType)

    # Ключ идемпотентности отправки: повтор с тем же ключом возвращает уже отправленную заявку.
    submit_key: Mapped[str | None] = mapped_column(String(64))
    version: Mapped[int] = mapped_column(Integer, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Оптимистическая блокировка: параллельные изменения одной заявки не перетирают друг друга.
    __mapper_args__ = {"version_id_col": version}

    company: Mapped[Company] = relationship()
    created_by: Mapped[User] = relationship()
    events: Mapped[list[ApplicationEvent]] = relationship(
        back_populates="application", order_by="ApplicationEvent.id", cascade="all, delete-orphan"
    )


class ApplicationEvent(Base):
    """Журнал аудита: каждое изменение статуса и каждое значимое действие по заявке."""

    __tablename__ = "application_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    application_id: Mapped[int] = mapped_column(ForeignKey("applications.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    actor_type: Mapped[str] = mapped_column(String(16))  # client | analyst | system
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    event: Mapped[str] = mapped_column(String(64))
    from_status: Mapped[str | None] = mapped_column(String(32))
    to_status: Mapped[str | None] = mapped_column(String(32))
    comment: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict] = mapped_column(JsonType, default=dict)

    application: Mapped[Application] = relationship(back_populates="events")
    actor: Mapped[User | None] = relationship()


class CheckResult(Base):
    """Ответ внешнего источника (ЕГРЮЛ, БКИ, ФНС), сохранённый как есть для разбора и аудита."""

    __tablename__ = "check_results"

    id: Mapped[int] = mapped_column(primary_key=True)
    application_id: Mapped[int] = mapped_column(ForeignKey("applications.id"), index=True)
    source: Mapped[str] = mapped_column(String(16))  # egrul | bki | fns
    status: Mapped[str] = mapped_column(String(16))  # ok | failed
    data: Mapped[dict] = mapped_column(JsonType, default=dict)
    error: Mapped[str | None] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ScoringResult(Base):
    __tablename__ = "scoring_results"

    id: Mapped[int] = mapped_column(primary_key=True)
    application_id: Mapped[int] = mapped_column(ForeignKey("applications.id"), index=True)
    method: Mapped[str] = mapped_column(String(16))  # rules | ml
    model_version: Mapped[str] = mapped_column(String(64))
    probability_default: Mapped[Decimal | None] = mapped_column(Numeric(6, 4))
    score: Mapped[int | None] = mapped_column(Integer)
    grade: Mapped[str] = mapped_column(String(2))  # A..E
    factors: Mapped[list] = mapped_column(JsonType, default=list)
    # Признаки, на которых считалась оценка, — чтобы решение можно было воспроизвести.
    features: Mapped[dict | None] = mapped_column(JsonType)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Offer(Base):
    """Условия, которые банк предлагает клиенту: одобрение или контрпредложение."""

    __tablename__ = "offers"

    id: Mapped[int] = mapped_column(primary_key=True)
    application_id: Mapped[int] = mapped_column(ForeignKey("applications.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # approved | counter
    product_code: Mapped[str] = mapped_column(String(32))
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    term_months: Mapped[int] = mapped_column(Integer)
    rate: Mapped[Decimal] = mapped_column(Numeric(5, 2))
    monthly_payment: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    explanation: Mapped[list] = mapped_column(JsonType, default=list)
    # active → accepted (клиент согласился) → signed (договор подписан); либо declined | expired
    status: Mapped[str] = mapped_column(String(16), default="active")
    valid_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    contract_number: Mapped[str | None] = mapped_column(String(32), unique=True)
    signed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    signed_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))


class ClientTask(Base):
    """Запрос банка к клиенту: загрузить документ или ответить на вопрос."""

    __tablename__ = "client_tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    application_id: Mapped[int] = mapped_column(ForeignKey("applications.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # document | field | question
    title: Mapped[str] = mapped_column(String(255))
    # document: {"document_kind": ...}; field: {"field": "finance.monthly_revenue", "input": "money"}
    payload: Mapped[dict | None] = mapped_column(JsonType)
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="open")  # open | done
    answer: Mapped[str | None] = mapped_column(Text)
    created_by_type: Mapped[str] = mapped_column(String(16))  # system | analyst
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    application_id: Mapped[int | None] = mapped_column(ForeignKey("applications.id"), index=True)
    kind: Mapped[str] = mapped_column(String(32))  # bank_statement | financial_report | collateral | contract | other
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(128))
    size_bytes: Mapped[int] = mapped_column(Integer)
    storage_key: Mapped[str] = mapped_column(String(512))
    uploaded_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Job(Base):
    """Очередь задач конвейера в той же БД (transactional outbox): шаг пайплайна не теряется
    при падении воркера и выполняется повторно с задержкой."""

    __tablename__ = "jobs"
    __table_args__ = (Index("ix_jobs_status_run_after", "status", "run_after"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(32))
    application_id: Mapped[int | None] = mapped_column(ForeignKey("applications.id"))
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending | running | done | failed
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    run_after: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class SigningChallenge(Base):
    """Одноразовый код для подписания договора простой электронной подписью.

    Код показывается в окне подписания в кабинете (SMS по условиям задачи не используется) и в открытом
    виде нигде не хранится: в БД — только HMAC кода вместе с хешем условий договора. Новый запрос кода делает
    предыдущий недействительным.
    """

    __tablename__ = "signing_challenges"

    id: Mapped[int] = mapped_column(primary_key=True)
    application_id: Mapped[int] = mapped_column(ForeignKey("applications.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    code_hash: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    attempts_left: Mapped[int] = mapped_column(Integer)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Loan(Base):
    """Выданный кредит. График платежей детерминированно считается из условий и даты выдачи."""

    __tablename__ = "loans"

    id: Mapped[int] = mapped_column(primary_key=True)
    application_id: Mapped[int] = mapped_column(ForeignKey("applications.id"), unique=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    contract_number: Mapped[str] = mapped_column(String(32), unique=True)
    product_code: Mapped[str] = mapped_column(String(32))
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    rate: Mapped[Decimal] = mapped_column(Numeric(5, 2))
    term_months: Mapped[int] = mapped_column(Integer)
    monthly_payment: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    repayment: Mapped[str] = mapped_column(String(16))
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    first_payment_date: Mapped[date] = mapped_column(Date)
    payment_ref: Mapped[str] = mapped_column(String(64))  # номер платежа в АБС
    status: Mapped[str] = mapped_column(String(16), default="active")  # active | closed
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Notification(Base):
    """Уведомление внутри кабинета — вместо SMS и почты."""

    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(32))  # status | signing_code | info
    title: Mapped[str] = mapped_column(String(255))
    body: Mapped[str | None] = mapped_column(Text)
    link: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
