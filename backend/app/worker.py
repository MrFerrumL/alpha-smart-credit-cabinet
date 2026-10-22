"""Воркер конвейера: python -m app.worker

Можно запускать несколько экземпляров — в PostgreSQL они разбирают очередь без конфликтов.
"""

import logging
import signal
import time
from pathlib import Path

from sqlalchemy.exc import OperationalError

from app.config import get_settings
from app.db import SessionLocal
from app.observability import configure_logging
from app.pipeline.queue import recover_stale
from app.pipeline.runner import process_next
from app.pipeline.steps import expire_offers, expire_requests
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

    next_housekeeping = 0.0
    heartbeat = Path(settings.worker_heartbeat_file) if settings.worker_heartbeat_file else None
    while not _stopping:
        if heartbeat is not None:
            heartbeat.touch()
        try:
            if time.monotonic() >= next_housekeeping:
                with SessionLocal() as db:
                    expired = expire_offers(db) + expire_requests(db)
                    # Задачи упавшего соседнего воркера возвращаются в очередь и во время работы, не только на старте.
                    recovered = recover_stale(db)
                if expired or recovered:
                    log.info("housekeeping", extra={"status": f"expired {expired}, recovered {recovered}"})
                next_housekeeping = time.monotonic() + settings.housekeeping_interval_s
            worked = process_next(SessionLocal, sources)
        except OperationalError:
            log.exception("database unavailable, retrying")
            worked = False
            time.sleep(2)
        except Exception:  # noqa: BLE001 — любая ошибка цикла не должна останавливать воркер
            log.exception("worker loop error, continuing")
            worked = False
            time.sleep(1)
        if not worked:
            time.sleep(settings.worker_poll_interval_s)
    log.info("worker stopped")


if __name__ == "__main__":
    main()
