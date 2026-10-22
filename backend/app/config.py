from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Конфигурация сервиса. Все значения переопределяются переменными окружения (см. .env.example)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "Кредитный конвейер — core API"
    environment: str = "local"

    # По умолчанию — файл SQLite рядом с кодом backend, независимо от текущей папки.
    database_url: str = f"sqlite:///{(Path(__file__).resolve().parents[1] / 'local.db').as_posix()}"

    secret_key: str = "dev-only-secret-change-me-in-production"
    token_ttl_minutes: int = 12 * 60

    mocks_url: str = "http://localhost:8001"
    integration_timeout_s: float = 3.0
    integration_retries: int = 3

    # Демо-режим: вход в один клик под тестовыми учётками и автозаполнение демо-данных.
    demo_mode: bool = True
    seed_on_start: bool = True

    log_level: str = "INFO"


@lru_cache
def get_settings() -> Settings:
    return Settings()
