"""Структурированные JSON-логи и сквозной идентификатор запроса (X-Request-ID)."""

import json
import logging
import time
import uuid
from contextvars import ContextVar

request_id_var: ContextVar[str] = ContextVar("request_id", default="-")

# Собственные атрибуты записи logging: всё остальное в record.__dict__ попало туда через extra=.
_RECORD_FIELDS = frozenset(logging.makeLogRecord({}).__dict__) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        data = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "request_id": request_id_var.get(),
        }
        # Поля из extra= выводятся как есть, в порядке передачи; общие поля записи они не затирают.
        for key, value in record.__dict__.items():
            if key not in _RECORD_FIELDS and key not in data:
                data[key] = value
        if record.exc_info:
            data["exc"] = self.formatException(record.exc_info)
        return json.dumps(data, ensure_ascii=False, default=str)


def configure_logging(level: str) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    logging.getLogger("uvicorn.access").disabled = True
    logging.getLogger("httpx").setLevel(logging.WARNING)


class RequestContextMiddleware:
    """ASGI-middleware: присваивает запросу ID, прокидывает его в ответ и пишет access-лог."""

    def __init__(self, app):
        self.app = app
        self.log = logging.getLogger("app.access")

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        incoming = dict(scope.get("headers") or []).get(b"x-request-id", b"").decode()[:64]
        rid = incoming or uuid.uuid4().hex
        token = request_id_var.set(rid)
        started = time.perf_counter()
        status_holder = {"status": 500}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
                message.setdefault("headers", []).append((b"x-request-id", rid.encode()))
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            if not scope["path"].startswith("/health"):
                self.log.info(
                    "request",
                    extra={
                        "method": scope["method"],
                        "path": scope["path"],
                        "status": status_holder["status"],
                        "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                    },
                )
            request_id_var.reset(token)
