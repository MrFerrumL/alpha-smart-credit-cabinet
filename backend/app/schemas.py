"""Контракты API (pydantic). Из них FastAPI собирает OpenAPI-спецификацию (/api/openapi.json)."""

from datetime import date, datetime, timezone
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator

from app.domain.products import Purpose


def _as_utc(value: datetime | None) -> datetime | None:
    # SQLite не хранит часовой пояс: все времена в БД — UTC, отдаём их клиенту явно с зоной.
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


UtcDatetime = Annotated[datetime, AfterValidator(_as_utc)]


class Out(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --- Справочники -----------------------------------------------------------------------------


class StatusInfoOut(BaseModel):
    code: str
    title: str
    hint: str
    stage: int
    tone: str
    action_required: bool
    terminal: bool


class PurposeOut(BaseModel):
    code: Purpose
    title: str
    description: str
    icon: str


class MetaOut(BaseModel):
    stages: list[str]
    statuses: list[StatusInfoOut]
    purposes: list[PurposeOut]


# --- Пользователи и компании -----------------------------------------------------------------


class CompanyOut(Out):
    id: int
    inn: str
    name: str
    short_name: str
    legal_form: str
    ogrn: str | None
    registered_at: date | None
    okved: str | None
    okved_name: str | None
    address: str | None
    director: str | None


class UserOut(Out):
    id: int
    email: str
    full_name: str
    position: str
    role: str
    can_sign: bool
    company: CompanyOut | None


class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=1, max_length=128)


class DemoLoginIn(BaseModel):
    email: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class DemoAccountOut(BaseModel):
    email: str
    full_name: str
    position: str
    role: str
    company_name: str | None
    scenario: str
    scenario_tone: str


class CompanyLookupOut(BaseModel):
    """Карточка компании из ЕГРЮЛ/ЕГРИП — для автозаполнения анкеты."""

    inn: str
    name: str
    short_name: str
    legal_form: str
    ogrn: str | None
    registered_at: date | None
    okved: str | None
    okved_name: str | None
    address: str | None
    director: str | None
    status: str
    status_title: str


class CompanyLinkIn(BaseModel):
    inn: str = Field(pattern=r"^\d{10}(\d{2})?$")


# --- Продукты --------------------------------------------------------------------------------


class ProductOut(BaseModel):
    code: str
    name: str
    tagline: str
    min_amount: int
    max_amount: int
    min_term: int
    max_term: int
    rate: float
    purposes: list[Purpose]
    repayment: str
    collateral: str | None
    decision: str
    decision_time: str
    documents: list[str]
    highlights: list[str]


class MatchIn(BaseModel):
    purpose: Purpose
    amount: int = Field(gt=0, le=1_000_000_000)
    term_months: int = Field(ge=1, le=120)


class MatchOut(BaseModel):
    product: ProductOut
    fit: str
    amount: int
    term_months: int
    monthly_payment: int
    overpayment: int
    reasons: list[str]
    caveats: list[str]


class ScheduleRowOut(BaseModel):
    n: int
    payment: int
    principal: int
    interest: int
    balance: int


class CalcOut(BaseModel):
    product_code: str
    amount: int
    term_months: int
    rate: float
    monthly_payment: int
    overpayment: int
    total: int
    schedule: list[ScheduleRowOut]


# --- Заявки ----------------------------------------------------------------------------------


class FinanceForm(BaseModel):
    monthly_revenue: int | None = Field(default=None, ge=0, description="Среднемесячная выручка, ₽")
    monthly_expenses: int | None = Field(default=None, ge=0, description="Среднемесячные расходы, ₽")
    debt_payments: int | None = Field(default=None, ge=0, description="Платежи по текущим кредитам в месяц, ₽")
    employees: int | None = Field(default=None, ge=0, le=100_000)


class CollateralForm(BaseModel):
    kind: str | None = Field(default=None, description="real_estate | vehicle | equipment | guarantee")
    value: int | None = Field(default=None, ge=0)
    description: str | None = Field(default=None, max_length=1000)


class ApplicationForm(BaseModel):
    finance: FinanceForm = Field(default_factory=FinanceForm)
    collateral: CollateralForm | None = None
    contact_name: str | None = Field(default=None, max_length=255)
    contact_position: str | None = Field(default=None, max_length=255)
    comment: str | None = Field(default=None, max_length=2000)
    consent_bki: bool = Field(default=False, description="Согласие на запрос в бюро кредитных историй")


class ApplicationCreate(BaseModel):
    product_code: str
    purpose: Purpose
    amount: int = Field(gt=0, le=1_000_000_000)
    term_months: int = Field(ge=1, le=120)
    form: ApplicationForm = Field(default_factory=ApplicationForm)


class ApplicationUpdate(BaseModel):
    product_code: str | None = None
    purpose: Purpose | None = None
    amount: int | None = Field(default=None, gt=0, le=1_000_000_000)
    term_months: int | None = Field(default=None, ge=1, le=120)
    form: ApplicationForm | None = None


class CancelIn(BaseModel):
    comment: str | None = Field(default=None, max_length=1000)


