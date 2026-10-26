# Тестирование: стратегия, команды и интерпретация

Численные результаты последнего прогона: [verification.md](verification.md). Этот документ описывает,
что именно доказывают проверки и как повторить их самостоятельно.

## Уровни проверок

| Уровень | Что запускается | Что проверяется | Чего это не доказывает |
|---|---|---|---|
| Domain | `backend/tests/test_policy.py`, `test_products.py`, `test_state_machine.py` | Формулы, ограничения и переходы | Доступность реальных банковских систем |
| API / integration | Backend pytest + TestClient + mock HTTP | Роли, данные, ошибки, бизнес-сценарии | HTTP deployment, proxy и browser rendering |
| Persistence | CI с PostgreSQL и Alembic | Миграции, advisory lock, основная suite | Поведение на production-нагрузке |
| ML serving | `test_ml.py`, `test_ml_applications.py` | Контракт, corrupt artifact, snapshot, batch, отсутствие записей | Качество модели на реальных клиентах |
| ML training | `backend/ml_tests/` | Seed, split, baseline, воспроизведение и parity | Временную устойчивость и fairness |
| Frontend build | TypeScript + Vite | Типы и сборка production bundle | Корректность всех пользовательских действий |
| Browser | Playwright Chromium | Реальный UI и API, формы, решения, деградация ML | Совместимость со всеми браузерами |
| Compose e2e | GitHub Actions | Чистый запуск, proxy, коллекция, browser, запись демо | Production availability или реальную выдачу денег |

## Подготовка окружения

Python 3.12, Node.js совместимой с frontend версии. Из корня:

```bash
python -m venv .venv
# Windows PowerShell:
# .venv\Scripts\Activate.ps1
# Linux/macOS:
# source .venv/bin/activate
python -m pip install -r backend/requirements-dev.txt -r backend/requirements-ml.txt
```

Зависимости обучения можно не устанавливать для обычной Backend-suite: API не импортирует sklearn.
Окружение и API-ключи не должны попадать в Git; тестовые данные синтетические.

## Backend и покрытие

```bash
cd backend
python -m coverage run -m pytest -q --junitxml=test-results/backend.xml
python -m coverage report --fail-under=80
python -m coverage xml
python -m coverage html
```

По умолчанию pytest создаёт временную SQLite-базу. Для PostgreSQL задайте `TEST_DATABASE_URL`, а перед прогоном
примените `alembic upgrade head` к соответствующей тестовой базе через `DATABASE_URL`. Тесты меняют данные;
не направляйте их на рабочую БД. В CI база создаётся как отдельный сервис.

`backend/.coveragerc` включает branch coverage и весь `app`, включая мало покрытые служебные модули.
В сводном проценте coverage учитывает исполняемые строки и переходы. Это показатель выполнения кода,
а не самостоятельное доказательство качества assertions. HTML показывает непосещённые ветви.
CI сохраняет JUnit XML и coverage XML в артефакте `backend-test-reports`, даже при падении тестов.

Если общий Windows Temp недоступен, укажите отдельную пустую директорию через `--basetemp`.
Pytest управляет содержимым этой директории; используйте путь только для тестовых временных файлов.

## Новые сценарии ML

```bash
python -m pytest -q tests/test_ml.py tests/test_ml_applications.py
python -m pytest -q ml_tests
```

| Сценарий | Ожидаемый результат |
|---|---|
| Запрос без токена / под клиентом | 401 / 403 для ML |
| Аналитик запрашивает клиентский черновик | 404, объект не раскрывается |
| Прогноз по отправленной оценённой заявке | Последний scoring_id, timestamp UTC и reproducible prediction |
| Нет снимка или обязательного признака | unavailable, probability отсутствует |
| Дважды прочитан ML-прогноз | Заявка, события, scoring rows и offers не изменились |
| NaN, Infinity, типы/границы нарушены | 422 на входе или отказ адаптера снимка |
| Пакет 1–100 строк | Порядок совпадает с входом, результаты равны одиночным запросам |
| Пустой, слишком большой или частично неверный пакет | 422 всего пакета, частичный результат не возвращается |
| Файл весов отсутствует / повреждён | 503 без содержимого файла и локального пути |
| ML недоступен | Health readiness и каталог продуктов продолжают отвечать |
| Валидный признак вне min/max train | Прогноз с предупреждением о диапазоне |
| JSON inference против sklearn | Ошибка < 1e-12 на всех test-строках |

Границы весов и масштаба ограничивают риск численного overflow из повреждённого локального артефакта.
Сами веса не принимаются через API. Параметры после загрузки неизменяемы, кэш общий на процесс.

## Browser e2e без Docker

Установите npm-зависимости отдельно в `frontend/` и `e2e/`. Из `e2e/`:

```bash
npm ci
npx playwright install chromium
```

Из корня, с активным Python-окружением:

```bash
python scripts/run_local_e2e.py ml-risk.spec.ts analyst-card.spec.ts
```

Launcher проверяет свободные порты 8000, 8001, 18080, создаёт новый каталог `.local-e2e/run-*`, мигрирует
SQLite, запускает mocks, API, worker и Vite. Затем запускает Playwright и завершает свои процессы.
Логи и изолированная БД остаются для диагностики; launcher не очищает пользовательские базы.
Можно передать другие имена `.spec.ts`. Это development smoke; он не повторяет nginx/PostgreSQL из Compose.

Новые browser-сценарии проверяют реальный прогноз в карточке, раскрытие вкладов, отсутствие выдуманного значения,
восстановление после 503 и отсутствие аналитического блока у клиента. Для двух ветвей UI ответ намеренно
подменяется через Playwright route; ошибки сервера отдельно проверяются Backend-тестами.

## Согласованность документации

Из `backend/`:

```bash
python -m scripts.export_openapi --check
python -m scripts.export_collection --check
python -m scripts.export_state_diagram --check
```

Эти проверки предотвращают расхождение API, Postman и диаграммы с кодом. Для обновления файлов выполните
те же команды без `--check`, затем просмотрите diff. Проверка точного содержимого документации полезна
для контрактов, но не заменяет тесты поведения API.

## Измерение времени inference

```bash
python -m scripts.benchmark_risk --iterations 10000 --output benchmark.json
```

Измеряются 10 000 вызовов после 200 warmup, в одном процессе и на одной строке. Сохраняются p50/p95/p99,
среднее, версия модели, SHA-256, Python и ОС. Время **не включает** HTTP, JWT, БД, конкурентные запросы или
запуск процесса. Число нельзя выдавать за API latency или production SLO. Результат зависит от машины и
параллельной нагрузки; воспроизведение допускает другое время.

## Известные пробелы

Нет полноценного нагрузочного/soak-теста API, межбраузерной матрицы, тестирования реальных внешних источников,
восстановления backup или real-world ML validation. SQLite пропускает PostgreSQL advisory-lock integration.
Автоматические проверки не отменяют ручной просмотр UX и независимую проверку безопасности перед production.
