"""Единый формат ошибок API (по мотивам RFC 9457 Problem Details).

Любая ошибка возвращается как {"status", "code", "title", "detail", "errors"?} — фронт показывает
title/detail пользователю и опирается на code в логике.
"""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.orm.exc import StaleDataError
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("app.errors")


class AppError(Exception):
    status = 400
    code = "bad_request"
    title = "Некорректный запрос"

    def __init__(self, detail: str | None = None, *, errors: list[dict] | None = None):
        super().__init__(detail or self.title)
        self.detail = detail or self.title
        self.errors = errors


class NotFound(AppError):
    status, code, title = 404, "not_found", "Не найдено"


class Forbidden(AppError):
    status, code, title = 403, "forbidden", "Недостаточно прав"


class Unauthorized(AppError):
    status, code, title = 401, "unauthorized", "Нужно войти в систему"


class Conflict(AppError):
    status, code, title = 409, "conflict", "Конфликт состояния"


class InvalidTransition(Conflict):
    code, title = "invalid_transition", "Действие недоступно на этом этапе"


class BusinessValidationError(AppError):
    status, code, title = 422, "validation_error", "Проверьте введённые данные"


class IntegrationUnavailable(AppError):
    status, code, title = 503, "integration_unavailable", "Внешний сервис временно недоступен"


def _problem(status: int, code: str, title: str, detail: str, errors: list[dict] | None = None) -> JSONResponse:
    body: dict = {"status": status, "code": code, "title": title, "detail": detail}
    if errors:
        body["errors"] = errors
    return JSONResponse(body, status_code=status)


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def handle_app_error(_: Request, exc: AppError) -> JSONResponse:
        return _problem(exc.status, exc.code, exc.title, exc.detail, exc.errors)

    @app.exception_handler(StaleDataError)
    async def handle_stale(_: Request, exc: StaleDataError) -> JSONResponse:
        return _problem(409, "concurrent_update", "Заявка изменилась", "Обновите страницу и повторите действие.")

    @app.exception_handler(RequestValidationError)
    async def handle_validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [
            {"field": ".".join(str(p) for p in err["loc"] if p != "body"), "message": err["msg"]}
            for err in exc.errors()
        ]
        return _problem(422, "validation_error", "Проверьте введённые данные", "Некоторые поля заполнены неверно.", errors)

    @app.exception_handler(StarletteHTTPException)
    async def handle_http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        return _problem(exc.status_code, "http_error", str(exc.detail), str(exc.detail))

    @app.exception_handler(Exception)
    async def handle_unexpected(_: Request, exc: Exception) -> JSONResponse:
        log.exception("Unhandled error", exc_info=exc)
        return _problem(500, "internal_error", "Что-то пошло не так", "Мы уже разбираемся. Попробуйте ещё раз.")
