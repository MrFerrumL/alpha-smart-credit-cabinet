"""JSON-формат логов: поля из extra= попадают в строку, собственные атрибуты записи — нет."""

import json
import logging

from app.observability import JsonFormatter, application_id_var, bind_context, request_id_var


def line(**extra) -> dict:
    record = logging.getLogger("app.test").makeRecord("app.test", logging.INFO, "f.py", 1, "msg", (), None, extra=extra)
    return json.loads(JsonFormatter().format(record))


def test_extra_fields_are_logged_as_given():
    data = line(job="pipeline.enrich", application_id=7, error="timeout")
    assert (data["job"], data["application_id"], data["error"]) == ("pipeline.enrich", 7, "timeout")


def test_access_log_keeps_its_fields_and_order():
    data = line(method="GET", path="/api/x", status=200, duration_ms=1.5)
    assert list(data)[-4:] == ["method", "path", "status", "duration_ms"]
    assert data["status"] == 200 and data["duration_ms"] == 1.5


def test_record_attributes_and_core_fields_stay_out_of_the_line():
    data = line(level="OVERRIDE")  # extra не затирает общее поле строки
    assert data["level"] == "INFO"
    assert not {"lineno", "pathname", "args", "levelname", "name", "taskName"} & set(data)
    assert list(line()) == ["ts", "level", "logger", "msg", "request_id"]


def test_application_id_from_context_is_added_only_when_set():
    assert "application_id" not in line()
    with bind_context("job-5.1", 42):
        data = line(job="pipeline.enrich")
        assert (data["request_id"], data["application_id"]) == ("job-5.1", 42)
        assert list(data)[:6] == ["ts", "level", "logger", "msg", "request_id", "job"]
    assert (request_id_var.get(), application_id_var.get()) == ("-", None)
    assert "application_id" not in line()


def test_application_id_in_extra_wins_over_the_context():
    with bind_context("job-5.1", 42):
        assert line(application_id=7)["application_id"] == 7


def test_nested_contexts_restore_the_outer_one():
    with bind_context("outer", 1):
        with bind_context("inner"):
            assert (request_id_var.get(), application_id_var.get()) == ("inner", None)
        assert (request_id_var.get(), application_id_var.get()) == ("outer", 1)


def test_value_that_is_not_json_does_not_break_the_line():
    assert line(error=ValueError("boom"))["error"] == "boom"
