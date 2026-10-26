FROM python:3.12.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY alembic.ini .
COPY migrations ./migrations
COPY app ./app

RUN useradd --create-home --uid 10001 app && mkdir -p /data/uploads && chown app:app /data/uploads
USER app

EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health/ready').status == 200 else 1)"

# Миграции применяются при старте; демо-данные загружаются, если SEED_ON_START=true.
# exec — чтобы uvicorn стал главным процессом и получил SIGTERM от docker stop (иначе его получит только sh).
# При остановке открытые запросы доделываются не дольше 10 с, потоки SSE, не закрывшиеся сами, обрываются.
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*' --timeout-graceful-shutdown 10"]
