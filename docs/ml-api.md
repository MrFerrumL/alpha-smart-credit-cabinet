# ML API: пример для PowerShell

API работает в обычном backend-контейнере. Все ML-ручки требуют роль `analyst`: без токена 401, клиенту 403.
Невалидные признаки возвращают 422.

```powershell
$base = 'http://localhost:8000'
$login = Invoke-RestMethod -Method Post -Uri "$base/api/auth/login" -ContentType 'application/json' -Body '{"email":"analyst@demo.local","password":"demo1234"}'
$headers = @{ Authorization = "Bearer $($login.access_token)" }
Invoke-RestMethod -Uri "$base/api/ml/model" -Headers $headers
$body = @{
    business_age_years = 5.0
    dsr = 0.25
    margin = 0.18
    max_overdue_days_24m = 0
    inquiries_90d = 2
    tax_debt_ratio = 0.0
    has_credit_history = $true
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$base/api/ml/predict" -Headers $headers -ContentType 'application/json' -Body $body
```

В Swagger `/api/docs`: выполнить `POST /api/auth/login`, нажать Authorize, вставить токен,
затем выполнить `GET /api/ml/model` и `POST /api/ml/predict` с примером.

## Как читать ответ

- `model_version`, `artifact_sha256` связывают прогноз с конкретными весами.
- `probability_default` — выход учебной модели на синтетических данных.
- `threshold`, `above_threshold` показывают применение порога, выбранного на validation.
- `intercept_log_odds + sum(contributions[].log_odds)` — логит; sigmoid от него равна прогнозу.
- `experimental=true`, `affects_credit_decision=false` — прогноз не меняет бизнес-процесс.

`POST /api/ml/predict` принимает подготовленные признаки. Прогноз не сохраняется в БД.

## Пакетный расчёт

```powershell
$features = $body | ConvertFrom-Json
$batch = @{ items = @($features, $features) } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri "$base/api/ml/predict-batch" -Headers $headers -ContentType 'application/json' -Body $batch
```

Вход `{"items":[...]}` содержит от 1 до 100 строк. Ответ `{"predictions":[...]}` сохраняет их порядок;
каждый элемент имеет тот же формат, что одиночный прогноз. Неверная строка отклоняет весь пакет с 422.
Это ограниченный синхронный API, не сервис фоновых пакетных заданий.

## Прогноз по сохранённой заявке

```powershell
$applicationId = 1 # замените на id отправленной и оценённой заявки вашего стенда
Invoke-RestMethod -Uri "$base/api/applications/$applicationId/ml-risk" -Headers $headers
```

| Поле | Значение |
|---|---|
| `status` | available или unavailable |
| `scoring_id`, `scored_at` | Конкретная сохранённая оценка и её время UTC |
| `source` | saved_scoring_snapshot |
| `unavailable_fields` | Поля, мешающие расчёту |
| `prediction` | Результат модели либо null |
| `affects_credit_decision` | false |

Ручка читает **последний** снимок по scoring id. При плохом последнем снимке не подменяет его старым.
Текущая анкета не используется. Аналитику недоступны черновики и несуществующие заявки (404).
При отсутствии снимка ответ 200/unavailable: это ожидаемое состояние данных, не сбой сервера.

`out_of_training_range` перечисляет значения за min/max train. Предупреждение не блокирует вычисление,
не является полноценным drift-анализом и не делает выход модели достоверным на реальных данных.

При отсутствии или повреждении весов ML отвечает 503 с `code=model_unavailable`. Локальный путь и исходный JSON
не выдаются. Модель загружается лениво и кэшируется на процесс; после исправления файла неуспешная загрузка
может быть повторена, а после замены успешно загруженных весов нужен перезапуск API.
Полноценный мониторинг распределения и постоянный журнал shadow-прогнозов пока не реализованы.
