# Отчёт о проверках Backend / ML v2

Дата: **26 октября 2026**. Среда: Windows AMD64, Python **3.12.14**, SQLite, Chromium от Playwright.
Ниже результаты локального прогона текущей доработки. Проверки CI на PostgreSQL/Compose имеют собственные
результаты для точного commit в [GitHub Actions](https://github.com/MrFerrumL/alpha-smart-credit-cabinet/actions).

**CI проверен 27 октября 2026:** оба workflow для кода `52400680f40b184af22a28788cf375cd3d3fad52`
завершились успешно. Прогоны выполнены 26 октября; ниже отдельно зафиксированы их реальные JUnit-результаты.

## Проверка на PostgreSQL и Docker в GitHub Actions

| Набор CI | Результат | Время тестов |
|---|---:|---:|
| Backend на PostgreSQL, включая advisory lock | **816 passed**, без пропусков | 66.10 с |
| Полная основная browser-suite через nginx / Compose | **31 passed** | 344.46 с |
| Переобучение и воспроизводимость ML | **3 passed** | 1.04 с |
| Отдельный ML inference / access-control job | **45 passed** | 1.71 с |

Последние 45 тестов являются частью Backend-suite и повторно проверены в отдельном ML workflow:
их нельзя прибавлять к 816 как новые уникальные сценарии. PostgreSQL-прогон не содержит пропущенного локально
теста миграционных блокировок. Все выгруженные JUnit-файлы имеют 0 failures и 0 errors.

Также успешно завершились сборка frontend, миграции и `alembic check`, чистый запуск Compose,
smoke, Postman/newman-сценарий, LLM-пояснение с fake-моделью и запись основного сценария на видео.
Эти результаты подтверждены состоянием jobs и steps, а не выводятся из количества pytest-тестов.

| Покрытие Backend в CI | Выполнено / всего | Процент |
|---|---:|---:|
| Строки | 4 308 / 4 600 | **93.65%** |
| Переходы | 856 / 990 | **86.46%** |
| Строки и переходы вместе | 5 164 / 5 590 | **92.38%** |

Небольшое отличие от локальных значений ожидаемо: PostgreSQL/Linux и SQLite/Windows посещают разные
ветви работы с БД, временем и файловой системой. Порог CI 80% пройден.

Доказательства: [основной CI](https://github.com/MrFerrumL/alpha-smart-credit-cabinet/actions/runs/40355625394),
[ML workflow](https://github.com/MrFerrumL/alpha-smart-credit-cabinet/actions/runs/40355625529),
[машиночитаемая сводка CI](reports/ci-summary.json). На страницах прогонов доступны исходные JUnit/coverage,
отчёт о ресурсах и demo-video в артефактах с ограниченным сроком хранения.

## Локальный прогон

| Проверка | Результат | Длительность / детали |
|---|---|---|
| Backend pytest под coverage | **815 passed, 1 skipped** | 109.69 с, 0 failures, 0 errors |
| Отдельная ML training suite | **3 passed** | 3.40 с; seed, retraining, baseline, export parity |
| Chromium: ML + карточка аналитика | **6 passed** | 33.4 с; 4 новых и 2 существующих сценария |
| TypeScript + Vite build | Успешно | Production bundle собран |
| OpenAPI drift check | Успешно | Спецификация совпадает с app.openapi() |
| Postman drift check | Успешно | Коллекция соответствует API |
| State diagram drift check | Успешно | Переходы совпадают с кодом |
| pip check | Успешно | Конфликтов зависимостей нет |

Backend-тесты включают API, машину состояний, интеграции, аудит, подпись, worker, правила, LLM-validation и ML.
Целевые ML API-тесты уже входят в 815; они не прибавляются повторно к этому количеству.
Пропущен PostgreSQL-specific тест конкурентной advisory lock миграций: SQLite не поддерживает этот механизм.
Он запускается в PostgreSQL job CI. Browser-стенд разворачивался с новой SQLite-базой и миграциями с нуля.

## Покрытие

Измерялся весь `backend/app`, без исключения непокрытого служебного кода.

| Показатель | Выполнено / всего | Процент |
|---|---:|---:|
| Исполняемые строки | 4 309 / 4 600 | **93.67%** |
| Переходы | 857 / 990 | **86.57%** |
| Строки и переходы вместе | 5 166 / 5 590 | **92.42%** |

ML inference, artifact contract и ML router имеют 100% совокупного coverage в этом прогоне.
Adapter заявки — 98.04%: SQLite не посещает ветку уже timezone-aware timestamp; PostgreSQL обрабатывает время
иначе. Включённый в общий отчёт служебный `app/explanation/bench.py` имеет 0%; worker — 76.54%, approval map —
78.48%. Эти пробелы не скрыты настройкой exclude. Coverage отражает выполнение кода, не готовность к production.

Машиночитаемая сводка: [verification-summary.json](reports/verification-summary.json).
Команды и смысл уровней проверок: [testing.md](testing.md).

## Какие гарантии проверены в новой части

- Прогноз вычисляется по последнему сохранённому scoring snapshot, источник указан через scoring_id/scored_at.
- Повторное чтение не меняет заявку и количество событий, оценок или предложений.
- Нет снимка или обязательных полей — нет выдуманной вероятности; возвращается unavailable.
- Роли и закрытые черновики защищены на Backend.
- Batch сохраняет порядок, ограничен 100 строками и отклоняет неверный пакет целиком.
- Повреждённый/отсутствующий JSON даёт 503 без локального пути или содержимого артефакта.
- При сбое ML readiness и каталог остаются доступны, UI позволяет повторить расчёт.
- Корректный ввод вне min/max train получает предупреждение.
- Adapter не теряет долю налогового долга из-за overflow при расчёте годовой выручки.
- В браузере клиенту не показывается аналитическая ML-панель.

## ML-эксперимент

Модель `synthetic-risk-logreg-v2`, dataset v2, 12 000 синтетических строк, split 7 200 / 2 400 / 2 400.
ROC-AUC **0.7842**, Average Precision **0.4540**, Brier **0.1013**, log loss **0.3385** на test.
Порог **0.11** выбран на validation по условной стоимости `5 × FN + FP`.
Это учебный результат на сгенерированном датасете, не качество реального кредитного портфеля.
Полные значения и calibration bins — в [evaluation.json](../backend/app/ml/artifacts/evaluation.json).

## Скорость вычисления

10 000 warm inference после 200 warmup на одной строке, в одном процессе:

| Метрика | Микросекунды |
|---|---:|
| p50 | 10.3 |
| p95 | 19.5 |
| p99 | 29.4 |
| Среднее | 13.478 |

Время не включает HTTP, JWT, БД, concurrency и запуск процесса. Это не API load test и не SLO.
Результат зависит от машины и нагрузки. Исходные данные: [inference-benchmark.json](reports/inference-benchmark.json).

## Ограничения проверки

Локально Docker не установлен: nginx, PostgreSQL и полный Compose проверяются в GitHub Actions.
Локальные браузерные тесты используют development Vite proxy; это не та же среда, что nginx в Docker.
Не выполнялись soak/load, межбраузерная матрица, disaster recovery, реальная банковская интеграция или
валидация модели на реальных наблюдениях. Реальные деньги и внешние SMS/почта не задействованы.

Backend/ML JUnit XML, HTML coverage и browser JUnit доступны как результаты прогона. В CI настроено сохранение
`backend-test-reports`, `ml-test-reports` и `browser-test-results` на 14 дней. Для Windows pytest использован
отдельный `--basetemp` в рабочем каталоге из-за прав доступа к общему Temp.
