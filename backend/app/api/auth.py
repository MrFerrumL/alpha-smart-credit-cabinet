import logging
import math

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.config import get_settings
from app.db import get_db
from app.errors import NotFound, TooManyRequests, Unauthorized
from app.models import User
from app.schemas import DemoAccountOut, DemoLoginIn, LoginIn, TokenOut, UserOut
from app.security import (
    DUMMY_PASSWORD_HASH,
    create_token,
    fingerprint,
    ip_throttle,
    login_throttle,
    throttle_key,
    verify_password,
)
from app.seed import DEMO_SCENARIOS

router = APIRouter(prefix="/auth", tags=["Вход"])
log = logging.getLogger("app.auth")


def _token(user: User) -> TokenOut:
    return TokenOut(access_token=create_token(user.id, user.role), user=UserOut.model_validate(user))


def _log_login(outcome: str, email_sha: str, user_id: int | None, method: str = "password") -> None:
    """Каждая попытка входа — строка журнала. Почта и пароль в неё не попадают, только отпечаток почты (HMAC с
    секретным ключом): по нему видно, что неудачи относятся к одной и той же почте, а почту по нему не подобрать."""
    log.info(
        "auth",
        extra={"event": "login", "outcome": outcome, "user_id": user_id, "email_sha": email_sha, "method": method},
    )


def _client_ip(request: Request) -> str:
    # nginx кладёт сюда $remote_addr и затирает присланное клиентом значение. Порт 8000 опубликован только на
    # 127.0.0.1, поэтому снаружи в обход nginx заголовок не подделать. Без заголовка — адрес соединения.
    return request.headers.get("x-real-ip", "").strip()[:64] or (request.client.host if request.client else "")


def _begin_attempt(key: str, ip_key: str) -> float:
    """Занимает место под попытку в обоих счётчиках (по адресу и по паре «почта + адрес»). 0 — пароль можно проверять,
    иначе столько секунд вход закрыт."""
    wait = ip_throttle.begin(ip_key)
    if wait > 0:
        return wait
    wait = login_throttle.begin(key)
    if wait > 0:
        ip_throttle.finish(ip_key, None)  # отказ — не попытка: место возвращается
    return wait


def _finish_attempt(key: str, ip_key: str, verdict: bool | None) -> None:
    login_throttle.finish(key, verdict)
    ip_throttle.finish(ip_key, verdict)  # удачный вход счёт по адресу не сбрасывает


def _minutes(seconds: float) -> str:
    n = max(1, math.ceil(seconds / 60))
    if n % 10 == 1 and n % 100 != 11:
        return f"{n} минуту"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return f"{n} минуты"
    return f"{n} минут"


@router.post("/login", response_model=TokenOut, summary="Вход по почте и паролю")
def login(data: LoginIn, request: Request, db: Session = Depends(get_db)) -> TokenOut:
    email = data.email.strip().lower()
    # Счёт ведётся по паре «почта + адрес клиента», существует почта или нет: ответ не выдаёт, есть ли такой
    # пользователь, а посторонний со своего адреса не может закрыть вход владельцу. Вторым, грубее, считаются
    # неудачи с одного адреса по любым почтам.
    ip = _client_ip(request)
    key, ip_key, email_sha = throttle_key(email, ip), throttle_key(ip), fingerprint(email)
    # Проверка и занятие места под попытку — одно действие: параллельные запросы не обходят лимит.
    wait = _begin_attempt(key, ip_key)
    if wait > 0:
        _log_login("throttled", email_sha, None)
        raise TooManyRequests(f"Слишком много неудачных попыток входа — подождите {_minutes(wait)}")
    verdict: bool | None = None  # None — пароль проверить не удалось (сбой БД): неудачей не считается
    try:
        user = db.scalar(select(User).where(User.email == email))
        # Пароль проверяется и для неизвестной почты: по времени ответа не понять, есть ли такой пользователь.
        valid = verify_password(data.password, user.password_hash if user is not None else DUMMY_PASSWORD_HASH)
        verdict = user is not None and valid
    finally:
        _finish_attempt(key, ip_key, verdict)
    if user is None or not valid:
        _log_login("failure", email_sha, user.id if user is not None else None)
        raise Unauthorized("Неверная почта или пароль")
    _log_login("success", email_sha, user.id)
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
    user = None
    if get_settings().demo_mode and data.email in DEMO_SCENARIOS:
        user = db.scalar(select(User).where(User.email == data.email))
    email_sha = fingerprint(data.email.strip().lower())
    if user is None:
        _log_login("failure", email_sha, None, "demo")
        raise NotFound("Демо-вход недоступен")
    _log_login("success", email_sha, user.id, "demo")
    return _token(user)


@router.get("/me", response_model=UserOut, summary="Текущий пользователь")
def me(user: User = Depends(get_current_user)) -> User:
    return user
