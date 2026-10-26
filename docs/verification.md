# Проверка портфолио-версии

Дата: 26 октября 2026. Локальная среда: Windows, Python 3.12, SQLite для тестов и smoke.

| Проверка | Результат |
|---|---|
| `python -m pytest -q` в backend | 783 passed, 1 skipped |
| `python -m pytest -q ml_tests` | 3 passed |
| `python -m scripts.export_openapi --check` | Спецификация совпадает с кодом |
| `python -m scripts.export_collection --check` | Postman совпадает с кодом |
| `python -m scripts.export_state_diagram --check` | Диаграмма совпадает с кодом |
| `python -m pip check` | Конфликтов зависимостей нет |
| `npm ci`, `npm run build` в frontend | TypeScript и production build успешно |
| Локальный API + mocks + worker, миграции с нуля | Заявка создана, обработана, approved |
| HTTP login аналитика, `/api/ml/model`, `/api/ml/predict` | Успешно; SHA-256 совпадает; решение не изменяется |
| Экспорт модели против sklearn на 2 400 test-строках | max absolute error = 2.22e-16 |

Docker не установлен в локальной среде; Compose, PostgreSQL и браузерные e2e здесь не запускались.
Они настроены в унаследованном [CI workflow](../.github/workflows/ci.yml), актуальный результат смотрите
в [GitHub Actions](https://github.com/MrFerrumL/alpha-smart-credit-cabinet/actions).
ML-воспроизводимость вынесена в [отдельный workflow](../.github/workflows/ml.yml).

При локальном запуске ML-тестов временный каталог pytest был явно задан через `--basetemp`, поскольку
стандартный общий каталог Windows Temp недоступен текущему процессу. Это настройка среды, код тестов не менялся.
