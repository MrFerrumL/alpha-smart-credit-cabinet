# Альфа Хакатон. Умный кредитный кабинет

[![Backend & frontend CI](https://github.com/MrFerrumL/alpha-smart-credit-cabinet/actions/workflows/ci.yml/badge.svg)](https://github.com/MrFerrumL/alpha-smart-credit-cabinet/actions/workflows/ci.yml)
[![ML reproducibility](https://github.com/MrFerrumL/alpha-smart-credit-cabinet/actions/workflows/ml.yml/badge.svg)](https://github.com/MrFerrumL/alpha-smart-credit-cabinet/actions/workflows/ml.yml)

**Backend / ML engineering portfolio · Python 3.12 · FastAPI · PostgreSQL · scikit-learn · Docker**

Кредитный кабинет для малого бизнеса: от заявки и проверки компании до решения, договора и смоделированной выдачи.
Портфолио-версия дополняет хакатонный прототип обучаемой моделью риска, воспроизводимым ML-экспериментом и API для аналитика.

![Контрпредложение и объяснение решения](docs/screenshots/counter-offer.jpg)

## Что можно проверить

| Backend engineering | ML engineering |
|---|---|
| REST API, OpenAPI, JWT и разграничение ролей | Logistic Regression + StandardScaler, семь признаков |
| PostgreSQL, SQLAlchemy, Alembic | Синтетические данные с вероятностной целевой переменной |
| Машина состояний и аудит заявки | Train / validation / test = 60 / 20 / 20 |
| Очередь в БД, retries, circuit breaker, идемпотентность | ROC-AUC, Average Precision, Brier score, log loss, calibration bins |
| SSE, request ID, health checks | Выбор порога на validation по стоимости ошибок |
| Тесты и Docker Compose | JSON-артефакт, SHA-256, объяснение в log-odds, training-serving parity |

**Границы:** решение по заявке принимает существующая кредитная политика на правилах. ML-прогноз доступен отдельно
через `/api/ml/predict` сотруднику банка, не меняет заявку и не используется для выдачи. Необязательная LLM объясняет
решение и включается отдельно. Все данные и интеграции демонстрационные.

## Быстрый запуск

Нужны Git, Docker и Docker Compose v2.20+. Для основного стенда достаточно 8 ГБ RAM; GPU не требуется.

```bash
git clone https://github.com/MrFerrumL/alpha-smart-credit-cabinet.git
cd alpha-smart-credit-cabinet
docker compose up --build -d --wait
```

Кабинет: <http://localhost:8080> · Swagger: <http://localhost:8000/api/docs>.

Демо-вход: `bakery@demo.local` — клиент, `analyst@demo.local` — аналитик; пароль `demo1234`.
Клиент подаёт заявку на «Экспресс-оборот» и проходит путь до выдачи, аналитик видит очередь исключений.
Подробные настройки и сценарии — [RUNBOOK.md](RUNBOOK.md).

## Архитектура

```mermaid
flowchart LR
    UI[React / TypeScript] --> N[nginx]
    N --> API[FastAPI / JWT / SSE]
    API --> DB[(PostgreSQL)]
    W[Worker / retries / circuit breaker] --> DB
    W --> M[ЕГРЮЛ / ФНС / БКИ / АБС mocks]
    API --> R[Кредитная политика / правила]
    API --> ML[Экспериментальный ML API / analyst only]
    T[Offline training / sklearn] --> J[Версионированные JSON-веса]
    J --> ML
```

Отдельный worker выполняет длительные проверки, очередь хранится в общей БД. API исполняет ML-модель обычной
математикой без scikit-learn и pickle; зависимости обучения устанавливаются отдельно.

## ML: воспроизвести эксперимент

Из корня репозитория, Python 3.12:

```bash
python -m venv .venv
# PowerShell: .venv\Scripts\Activate.ps1
# Linux/macOS: source .venv/bin/activate
python -m pip install -r backend/requirements-dev.txt -r backend/requirements-ml.txt
cd backend
python -m scripts.train_risk
python -m pytest -q ml_tests
```

Команда генерирует 12 000 строк с seed=42, обучает модель на 7 200, выбирает порог на 2 400 и оценивает
замороженную модель на оставшихся 2 400. Веса и отчёт сохраняются в `backend/app/ml/artifacts/`.
Масштабирование обучается только на train; target и идентификаторы не входят в признаки.

| Метрика на synthetic test | Модель | Константный baseline |
|---|---:|---:|
| ROC-AUC | 0.7998 | 0.5000 |
| Average Precision | 0.5012 | 0.1508 |
| Brier score ↓ | 0.1005 | 0.1281 |
| Log loss ↓ | 0.3368 | 0.4242 |

Это результат **синтетического эксперимента**, не оценка качества на реальных заёмщиках.
Полный [отчёт](backend/app/ml/artifacts/evaluation.json), [model card](docs/ml-model-card.md) и
[пример API](docs/ml-api.md) объясняют признаки, порог и ограничения.

## Проверки

После установки зависимостей, из `backend/`:

```bash
python -m pytest -q
python -m pytest -q ml_tests
python -m scripts.export_openapi --check
python -m scripts.export_collection --check
python -m scripts.export_state_diagram --check
```

Frontend: `cd frontend`, `npm ci`, `npm run build`. Smoke для запущенного стенда:
`python scripts/smoke.py`. GitHub Actions дополнительно проверяет PostgreSQL, миграции и браузерные сценарии;
отдельный ML workflow переобучает модель и сверяет экспорт с inference.

## Навигация для технического интервью

- [Доработки и темы для интервью](docs/portfolio.md)
- [Результаты локальной проверки](docs/verification.md)
- [Запуск, настройки и демо-сценарии](RUNBOOK.md)
- [Архитектура](docs/architecture.md), [модель данных](docs/data-model.md), [машина состояний](docs/state-machine.md)
- [API](docs/api.md), [OpenAPI](docs/openapi.json), [Postman](docs/postman_collection.json)
- [Кредитная политика](docs/scoring.md), [ML model card](docs/ml-model-card.md), [LLM](docs/llm.md)
- [Происхождение кода](PROVENANCE.md), [сторонние компоненты](THIRD_PARTY_NOTICES.md)

## Происхождение

Основа — [donaldtrumpdev-commits/alpha](https://github.com/donaldtrumpdev-commits/alpha), исходный commit
`14e1d0d3dffa81d86f2c34b0da8d57e075d05b0f`. История авторов сохранена. Новые ML-возможности и оформление
добавлены отдельными коммитами. Подробности — [PROVENANCE.md](PROVENANCE.md).
