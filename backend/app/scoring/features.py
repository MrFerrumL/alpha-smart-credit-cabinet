"""Признаки для оценки: из анкеты клиента и ответов ЕГРЮЛ, ФНС и бюро кредитных историй."""

from dataclasses import asdict, dataclass
from datetime import date

from app.domain.products import Product, monthly_payment


@dataclass(frozen=True)
class Features:
    business_age_years: float | None
    company_status: str  # active | liquidating | ...
    # Выручка в месяц, которой банк доверяет: по данным налоговой или подтверждённая выпиской.
    revenue_monthly: int | None
    revenue_source: str | None  # fns | statement
    declared_revenue_monthly: int | None
    margin: float | None  # (выручка − расходы) / выручка по данным ФНС
    # Платежи по действующим кредитам в месяц, которые учитывает банк: по БКИ вместе с кредитами, уже выданными
    # этим банком, а если клиент указал в анкете больше — заявленные.
    existing_payments: int
    total_debt: int
    has_credit_history: bool
    max_overdue_days_24m: int
    current_overdue_days: int
    current_overdue_amount: int
    inquiries_90d: int
    tax_debt: int
    mass_address: bool
    disqualified_director: bool
    blocked_accounts: bool
    requested_payment: int  # платёж по запрошенным сумме и сроку
    dsr: float | None  # доля выручки, которая уйдёт на все кредитные платежи
    # Заявлено клиентом в анкете. Поле добавлено позже остальных: у сохранённых раньше признаков его нет.
    declared_debt_payments: int | None = None

    def as_dict(self) -> dict:
        return asdict(self)


def _years_since(iso: str | None, today: date) -> float | None:
    if not iso:
        return None
    return round((today - date.fromisoformat(iso)).days / 365.25, 2)


def build_features(
    *,
    egrul: dict,
    fns: dict,
    bki: dict,
    declared_revenue: int | None,
    has_statement: bool,
    product: Product,
    amount: int,
    term_months: int,
    own_payments: int = 0,
    own_debt: int = 0,
    declared_debt_payments: int | None = None,
    today: date | None = None,
) -> Features:
    """own_payments и own_debt — кредиты, уже выданные компании этим банком: эмулятор БКИ о них не знает."""
    today = today or date.today()
    summary = bki.get("summary", {})

    revenue_year = fns.get("revenue")
    if revenue_year:
        revenue, source = revenue_year // 12, "fns"
    elif has_statement and declared_revenue:
        revenue, source = declared_revenue, "statement"
    else:
        revenue, source = None, None

    expenses_year = fns.get("expenses")
    margin = (revenue_year - expenses_year) / revenue_year if revenue_year and expenses_year is not None else None

    # Анкетой нагрузку не занизить: берётся большее из известного банку и заявленного клиентом.
    existing = max(int(summary.get("monthly_payments", 0)) + own_payments, declared_debt_payments or 0)
    payment = int(monthly_payment(amount, product.rate, term_months, product.repayment))

    return Features(
        business_age_years=_years_since(egrul.get("registered_at"), today),
        company_status=egrul.get("status", {}).get("code", "unknown"),
        revenue_monthly=revenue,
        revenue_source=source,
        declared_revenue_monthly=declared_revenue,
        margin=round(margin, 4) if margin is not None else None,
        existing_payments=existing,
        total_debt=int(summary.get("total_balance", 0)) + own_debt,
        has_credit_history=bool(bki.get("loans")),
        max_overdue_days_24m=int(summary.get("max_overdue_days_24m", 0)),
        current_overdue_days=int(summary.get("current_overdue_days", 0)),
        current_overdue_amount=int(summary.get("current_overdue_amount", 0)),
        inquiries_90d=int(summary.get("inquiries_90d", 0)),
        tax_debt=int(fns.get("tax_debt") or 0),
        mass_address=bool(fns.get("mass_address")),
        disqualified_director=bool(fns.get("disqualified_director")),
        blocked_accounts=bool(fns.get("blocked_accounts")),
        requested_payment=payment,
        dsr=round((existing + payment) / revenue, 4) if revenue else None,
        declared_debt_payments=declared_debt_payments,
    )
