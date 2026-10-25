from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Конфигурация сервиса. Все значения переопределяются переменными окружения (см. .env.example)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: str = "local"

    # По умолчанию — файл SQLite рядом с кодом backend, независимо от текущей папки.
    database_url: str = f"sqlite:///{(Path(__file__).resolve().parents[1] / 'local.db').as_posix()}"

    secret_key: str = "dev-only-secret-change-me-in-production"
    token_ttl_minutes: int = 12 * 60

    mocks_url: str = "http://localhost:8001"
    integration_timeout_s: float = 3.0
    integration_retries: int = 3
    # Предохранитель источников: после стольких сбоев подряд источник не опрашивается breaker_cooldown_s
    # секунд, затем один пробный запрос. Порог не ниже integration_retries + 1; 0 — предохранитель выключен.
    breaker_threshold: int = 5
    breaker_cooldown_s: float = 20.0

    # Конвейер: пауза между этапами (чтобы клиент видел, как заявка движется), повторы при сбоях.
    pipeline_step_delay_s: float = 1.5
    pipeline_retry_base_s: float = 2.0
    pipeline_max_attempts: int = 5
    worker_poll_interval_s: float = 0.5
    # Файл «пульса» воркера: обновляется на каждом проходе цикла, по нему healthcheck видит, что воркер жив.
    worker_heartbeat_file: str | None = None
    offer_valid_days: int = 7
    # Сумма, которую кредитный аналитик одобряет сам; выше — решение кредитного комитета.
    analyst_authority_limit: int = 30_000_000
    housekeeping_interval_s: float = 60.0  # как часто воркер закрывает просроченные предложения
    # Сколько дней банк ждёт ответа на свой запрос, прежде чем закрыть заявку.
    needs_info_ttl_days: int = 14

    # Подписание договора одноразовым кодом.
    signing_code_ttl_s: int = 300
    signing_max_attempts: int = 3
    signing_codes_per_hour: int = 5
    # Выдача не «сдаётся»: после исчерпания повторов задача ставится заново с этой паузой.
    disburse_retry_s: float = 60.0
    bank_name: str = "АО «Банк» (демо)"

    # Документы клиентов. В Docker — отдельный том.
    upload_dir: str = (Path(__file__).resolve().parents[1] / "uploads").as_posix()
    max_upload_mb: int = 10

    # Демо-режим: вход в один клик под тестовыми учётками и автозаполнение демо-данных.
    demo_mode: bool = True
    seed_on_start: bool = True

    # Необязательное пояснение решения простыми словами (LLM, OpenAI-совместимый API). По умолчанию выключено.
    llm_enabled: bool = False
    llm_base_url: str = "http://localhost:11434/v1"
    llm_api_key: SecretStr = SecretStr("")
    llm_model: str = "qwen2.5:7b-instruct-q4_K_M"

    log_level: str = "INFO"

    @property
    def llm_active(self) -> bool:
        """Функция работает, только если включена и заданы адрес и модель. Одно свойство для API и воркера."""
        return self.llm_enabled and bool(self.llm_base_url.strip()) and bool(self.llm_model.strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()
