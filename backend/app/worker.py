"""Воркер конвейера: python -m app.worker

Можно запускать несколько экземпляров — в PostgreSQL они разбирают очередь без конфликтов.
"""

import logging
import signal
import time

from sqlalchemy.exc import OperationalError

from app.config import get_settings
from app.db import SessionLocal
from app.observability import configure_logging
from app.pipeline.queue import recover_stale
from app.pipeline.runner import process_next
from app.services.integrations import get_sources

log = logging.getLogger("app.worker")

_stopping = False


def _stop(*_: object) -> None:
    global _stopping
    _stopping = True


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    sources = get_sources()

    with SessionLocal() as db:
        recovered = recover_stale(db)
    log.info("worker started", extra={"status": f"recovered {recovered} stale jobs"})

    while not _stopping:
        try:
            worked = process_next(SessionLocal, sources)
        except OperationalError:
            log.exception("database unavailable, retrying")
            worked = False
            time.sleep(2)
        if not worked:
            time.sleep(settings.worker_poll_interval_s)
    log.info("worker stopped")


if __name__ == "__main__":
    main()
