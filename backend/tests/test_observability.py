"""JSON-формат логов: поля из extra= попадают в строку, собственные атрибуты записи — нет."""

import json
import logging

from app.observability import JsonFormatter


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


def test_value_that_is_not_json_does_not_break_the_line():
    assert line(error=ValueError("boom"))["error"] == "boom"
