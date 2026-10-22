import jwt
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.db import get_db
from app.errors import Forbidden, Unauthorized
from app.models import User
from app.security import decode_token

_bearer = HTTPBearer(auto_error=False)


def _user_from_token(creds: HTTPAuthorizationCredentials | None, db: Session) -> User:
    if creds is None:
        raise Unauthorized()
    try:
        user_id = int(decode_token(creds.credentials)["sub"])
    except (jwt.PyJWTError, KeyError, TypeError, ValueError):
        raise Unauthorized("Сессия истекла — войдите снова")
    user = db.get(User, user_id)
    if user is None:
        raise Unauthorized()
    return user


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    return _user_from_token(creds, db)


def get_stream_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db, scope="function"),
) -> User:
    """Пользователь для долгих потоков (SSE). Сессия БД закрывается сразу после проверки токена, а не в
    конце потока, — иначе каждый открытый поток держал бы соединение из пула."""
    return _user_from_token(creds, db)


def require_client(user: User = Depends(get_current_user)) -> User:
    if user.role != "client":
        raise Forbidden("Раздел доступен только клиентам")
    return user


def require_analyst(user: User = Depends(get_current_user)) -> User:
    if user.role != "analyst":
        raise Forbidden("Раздел доступен только сотрудникам банка")
    return user