class ProductRef(BaseModel):
    code: str
    name: str
    rate: float


class CompanyRef(BaseModel):
    id: int
    inn: str
    name: str


class OfferOut(Out):
    id: int
    kind: str
    product_code: str
    amount: int
    term_months: int
    rate: float
    monthly_payment: int
    explanation: list[str]
    status: str
    valid_until: UtcDatetime | None
    contract_number: str | None
    signed_at: UtcDatetime | None


class DecisionOut(BaseModel):
    """Итог конвейера для клиента: исход, причины и что можно улучшить."""

    outcome: str
    reasons: list[str]
    tips: list[str]


class ApplicationOut(BaseModel):
    id: int
    number: str | None
    status: StatusInfoOut
    product: ProductRef
    purpose: Purpose
    purpose_title: str
    amount: int
    term_months: int
    monthly_payment: int
    form: ApplicationForm
    company: CompanyRef
    allowed_actions: list[str]
    offer: OfferOut | None
    decision: DecisionOut | None
    open_tasks: int
    loan_id: int | None
    awaiting_signer: bool = Field(default=False, description="Предложение передано руководителю на подпись")
    created_at: UtcDatetime
    updated_at: UtcDatetime
    submitted_at: UtcDatetime | None
    decided_at: UtcDatetime | None


class EventOut(BaseModel):
    id: int
    created_at: UtcDatetime
    actor_type: str
    actor_name: str | None
    event: str
    title: str
    from_status: str | None
    to_status: str | None
    comment: str | None
    internal_comment: str | None = Field(default=None, description="Обоснование аналитика — только для банка")


class TaskOut(Out):
    id: int
    kind: str
    title: str
    description: str | None
    status: str
    answer: str | None
    payload: dict | None
    created_at: UtcDatetime
    resolved_at: UtcDatetime | None


class TaskAnswerIn(BaseModel):
    answer: str = Field(min_length=1, max_length=2000)


class DocumentOut(Out):
    id: int
    kind: str
    filename: str
    content_type: str
    size_bytes: int
    created_at: UtcDatetime


class CheckOut(BaseModel):
    source: str
    title: str
    status: str  # ok | failed | pending
    attempts: int
    data: dict | None = None  # только для сотрудников банка


class FinancialsOut(BaseModel):
    """Финансы компании по данным ФНС — для подсказок в анкете."""

    available: bool
    reporting_year: int | None = None
    revenue_monthly: int | None = None
    expenses_monthly: int | None = None
    employees: int | None = None
    tax_regime: str | None = None


class StreamSnapshot(BaseModel):
    """Событие потока статусов: что изменилось в заявке."""

    status: str
    title: str
    tone: str
    terminal: bool
    last_event_id: int
    open_tasks: int


# --- Договор и подписание ------------------------------------------------------------------


class ContractSection(BaseModel):
    title: str
    paragraphs: list[str]


class ContractOut(BaseModel):
    """Кредитный договор в структурированном виде: интерфейс показывает и печатает его."""

    number: str
    date: date
    bank_name: str
    company_name: str
    company_inn: str
    product_name: str
    amount: int
    term_months: int
    rate: float
    monthly_payment: int
    total_payments: int
    sections: list[ContractSection]
    schedule: list[ScheduleRowOut]  # приложение 1: график платежей по условиям предложения
    signed: bool
    signed_at: UtcDatetime | None
    signed_by: str | None
    terms_hash: str = Field(description="SHA-256 условий договора и графика — подпись привязана к нему")
    issue_delayed: bool = Field(description="АБС не ответила — выдача повторяется автоматически")


class SigningCodeOut(BaseModel):
    challenge_id: int
    expires_at: UtcDatetime
    attempts_left: int
    delivery: str = Field(default="in_app", description="Код показывается в окне подписания в кабинете")
    demo_code: str = Field(
        description="Одноразовый код. Электронная подпись смоделирована: вместо SMS код отдаётся в кабинет "
        "один раз и не хранится в открытом виде"
    )


class SignConfirmIn(BaseModel):
    challenge_id: int
    code: str = Field(min_length=4, max_length=12)


# --- Кредиты -------------------------------------------------------------------------------


class LoanScheduleRow(BaseModel):
    n: int
    date: date
    payment: int
    principal: int
    interest: int
    balance: int


class LoanOut(BaseModel):
    id: int
    application_id: int
    contract_number: str
    product_code: str
    product_name: str
    amount: int
    rate: float
    term_months: int
    monthly_payment: int
    issued_at: UtcDatetime
    status: str
    next_payment_date: date | None
    next_payment_amount: int | None
    balance: int
    paid_payments: int
    total_payments: int


class LoanDetailOut(LoanOut):
    schedule: list[LoanScheduleRow]


# --- Уведомления ---------------------------------------------------------------------------


class NotificationOut(Out):
    id: int
    kind: str
    title: str
    body: str | None
    link: str | None
    created_at: UtcDatetime
    read_at: UtcDatetime | None


# --- Кабинет аналитика -----------------------------------------------------------------------


