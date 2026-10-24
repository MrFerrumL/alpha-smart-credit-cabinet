from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.config import get_settings
from app.db import get_db
from app.errors import NotFound, Unauthorized
from app.models import User
from app.schemas import DemoAccountOut, DemoLoginIn, LoginIn, TokenOut, UserOut
from app.security import DUMMY_PASSWORD_HASH, create_token, verify_password
from app.seed import DEMO_SCENARIOS

router = APIRouter(prefix="/auth", tags=["Вход"])


def _token(user: User) -> TokenOut:
    return TokenOut(access_token=create_token(user.id, user.role), user=UserOut.model_validate(user))


@router.post("/login", response_model=TokenOut, summary="Вход по почте и паролю")
def login(data: LoginIn, db: Session = Depends(get_db)) -> TokenOut:
    user = db.scalar(select(User).where(User.email == data.email.strip().lower()))
    # Пароль проверяется и для неизвестной почты: по времени ответа не понять, есть ли такой пользователь.
    valid = verify_password(data.password, user.password_hash if user is not None else DUMMY_PASSWORD_HASH)
    if user is None or not valid:
        raise Unauthorized("Неверная почта или пароль")
    return _token(user)


@router.get("/demo-accounts", response_model=list[DemoAccountOut], summary="Тестовые учётки (только в демо-режиме)")
def demo_accounts(db: Session = Depends(get_db)) -> list[DemoAccountOut]:
    if not get_settings().demo_mode:
        return []
    users = {u.email: u for u in db.scalars(select(User).where(User.email.in_(DEMO_SCENARIOS)))}
    result = []
    for email, scenario in DEMO_SCENARIOS.items():
        user = users.get(email)
        if user is None:
            continue
        result.append(
            DemoAccountOut(
                email=email,
                full_name=user.full_name,
                position=user.position,
                role=user.role,
                company_name=user.company.short_name if user.company else None,
                scenario=scenario.scenario,
                scenario_tone=scenario.scenario_tone,
            )
        )
    return result


@router.post("/demo-login", response_model=TokenOut, summary="Вход в один клик под тестовой учёткой")
def demo_login(data: DemoLoginIn, db: Session = Depends(get_db)) -> TokenOut:
    if not get_settings().demo_mode or data.email not in DEMO_SCENARIOS:
        raise NotFound("Демо-вход недоступен")
    user = db.scalar(select(User).where(User.email == data.email))
    if user is None:
        raise NotFound("Демо-вход недоступен")
    return _token(user)


@router.get("/me", response_model=UserOut, summary="Текущий пользователь")
def me(user: User = Depends(get_current_user)) -> User:
    return user
