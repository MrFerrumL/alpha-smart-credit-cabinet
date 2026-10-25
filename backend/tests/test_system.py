"""GET /api/system/jobs: последние повторы и сбои шагов конвейера для страницы «Состояние системы» в кабинете банка."""

from contextlib import contextmanager
from datetime import timedelta

import pytest
from sqlalchemy import delete

from app.db import SessionLocal
from app.models import Job, utcnow
from app.services.system import INTERNAL, STOPPED, explain
from tests.conftest import auth, run_pipeline
from tests.test_pipeline import get, submit

URL = "/api/system/jobs"
ANALYST = "analyst@demo.local"
CLIENT = "bakery@demo.local"
BAKERY_INN = "0077010019"


@contextmanager
def jobs(*specs: dict):
    """Задачи на время проверки. Они свежее всех остальных (updated_at впереди, по порядку аргументов) и ждут запуска
    час, поэтому конвейер других тестов их не возьмёт; после проверки удаляются."""
    later = utcnow() + timedelta(hours=1)
    with SessionLocal() as db:
        rows = [
            Job(**({"kind": "pipeline.enrich", "run_after": later, "updated_at": later - timedelta(seconds=i)} | spec))
            for i, spec in enumerate(specs)
        ]
        db.add_all(rows)
        db.commit()
        ids = [row.id for row in rows]
    try:
        yield ids
    finally:
        with SessionLocal() as db:
            db.execute(delete(Job).where(Job.id.in_(ids)))
            db.commit()


def recent(client, **params) -> list[dict]:
    response = client.get(URL, params=params, headers=auth(client, ANALYST))
    assert response.status_code == 200, response.text
    return response.json()


# --- доступ ------------------------------------------------------------------------------------------------------


def test_jobs_are_for_bank_staff_only(client):
    anonymous = client.get(URL)
    assert anonymous.status_code == 401 and anonymous.json()["code"] == "unauthorized"
    stranger = client.get(URL, headers=auth(client, CLIENT))
    assert stranger.status_code == 403 and stranger.json()["code"] == "forbidden"
    assert client.get(URL, headers=auth(client, ANALYST)).status_code == 200


@pytest.mark.parametrize("limit", [0, -1, 51])
def test_limit_out_of_bounds_is_rejected(client, limit):
    response = client.get(URL, params={"limit": limit}, headers=auth(client, ANALYST))
    assert response.status_code == 422, response.text


def test_limit_cuts_the_list_and_defaults_to_ten(client):
    with jobs(*({"status": "failed", "attempts": 3, "last_error": "bki: HTTP 500"} for _ in range(12))) as ids:
        assert [row["id"] for row in recent(client, limit=2)] == ids[:2]
        assert [row["id"] for row in recent(client)] == ids[:10]
        assert len(recent(client, limit=50)) >= 12


# --- что попадает в список и как называется ----------------------------------------------------------------------


