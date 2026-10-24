import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import inspect

from app.api import applications, auth, companies, feed, health, loans, meta, notifications, policy, products
from app.config import get_settings
from app.db import SessionLocal, engine
from app.errors import register_error_handlers
from app.observability import RequestContextMiddleware, configure_logging
from app.seed import seed

log = logging.getLogger("app")

TAGS = [
    {"name": "Вход", "description": "Аутентификация и тестовые учётные записи"},
    {"name": "Справочники", "description": "Этапы, статусы и цели кредита для интерфейса"},
    {"name": "Продукты", "description": "Каталог, подбор продукта и калькулятор платежа"},
    {"name": "Компании", "description": "Данные компании из ЕГРЮЛ/ЕГРИП"},
    {"name": "Заявки", "description": "Жизненный цикл кредитной заявки: анкета, конвейер, решение, договор, подпись"},
    {"name": "Кредиты", "description": "Выданные кредиты и графики платежей"},
    {"name": "Лента", "description": "Персональная лента новостей (синтетические новости)"},
    {"name": "Политика", "description": "Симулятор изменения порогов кредитной политики"},
    {"name": "Уведомления", "description": "Уведомления внутри кабинета — вместо SMS и почты"},
    {"name": "Служебное", "description": "Проверки живости и готовности"},
]


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    configure_logging(settings.log_level)
    if settings.environment not in ("local", "test") and "change-me" in settings.secret_key:
        log.warning("SECRET_KEY не задан — используется демо-значение. Для любого внешнего окружения задайте свой.")
    # Демо-учётки с общим паролем нужны только демо-стенду.
    if settings.seed_on_start and settings.demo_mode:
        if inspect(engine).has_table("users"):
            with SessionLocal() as db:
                seed(db)
        else:
            log.warning("Таблиц нет — выполните `alembic upgrade head`, демо-данные не загружены")
    yield


def create_app() -> FastAPI:
    # Вне демо-режима Swagger и спецификация не публикуются; scripts/export_openapi берёт её из app.openapi().
    demo = get_settings().demo_mode
    app = FastAPI(
        title="Кредитный конвейер для МСБ — core API",
        version="1.0.0",
        description=(
            "Ядро цифрового кредитного конвейера: заявки, их статусы и переходы, каталог продуктов, "
            "интеграции с внешними источниками. Ошибки возвращаются в едином формате "
            "`{status, code, title, detail, errors?}`."
        ),
        openapi_tags=TAGS,
        docs_url="/api/docs" if demo else None,
        redoc_url=None,
        openapi_url="/api/openapi.json" if demo else None,
        lifespan=lifespan,
    )
    app.add_middleware(RequestContextMiddleware)
    register_error_handlers(app)
    app.include_router(health.router)
    for module in (auth, meta, products, companies, applications, loans, notifications, feed, policy):
        app.include_router(module.router, prefix="/api")
    return app


app = create_app()
