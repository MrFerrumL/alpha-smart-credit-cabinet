"""Контракты API (pydantic). Из них FastAPI собирает OpenAPI-спецификацию (/api/openapi.json)."""

from datetime import date, datetime, timezone
from typing import Annotated

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

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
