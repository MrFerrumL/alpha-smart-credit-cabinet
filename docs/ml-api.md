# ML API: пример для PowerShell

API работает в обычном backend-контейнере. Обе ручки требуют роль `analyst`: без токена 401, клиенту 403.
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

Ручка принимает подготовленные признаки. Данные заявки автоматически не подгружаются, прогноз не сохраняется
в БД. Feature adapter, мониторинг распределения и журнал shadow-прогнозов — следующие этапы развития.
