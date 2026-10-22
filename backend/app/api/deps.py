import jwt
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.db import get_db
from app.errors import Forbidden, Unauthorized
from app.models import User
from app.security import decode_token

_bearer = HTTPBearer(auto_error=False)


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    if creds is None:
        raise Unauthorized()
    try:
        payload = decode_token(creds.credentials)
    except jwt.PyJWTError:
        raise Unauthorized("Сессия истекла — войдите снова")
    user = db.get(User, int(payload["sub"]))
    if user is None:
        raise Unauthorized()
    return user


def require_client(user: User = Depends(get_current_user)) -> User:
    if user.role != "client":
        raise Forbidden("Раздел доступен только клиентам")
    return user


def require_analyst(user: User = Depends(get_current_user)) -> User:
    if user.role != "analyst":
        raise Forbidden("Раздел доступен только сотрудникам банка")
    return user
