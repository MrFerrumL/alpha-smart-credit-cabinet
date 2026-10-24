from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    pass


def make_engine(url: str) -> Engine:
    kwargs: dict = {"pool_pre_ping": True}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
    return create_engine(url, **kwargs)


engine = make_engine(get_settings().database_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


# Первичные ключи — INTEGER (int4 в PostgreSQL): номер больше этого не может быть ни у одного объекта.
MAX_ID = 2**31 - 1


def get_by_id[M](db: Session, model: type[M], id_: int) -> M | None:
    """db.get для номера из запроса: номер вне диапазона ключей — «нет такого объекта», а не ошибка драйвера."""
    return db.get(model, id_) if 0 < id_ <= MAX_ID else None


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