def test_retries_and_failures_come_newest_first_in_plain_words(client):
    with jobs(
        {"status": "pending", "attempts": 2, "last_error": "bki: circuit open"},
        {"status": "pending", "attempts": 1, "last_error": "egrul: HTTP 503"},
        {"status": "running", "attempts": 2, "last_error": "fns: timeout"},
        {"kind": "pipeline.disburse", "status": "failed", "attempts": 3,
         "last_error": "abs: transport error: ConnectError"},
        {"kind": "pipeline.score", "status": "failed", "attempts": 3,
         "last_error": "ZeroDivisionError: division by zero"},
        # Без ошибки повтор бывает, только если задачу вернули в очередь после остановки воркера.
        {"status": "pending", "attempts": 2},
        # Не сбои: шаг выполнился с первой попытки, шаг не понадобился, задача ещё не запускалась.
        {"status": "done", "attempts": 1},
        {"status": "done", "attempts": 1, "last_error": "skipped: status cancelled"},
        {"status": "pending", "attempts": 0},
    ) as ids:
        rows = recent(client, limit=50)
    assert [row["id"] for row in rows[:6]] == ids[:6]
    assert not {row["id"] for row in rows} & set(ids[6:])

    paused, first, running, bank, crash, requeued = rows[:6]
    assert paused["status"] == "pending" and paused["step"] == "Запрос во внешние источники"
    assert (paused["source"], paused["reason"]) == ("bki", "запросы на паузе после серии сбоев")
    assert (paused["attempts"], paused["max_attempts"]) == (2, 3)  # PIPELINE_MAX_ATTEMPTS в conftest
    assert paused["next_attempt_at"] is not None and paused["updated_at"]
    assert (first["source"], first["reason"]) == ("egrul", "ошибка на стороне источника (код 503)")
    assert (running["source"], running["reason"]) == ("fns", "нет ответа за отведённое время")
    assert running["next_attempt_at"] is None  # повтор уже идёт
    assert (bank["source"], bank["reason"]) == ("abs", "нет связи с источником")
    assert bank["step"] == "Перевод денег через АБС"
    assert (crash["source"], crash["reason"], crash["step"]) == (None, INTERNAL, "Оценка и решение")
    assert (requeued["source"], requeued["reason"]) == (None, STOPPED)
    assert all("division" not in str(row) and "ConnectError" not in str(row) for row in rows)


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        ("bki: circuit open", ("bki", "запросы на паузе после серии сбоев")),
        ("egrul: timeout", ("egrul", "нет ответа за отведённое время")),
        ("fns: HTTP 502", ("fns", "ошибка на стороне источника (код 502)")),
        ("abs: transport error: ConnectError", ("abs", "нет связи с источником")),
        ("bki: unknown error", ("bki", "источник недоступен")),
        ("bki: HTTP 503; worker stopped during the step", ("bki", STOPPED)),
        ("worker stopped during the step", (None, STOPPED)),
        ("recovery failed: RuntimeError: boom", (None, "шаг не удалось вернуть в очередь после остановки обработчика")),
        ("skipped: status cancelled", (None, "заявка ушла с этого этапа — повтор не понадобился")),
        (f"KeyError: '{BAKERY_INN}'", (None, INTERNAL)),
        (f"ValueError: bki: {BAKERY_INN}", (None, INTERNAL)),
    ],
)
def test_last_error_becomes_a_short_reason(error, expected):
    assert explain(error) == expected


# --- на настоящем конвейере --------------------------------------------------------------------------------------


def test_long_outage_shows_the_failed_check_with_the_application_number(client, mocks):
    mocks.post("/admin/faults", json={"source": "bki", "mode": "error"})
    app_id, headers = submit(client, CLIENT)
    run_pipeline(mocks)
    number = get(client, app_id, headers)["number"]

    row = next(row for row in recent(client, limit=50) if row["application_id"] == app_id)
    assert row["application_number"] == number and number
    assert (row["kind"], row["status"], row["attempts"], row["max_attempts"]) == ("pipeline.enrich", "failed", 3, 3)
    assert (row["source"], row["reason"]) == ("bki", "ошибка на стороне источника (код 503)")
    assert row["next_attempt_at"] is None


def test_short_outage_shows_the_recovered_step_and_its_source(client, mocks):
    mocks.post("/admin/faults", json={"source": "bki", "mode": "error", "count": 1})
    app_id, headers = submit(client, CLIENT)
    run_pipeline(mocks)
    assert get(client, app_id, headers)["status"]["code"] == "approved"

    rows = [row for row in recent(client, limit=50) if row["application_id"] == app_id]
    assert len(rows) == 1  # остальные шаги выполнились с первой попытки
    assert (rows[0]["status"], rows[0]["attempts"], rows[0]["source"]) == ("done", 2, "bki")
    assert rows[0]["reason"] == "сбой прошёл — шаг выполнен с 2-й попытки"


def test_payload_has_no_inn_company_or_raw_error(client, mocks):
    app_id, _ = submit(client, CLIENT)
    run_pipeline(mocks)
    with jobs(
        {"application_id": app_id, "status": "failed", "attempts": 3, "last_error": f"KeyError: '{BAKERY_INN}'"},
        {"application_id": app_id, "status": "pending", "attempts": 1,
         "last_error": f"bki: HTTP 503 for /bki/{BAKERY_INN}"},
    ):
        response = client.get(URL, params={"limit": 50}, headers=auth(client, ANALYST))
    assert response.status_code == 200
    assert response.json()[0]["application_id"] == app_id
    assert BAKERY_INN not in response.text
    assert "пекарня" not in response.text.lower() and "KeyError" not in response.text
