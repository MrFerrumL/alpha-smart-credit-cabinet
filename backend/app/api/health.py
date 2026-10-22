from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.db import engine

router = APIRouter(prefix="/health", tags=["Служебное"])


@router.get("/live", summary="Процесс жив")
def live() -> dict:
    return {"status": "ok"}


@router.get("/ready", summary="Сервис готов принимать запросы (БД доступна)")
def ready() -> JSONResponse:
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        return JSONResponse({"status": "unavailable", "db": "down"}, status_code=503)
    return JSONResponse({"status": "ok", "db": "up"})
