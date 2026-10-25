"""Шаг конвейера пишет в лог под id задачи: request_id = job-<задача>.<попытка> и заявка, а после шага всё как было."""

import json
import logging

import pytest

from app.observability import JsonFormatter, application_id_var, bind_context, request_id_var
from app.pipeline.steps import STEPS, RetryLater
from tests.test_queue import _in_validation, _process_one


class JsonLines(logging.Handler):
    """Форматирует запись сразу при выводе, как боевой обработчик: id берётся из контекста в этот момент."""

    def __init__(self) -> None:
        super().__init__()
        self.setFormatter(JsonFormatter())
        self.lines: list[dict] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(json.loads(self.format(record)))


@pytest.fixture
def lines():
    handler, logger = JsonLines(), logging.getLogger("app.pipeline")
    level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    yield handler.lines
    logger.removeHandler(handler)
    logger.setLevel(level)


def test_step_runs_under_the_job_request_id_and_the_context_is_restored(client, mocks, monkeypatch, lines):
    app_id, _, job_id = _in_validation(client, mocks)
    expected, validate = STEPS["pipeline.validate"]
    seen = {}

    def spy(db, app, sources):
        seen["request_id"], seen["application_id"] = request_id_var.get(), application_id_var.get()
        logging.getLogger("app.pipeline").info("inside the step")
        validate(db, app, sources)

    monkeypatch.setitem(STEPS, "pipeline.validate", (expected, spy))
    assert (request_id_var.get(), application_id_var.get()) == ("-", None)
    _process_one(mocks)

    assert seen == {"request_id": f"job-{job_id}.1", "application_id": app_id}
    line = next(x for x in lines if x["msg"] == "inside the step")
    assert (line["request_id"], line["application_id"]) == (f"job-{job_id}.1", app_id)
    assert (request_id_var.get(), application_id_var.get()) == ("-", None)


def test_each_attempt_has_its_own_id_and_failures_carry_it(client, mocks, monkeypatch, lines):
    app_id, _, job_id = _in_validation(client, mocks)
    expected, _ = STEPS["pipeline.validate"]

    def source_is_down(db, app, sources):
        raise RetryLater("source is down")

    monkeypatch.setitem(STEPS, "pipeline.validate", (expected, source_is_down))
    _process_one(mocks)
    _process_one(mocks)

    postponed = [x for x in lines if x["msg"] == "pipeline step postponed"]
    assert [x["request_id"] for x in postponed] == [f"job-{job_id}.1", f"job-{job_id}.2"]
    assert {x["application_id"] for x in postponed} == {app_id}
    assert (request_id_var.get(), application_id_var.get()) == ("-", None)


def test_context_is_restored_even_if_the_step_blows_up(client, mocks, monkeypatch):
    _in_validation(client, mocks)
    expected, _ = STEPS["pipeline.validate"]

    def crash(db, app, sources):
        raise RuntimeError("boom")

    monkeypatch.setitem(STEPS, "pipeline.validate", (expected, crash))
    _process_one(mocks)  # runner ловит сбой шага сам
    assert (request_id_var.get(), application_id_var.get()) == ("-", None)

    with pytest.raises(RuntimeError), bind_context("outer", 5):
        with bind_context("inner", 6):
            raise RuntimeError("boom")
    assert (request_id_var.get(), application_id_var.get()) == ("-", None)
