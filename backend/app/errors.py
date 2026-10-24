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


class TooManyRequests(AppError):
    status, code, title = 429, "too_many_requests", "Слишком много запросов"


class IntegrationUnavailable(AppError):
    status, code, title = 503, "integration_unavailable", "Внешний сервис временно недоступен"


_FIELD_LABELS = {
    "email": "Почта",
    "password": "Пароль",
    "inn": "ИНН",
    "product_code": "Продукт",
    "purpose": "Цель кредита",
    "amount": "Сумма",
    "term_months": "Срок",
    "rate": "Ставка",
    "monthly_revenue": "Выручка в месяц",
    "monthly_expenses": "Расходы в месяц",
    "debt_payments": "Платежи по текущим кредитам",
    "employees": "Сотрудников",
    "value": "Стоимость обеспечения",
    "description": "Описание обеспечения",
    "contact_name": "Контактное лицо",
    "contact_position": "Должность",
    "comment": "Комментарий",
    "answer": "Ответ",
    "code": "Код",
    "file": "Файл",
    "outcome": "Решение",
    "client_message": "Сообщение клиенту",
    "reasons": "Причина отказа",
    "tips": "Что можно улучшить",
    "task_kind": "Вид запроса",
    "task_title": "Что нужно от клиента",
    "task_description": "Пояснение к запросу",
    "max_dsr": "Максимальная нагрузка",
    "min_coverage": "Минимальное покрытие",
}


def _num(value) -> str:
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return f"{value:,}".replace(",", " ").replace(".", ",")


def _of(n: int, one: str, many: str) -> str:
    return f"{n} {one if n % 10 == 1 and n % 100 != 11 else many}"


_SCHEMA_RULES = {
    "missing": lambda c: "обязательное поле",
    "string_too_short": lambda c: (
        "не может быть пустым" if c["min_length"] == 1 else f"не короче {_of(c['min_length'], 'символа', 'символов')}"
    ),
    "string_too_long": lambda c: f"не длиннее {_of(c['max_length'], 'символа', 'символов')}",
    "string_pattern_mismatch": lambda c: "неверный формат",
    "greater_than": lambda c: f"больше {_num(c['gt'])}",
    "greater_than_equal": lambda c: f"не меньше {_num(c['ge'])}",
    "less_than": lambda c: f"меньше {_num(c['lt'])}",
    "less_than_equal": lambda c: f"не больше {_num(c['le'])}",
    "too_long": lambda c: f"не больше {_of(c['max_length'], 'пункта', 'пунктов')}",
    "int_parsing_size": lambda c: "слишком большое число",
    "int_parsing": lambda c: "нужно целое число",
    "int_from_float": lambda c: "нужно целое число",
    "int_type": lambda c: "нужно целое число",
    "float_parsing": lambda c: "нужно число",
    "float_type": lambda c: "нужно число",
    "finite_number": lambda c: "нужно число",
    "string_type": lambda c: "нужен текст",
    "literal_error": lambda c: "недопустимое значение",
    "enum": lambda c: "недопустимое значение",
    "json_invalid": lambda c: "запрос не в формате JSON",
}


def _schema_message(err: dict) -> str:
    """Сообщение об ошибке схемы (pydantic) по-русски и с названием поля — фронт показывает его как есть."""
    if err["type"] == "value_error" and "error" in (err.get("ctx") or {}):
        return str(err["ctx"]["error"])  # свой валидатор уже пишет готовое сообщение
    try:
        text = _SCHEMA_RULES[err["type"]](err.get("ctx") or {})
    except KeyError:
        text = "неверное значение"
    names = [p for p in err["loc"] if isinstance(p, str) and p not in ("body", "query", "path", "header", "cookie")]
    label = _FIELD_LABELS.get(names[-1]) if names else None
    return f"{label} — {text}" if label else text[:1].upper() + text[1:]


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
            {"field": ".".join(str(p) for p in err["loc"] if p != "body"), "message": _schema_message(err)}
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
