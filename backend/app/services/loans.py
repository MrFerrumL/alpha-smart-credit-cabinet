"""Выданные кредиты и график платежей по датам."""

import calendar
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_by_id
from app.domain.products import PRODUCTS, schedule
from app.errors import NotFound
from app.models import Loan, User
from app.schemas import LoanDetailOut, LoanOut, LoanScheduleRow


def add_months(start: date, months: int) -> date:
    year = start.year + (start.month - 1 + months) // 12
    month = (start.month - 1 + months) % 12 + 1
    day = min(start.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def first_payment_date(issued: date) -> date:
    return add_months(issued, 1)


def _rows(loan: Loan) -> list[LoanScheduleRow]:
    rows = schedule(loan.amount, loan.rate, loan.term_months, loan.repayment)
    return [
        LoanScheduleRow(
            n=r.n,
            date=add_months(loan.first_payment_date, r.n - 1),
            payment=int(r.payment),
            principal=int(r.principal),
            interest=int(r.interest),
            balance=int(r.balance),
        )
        for r in rows
    ]


def _summary(loan: Loan, rows: list[LoanScheduleRow], today: date) -> LoanOut:
    upcoming = next((r for r in rows if r.date >= today), None)
    paid = [r for r in rows if r.date < today]
    return LoanOut(
        id=loan.id,
        application_id=loan.application_id,
        contract_number=loan.contract_number,
        product_code=loan.product_code,
        product_name=PRODUCTS[loan.product_code].name,
        amount=int(loan.amount),
        rate=float(loan.rate),
        term_months=loan.term_months,
        monthly_payment=int(loan.monthly_payment),
        issued_at=loan.issued_at,
        status=loan.status,
        next_payment_date=upcoming.date if upcoming else None,
        next_payment_amount=upcoming.payment if upcoming else None,
        balance=paid[-1].balance if paid else int(loan.amount),
        paid_payments=len(paid),
        total_payments=sum(r.payment for r in rows),
    )


def list_for(db: Session, user: User, today: date | None = None) -> list[LoanOut]:
    if user.company_id is None:
        return []
    today = today or date.today()
    loans = db.scalars(select(Loan).where(Loan.company_id == user.company_id).order_by(Loan.id.desc()))
    return [_summary(loan, _rows(loan), today) for loan in loans]


def get_for(db: Session, user: User, loan_id: int, today: date | None = None) -> LoanDetailOut:
    loan = get_by_id(db, Loan, loan_id)
    if loan is None or user.role != "client" or loan.company_id != user.company_id:
        raise NotFound("Кредит не найден")
    rows = _rows(loan)
    summary = _summary(loan, rows, today or date.today())
    return LoanDetailOut(**summary.model_dump(), schedule=rows)
