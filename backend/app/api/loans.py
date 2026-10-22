from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import require_client
from app.db import get_db
from app.models import User
from app.schemas import LoanDetailOut, LoanOut
from app.services import loans as svc

router = APIRouter(prefix="/loans", tags=["Кредиты"])


@router.get("", response_model=list[LoanOut], summary="Кредиты компании")
def list_loans(user: User = Depends(require_client), db: Session = Depends(get_db)) -> list[LoanOut]:
    return svc.list_for(db, user)


@router.get("/{loan_id}", response_model=LoanDetailOut, summary="Кредит и график платежей")
def get_loan(loan_id: int, user: User = Depends(require_client), db: Session = Depends(get_db)) -> LoanDetailOut:
    return svc.get_for(db, user, loan_id)