class FactorOut(BaseModel):
    code: str
    title: str
    value: str
    points: int
    client_text: str
    tip: str | None = None


class StopCheckOut(BaseModel):
    title: str
    passed: bool


class TermsOut(BaseModel):
    amount: int
    term_months: int
    rate: float
    monthly_payment: int
    dsr: float | None = Field(description="Доля выручки на все кредитные платежи при этих условиях")
    coverage: float | None = Field(default=None, description="Во сколько раз прибыль по ФНС покрывает новый платёж")


class RevenueOut(BaseModel):
    declared_monthly: int | None = Field(description="Заявлено клиентом в анкете")
    confirmed_monthly: int | None = Field(description="Принято банком: по данным ФНС или подтверждено выпиской")
    source: str | None = Field(description="fns | statement")
    gap_pct: float | None = Field(description="Насколько заявленная выручка выше принятой, %")


class TraceStepOut(BaseModel):
    title: str
    detail: str
    result: str = Field(description="pass | fail | info | triggered")


class AssessmentOut(BaseModel):
    """Всё, что нужно аналитику для решения: почему заявка у него, оценка, стоп-факторы, рекомендация."""

    review_reason: str | None = Field(
        description="manual_product | grade | source_failure | pipeline_failure | other; пусто, если заявка не у специалиста"
    )
    review_reason_title: str | None
    scored: bool
    failed_sources: list[str]
    method: str | None = None
    model_version: str | None = None
    score: int | None = None
    grade: str | None = None
    probability_default: float | None = None
    factors: list[FactorOut] = []
    stop_checks: list[StopCheckOut] = []
    revenue: RevenueOut | None = None
    existing_payments: int | None = None
    monthly_profit: int | None = Field(default=None, description="Прибыль в месяц по данным ФНС")
    requested: TermsOut
    recommendation: TermsOut | None = None
    min_rate: float | None = Field(default=None, description="Минимальная ставка для грейда")
    max_dsr: float
    min_coverage: float = Field(description="Минимальное покрытие платежа прибылью (DSCR)")
    policy_version: str = Field(description="Версия правил кредитного решения")
    authority_limit: int = Field(description="Максимальная сумма, которую аналитик одобряет сам")
    revenue_limit: int | None = Field(default=None, description="Лимит по выручке для грейда")
    repayment: str = Field(description="annuity | interest_only")
    product_limits: dict
    can_decide: bool
    trace: list[TraceStepOut] = Field(default=[], description="Как конвейер принял решение: правила по порядку")


class AnalystDecisionIn(BaseModel):
    outcome: Literal["approve", "counter_offer", "request_info", "reject", "retry_checks"]
    comment: str = Field(min_length=10, max_length=2000, description="Обоснование для журнала аудита, клиент его не видит")
    client_message: str | None = Field(default=None, max_length=1000, description="Что увидит клиент")
    amount: int | None = Field(default=None, gt=0, le=1_000_000_000)
    term_months: int | None = Field(default=None, ge=1, le=120)
    rate: float | None = Field(default=None, gt=0, lt=100)
    reasons: list[Annotated[str, Field(max_length=300)]] = Field(default=[], max_length=5, description="Причины отказа для клиента")
    tips: list[Annotated[str, Field(max_length=300)]] = Field(default=[], max_length=5)

    @field_validator("comment")
    @classmethod
    def _comment_has_content(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 10:
            raise ValueError("Опишите обоснование решения — не короче 10 символов")
        return value
    task_kind: Literal["document", "question"] = "document"
    task_title: str | None = Field(default=None, max_length=255)
    task_description: str | None = Field(default=None, max_length=1000)


# --- Лента новостей --------------------------------------------------------------------------


class FeedItemOut(BaseModel):
    id: str
    published_at: datetime
    title: str
    summary: str
    reasons: list[str] = Field(description="Почему новость показана этому клиенту")
    is_synthetic: bool = Field(description="Новость синтетическая — источник смоделирован")


class ReplayOut(BaseModel):
    """Воспроизведение решения конвейера на сохранённом снимке признаков текущими правилами."""

    matches: bool
    differences: list[str]
    stored: dict | None
    replayed: dict
    policy_version_stored: str | None
    policy_version_current: str


# --- Симулятор политики --------------------------------------------------------------------


class PolicySimulationIn(BaseModel):
    max_dsr: float = Field(ge=0.1, le=0.9, description="Максимальная доля выручки на все кредитные платежи")
    min_coverage: float = Field(ge=0.5, le=3.0, description="Минимальное покрытие нового платежа прибылью")


class SimulatedApplicationOut(BaseModel):
    id: int
    number: str | None
    company: str
    product: str
    status: str = Field(description="Текущий статус заявки — для сравнения с пересчётом")
    requested: int
    outcome_now: str
    outcome_then: str
    offered_now: int
    offered_then: int


class PolicySimulationOut(BaseModel):
    """Что изменилось бы при других порогах политики. Заявки не меняются."""

    applications: int = Field(description="Сколько заявок с сохранённой оценкой пересчитано")
    current: dict
    simulated: dict
    changed: list[SimulatedApplicationOut]
