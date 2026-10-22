"""Эмулятор внешних систем: ЕГРЮЛ/ЕГРИП, бюро кредитных историй, ФНС «Прозрачный бизнес», АБС банка.

Контракты упрощены, но сохраняют смысл интеграций. Чтобы показать отказоустойчивость конвейера,
в сервис можно «внести сбой» через /admin/faults: источник начнёт отвечать ошибкой или зависать.
"""

import os
import random
import threading
import time
import uuid
from datetime import date, datetime, timezone
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from mockapi.data import COMPANIES
from mockapi.generator import generate

Source = Literal["egrul", "bki", "fns", "abs"]

app = FastAPI(
    title="Эмулятор внешних источников",
    version="0.1.0",
    description="ЕГРЮЛ/ЕГРИП, бюро кредитных историй и ФНС «Прозрачный бизнес» на синтетических данных.",
)


# --- Внесение сбоев ---------------------------------------------------------------------------


class FaultIn(BaseModel):
    source: Literal["egrul", "bki", "fns", "abs", "all"]
    mode: Literal["error", "timeout", "none"]
    count: int | None = Field(default=None, ge=1, description="Сколько запросов сломать; пусто — до отмены")


_faults: dict[str, dict] = {}
_lock = threading.Lock()


def _maybe_fail(source: str) -> None:
    with _lock:
        fault = _faults.get(source) or _faults.get("all")
        if not fault:
            return
        key = source if source in _faults else "all"
        if fault["count"] is not None:
            fault["count"] -= 1
            if fault["count"] <= 0:
                _faults.pop(key)
        mode = fault["mode"]
    if mode == "timeout":
        time.sleep(float(os.getenv("MOCK_TIMEOUT_SLEEP_S", "10")))
    raise HTTPException(status_code=503, detail=f"{source} temporarily unavailable")


def _latency() -> None:
    base = int(os.getenv("MOCK_LATENCY_MS", "250"))
    if base > 0:
        time.sleep(base * random.uniform(0.5, 1.5) / 1000)


@app.post("/admin/faults", tags=["Управление"], summary="Включить или снять сбой источника")
def set_fault(data: FaultIn) -> dict:
    with _lock:
        if data.mode == "none":
            if data.source == "all":
                _faults.clear()
            else:
                _faults.pop(data.source, None)
        else:
            _faults[data.source] = {"mode": data.mode, "count": data.count}
        return dict(_faults)


@app.get("/admin/faults", tags=["Управление"], summary="Текущие сбои")
def get_faults() -> dict:
    with _lock:
        return dict(_faults)


# --- Источники --------------------------------------------------------------------------------


def _company(inn: str) -> dict:
    if not inn.isdigit() or len(inn) not in (10, 12):
        raise HTTPException(status_code=404, detail="not found")
    return COMPANIES.get(inn) or generate(inn)


@app.get("/egrul/{inn}", tags=["Источники"], summary="Выписка ЕГРЮЛ/ЕГРИП")
def egrul(inn: str) -> dict:
    _maybe_fail("egrul")
    _latency()
    data = _company(inn)["egrul"]
    return {
        "source": "ЕГРИП" if data["legal_form"] == "ИП" else "ЕГРЮЛ",
        "inn": inn,
        **data,
        "extracted_at": date.today().isoformat(),
    }


@app.get("/fns/{inn}", tags=["Источники"], summary="ФНС «Прозрачный бизнес»")
def fns(inn: str) -> dict:
    _maybe_fail("fns")
    _latency()
    return {"source": "ФНС «Прозрачный бизнес»", "inn": inn, **_company(inn)["fns"]}


@app.get("/bki/{inn}", tags=["Источники"], summary="Кредитный отчёт бюро кредитных историй")
def bki(inn: str) -> dict:
    _maybe_fail("bki")
    _latency()
    report = _company(inn)["bki"]
    loans = report["loans"]
    return {
        "source": "Бюро кредитных историй",
        "inn": inn,
        "report_date": date.today().isoformat(),
        "loans": loans,
        "summary": {
            "active_loans": len(loans),
            "total_balance": sum(l["balance"] for l in loans),
            "monthly_payments": sum(l["monthly_payment"] for l in loans),
            "max_overdue_days_24m": max((l["overdue_max_days_24m"] for l in loans), default=0),
            "current_overdue_days": max((l["overdue_days_current"] for l in loans), default=0),
            "current_overdue_amount": sum(l["overdue_amount_current"] for l in loans),
            "inquiries_90d": report["inquiries_90d"],
        },
    }


@app.get("/health", tags=["Служебное"])
def health() -> dict:
    return {"status": "ok"}


# --- АБС банка: выдача кредита --------------------------------------------------------------


class DisbursementIn(BaseModel):
    contract_number: str = Field(min_length=1, max_length=64)
    inn: str
    amount: int = Field(gt=0)


_disbursements: dict[str, dict] = {}


@app.post("/abs/disbursements", tags=["АБС"], summary="Перечислить сумму кредита на расчётный счёт клиента")
def disburse(data: DisbursementIn) -> dict:
    _maybe_fail("abs")
    _latency()
    with _lock:
        # Номер договора — ключ идемпотентности: повторный запрос возвращает уже проведённый платёж.
        existing = _disbursements.get(data.contract_number)
        if existing:
            return existing
        payment = {
            "payment_id": f"PAY-{uuid.uuid4().hex[:12].upper()}",
            "contract_number": data.contract_number,
            "inn": data.inn,
            "amount": data.amount,
            "status": "executed",
            "executed_at": datetime.now(timezone.utc).isoformat(),
        }
        _disbursements[data.contract_number] = payment
        return payment
