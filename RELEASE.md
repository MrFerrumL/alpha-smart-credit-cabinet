# Версия на проверку

| | |
|---|---|
| Репозиторий | https://github.com/donaldtrumpdev-commits/alpha |
| Версия на дедлайн онлайн-этапа | тег `v1.0.0` (кандидаты — теги `v1.0.0-rc…`) |
| Ветка | `main` (после слияния `feat/e2e-completion`) |
| Дедлайн | 26.10.2026 |

Коммиты после дедлайна в проверяемую версию не входят: проверяется ровно то, на что указывает тег. Хеш
коммита тега указан в форме сдачи и в [docs/SUBMISSION.md](docs/SUBMISSION.md); проверить его можно так:

```bash
git fetch --tags
git rev-parse v1.0.0^{commit}
git checkout v1.0.0
```

## Как проверить

1. Запуск одной командой — раздел «Быстрый старт» в [README.md](README.md):

   ```bash
   docker compose up --build
   ```

2. Дымовая проверка стенда (Python 3.10+): `python scripts/smoke.py` — вход, заявка, одобрение.
3. Пошаговый сценарий на 10 минут — раздел «Проверка за 10 минут» в README; полный список сценариев с
   точными данными — [docs/test-scenarios.md](docs/test-scenarios.md).
4. Автотесты: `cd backend && pip install -r requirements-dev.txt && python -m pytest`. Тот же набор,
   сборка фронтенда, сверка документации с кодом, `docker compose up` с нуля, коллекция запросов через newman и
   сценарии всех демо-учёток в браузере (Playwright) выполняются в CI (GitHub Actions) на каждый коммит.

## Артефакты сдачи

| Требование кейса | Где |
|---|---|
| Документ к форме сдачи: версия, запуск, демо-учётки, основной сценарий, документы, ограничения | [docs/SUBMISSION.md](docs/SUBMISSION.md), PDF — [docs/SUBMISSION.pdf](docs/SUBMISSION.pdf) |
| README: назначение, архитектура, окружение, запуск, переменные, компоненты, сценарий проверки | [README.md](README.md) |
| Исследование, модель процесса, обоснование MVP | [docs/product.md](docs/product.md) |
| Архитектурная схема | [docs/architecture.md](docs/architecture.md) |
| Описание API и OpenAPI/Swagger | [docs/api.md](docs/api.md), [docs/openapi.json](docs/openapi.json), http://localhost:8000/api/docs |
| Коллекция запросов | [docs/postman_collection.json](docs/postman_collection.json) |
| Диаграмма состояний заявки | [docs/state-machine.md](docs/state-machine.md) |
| Модель данных | [docs/data-model.md](docs/data-model.md) |
| Тестовые сценарии | [docs/test-scenarios.md](docs/test-scenarios.md) |
| Синтетические данные и тестовые учётные записи | README, раздел «Демо-сценарии»; `backend/app/seed.py`, `mocks/mockapi/` |
| Сторонние компоненты и смоделированные интеграции | [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |
| Модель кредитного решения | [docs/scoring.md](docs/scoring.md) |
| История изменений | [CHANGELOG.md](CHANGELOG.md) |

## PDF к форме сдачи

`docs/SUBMISSION.pdf` собирается из `docs/SUBMISSION.md` (Node.js 22, Chromium из Playwright). Тег и хеш
коммита подставляются при сборке, сам документ при этом не меняется:

```bash
cd e2e
npm ci
npx playwright install chromium
npm run submission-pdf -- --tag v1.0.0 --commit "$(git rev-parse v1.0.0^{commit})"
```

## Доступ

Если репозиторий приватный, доступ на чтение выдан аккаунту жюри `alfa-hack-2026`
(Settings → Collaborators).
