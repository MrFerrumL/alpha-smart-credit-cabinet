# API «Поток»: описание для людей

Машиночитаемая спецификация — [openapi.json](openapi.json) (генерируется из кода). Этот документ объясняет то,
чего в ней нет: правила доступа, формат ошибок, идемпотентность, живой статус, сквозной сценарий и эмулятор
внешних систем. Список ручек ниже сверен с `openapi.json`.

## 1. Основы

| Что | Адрес |
|---|---|
| Базовый URL через nginx (как ходит кабинет) | `http://localhost:8080/api` |
| Базовый URL напрямую в backend (только с этой машины) | `http://localhost:8000/api` |
| Swagger UI | `http://localhost:8000/api/docs` |
| Схема «вживую» | `http://localhost:8000/api/openapi.json` |
| Проверки живости (вне префикса `/api`) | `/health/live`, `/health/ready` (есть и на `:8080`, и на `:8000`) |
| Формат | JSON, UTF-8; даты — ISO 8601 в UTC; суммы — целые рубли; ставки — проценты годовых |
| Корреляция | Заголовок `X-Request-ID` принимается и возвращается в ответе (до 64 символов) |

**Файлы в репозитории**

| Файл | Назначение |
|---|---|
| `docs/openapi.json` | Спецификация OpenAPI 3, источник правды по путям и полям |
| `docs/postman_collection.json` | Коллекция Postman v2.1 (подходит Insomnia и Bruno), собрана из `openapi.json` скриптом `python -m scripts.export_collection` |

**Как пользоваться коллекцией**

1. Поднимите стенд (`docker compose up`) и импортируйте `docs/postman_collection.json`.
2. Переменные коллекции: `base_url` (по умолчанию `http://localhost:8080`; для прямого доступа — `http://localhost:8000`),
   `token`, `application_id`, `challenge_id`, `signing_code`, `loan_id`, `task_id`, `code` (код продукта, по умолчанию `express`).
   `token`, `application_id`, `challenge_id`, `signing_code` и `loan_id` заполняют тест-скрипты сами.
3. Папка «Сквозной сценарий: от заявки до выдачи» — 10 запросов по порядку (или целиком через Runner либо
   `newman run docs/postman_collection.json --folder "Сквозной сценарий: от заявки до выдачи"`). Шаги 4 и 9 —
   опрос статуса: в Runner и newman они повторяются сами раз в секунду, пока не будет `approved` и `issued`;
   при ручном запуске повторяйте их. Учётка `bakery@demo.local`, продукт `express`.
4. Остальные папки — по одной на раздел API.

## 2. Аутентификация

`POST /api/auth/login` (почта и пароль) и `POST /api/auth/demo-login` (только почта тестовой учётки) возвращают
`TokenOut`: `{access_token, token_type, user}`. Токен — JWT (HS256) с полями `sub` (id пользователя), `role`
(`client` или `analyst`), `iat`, `exp`; срок жизни 12 часов. Передавайте его в заголовке:

```
Authorization: Bearer <access_token>
```

Пользователь при каждом запросе перечитывается из БД по `sub`; роль берётся из БД, а не из токена.

| Роль | Кто | Что может |
|---|---|---|
| `client` | Сотрудник компании-заёмщика. Компания привязывается по ИНН (`POST /api/companies/link`) | Заявки своей компании, документы, ответы на запросы банка, кредиты, лента |
| `client`, `can_sign = true` | Руководитель (директор, ИП) | Всё то же + принять или отклонить предложение, запросить код и подписать договор |
| `client`, `can_sign = false` | Бухгалтер и другие сотрудники | Готовит и отправляет заявку, передаёт предложение руководителю (`offer/handoff`); принять, отказаться и подписать не может |
| `analyst` | Кредитный аналитик банка | Очередь отправленных заявок (черновиков не видит), карточка оценки, решение, симулятор политики |

Право подписи не берётся на веру: `can_sign` выставляется при привязке компании по выписке ЕГРЮЛ, а при каждом принятии,
отказе, запросе кода и подписании ФИО пользователя сверяется с текущим руководителем компании в реестре. Сменился
директор — прежний сотрудник подписать уже не сможет (`403 forbidden`).

Публичные ручки (без токена): `auth/login`, `auth/demo-accounts`, `auth/demo-login`, `meta`, `products`,
`products/match`, `products/{code}/calculate`, `health/*`.

Тестовые учётки: `GET /api/auth/demo-accounts`; пароль у всех `demo1234`. Демо-вход и список работают только при
включённом демо-режиме (`demo_mode`), иначе `demo-accounts` возвращает `[]`, а `demo-login` — `404`.

## 3. Формат ошибок

Любая ошибка (кроме `503` у `/health/ready`) приходит в одном виде:

```json
{
  "status": 422,
  "code": "validation_error",
  "title": "Проверьте введённые данные",
  "detail": "Заявку нельзя отправить: параметры не подходят под продукт.",
  "errors": [{ "field": "form.consent_bki", "message": "Нужно согласие на запрос в бюро кредитных историй" }]
}
```

`title`/`detail` можно показывать пользователю, логика строится по `code`. Поле `errors` есть только у `422`.

| HTTP | `code` | Когда |
|---|---|---|
| 401 | `unauthorized` | Нет токена, он просрочен или испорчен; неверная почта или пароль |
| 403 | `forbidden` | Не та роль; нет права подписи; ФИО не совпадает с руководителем по ЕГРЮЛ; сумма выше полномочий аналитика |
| 404 | `not_found` | Нет такого объекта. Чужая заявка тоже даёт 404, а не 403 — существование не раскрывается. Аналитик не видит черновики |
| 409 | `conflict` | Состояние не позволяет действие (заявка уже отправлена, предложение не активно, код не действует, компания уже привязана) |
| 409 | `invalid_transition` | Машина состояний не допускает такой переход ([state-machine.md](state-machine.md)) |
| 409 | `concurrent_update` | Заявку параллельно изменили (оптимистичная блокировка) — перечитайте и повторите |
| 422 | `validation_error` | Ошибки полей: и схема запроса, и бизнес-правила; список в `errors[]` как `{field, message}` |
| 429 | `too_many_requests` | Больше 5 запросов кода подписи за час по одной заявке |
| 503 | `integration_unavailable` | Внешний источник (ЕГРЮЛ) не ответил: `companies/lookup`, `companies/link` |
| 500 | `internal_error` | Непредвиденная ошибка |
| любой | `http_error` | Ошибки самого HTTP-слоя (неизвестный путь, неверный метод) |

## 4. Идемпотентность, версии и `allowed_actions`

| Механизм | Как работает |
|---|---|
| `Idempotency-Key` | Необязательный заголовок (до 64 символов) у `POST /api/applications/{id}/submit`. Ключ хранится в самой заявке, то есть действует в границах одной заявки. Повтор с тем же ключом (двойной клик, ретрай сети) возвращает ту же заявку и `200`, не запуская конвейер второй раз. Повтор без ключа или с другим ключом после отправки — `409 conflict` |
| Оптимистичная блокировка | У заявки есть версия. Если между чтением и записью заявку изменил кто-то другой (например, параллельный отзыв и подпись), запись получит `409 concurrent_update`, а не пройдёт молча |
| Другие защиты от повторов | Код подписи погашается условным обновлением (второй запрос с тем же кодом не пройдёт); выдача в АБС идемпотентна по номеру договора |
| `allowed_actions` | Массив в `ApplicationOut` — **единственный источник правды для кнопок**: UI не выводит доступность действий из статуса сам. Список считается на сервере для текущего пользователя |

Значения `allowed_actions`:

| Значение | Кому и когда | Ручка |
|---|---|---|
| `edit`, `submit` | Клиент, статус `draft` | `PATCH`, `submit` |
| `answer_tasks` | Клиент, статус `needs_info` или условия выдачи при `signing` | `tasks/{id}/answer`, `documents` |
| `accept_offer`, `decline_offer` | Клиент с правом подписи, статус `approved`/`counter_offer`, предложение активно | `offer/accept`, `offer/decline` |
| `handoff_to_signer` | Клиент без права подписи, то же состояние (пропадает, когда уже передано; в заявке `awaiting_signer = true`) | `offer/handoff` |
| `sign` | Клиент с правом подписи, статус `signing`, договор не подписан | `signing/code`, `signing/confirm` |
| `cancel` | Клиент, пока заявка не завершена; на этапе предложения — только с правом подписи; после подписи нельзя | `cancel` |
| `decide` | Аналитик, статус `manual_review` | `decision` |

## 5. Живой статус заявки (SSE)

`GET /api/applications/{id}/stream` — Server-Sent Events. Доступ проверяется до начала потока: чужая заявка даёт обычный `404`.

| Параметр | Значение |
|---|---|
| Заголовки ответа | `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no` |
| Событие | `event: update`, `data:` — JSON `StreamSnapshot`: `{status, title, tone, terminal, last_event_id, open_tasks}` |
| Когда приходит | Сразу после подключения, затем при каждом изменении снимка (сервер сверяет его раз в секунду) |
| Пинг | Строка-комментарий `: ping` после 15 секунд без изменений |
| Закрытие | Сервер закрывает поток после события с `terminal = true`: статусы `rejected`, `issued`, `cancelled`, `expired` |

Нативный `EventSource` не умеет передавать `Authorization`, поэтому поток читают через `fetch`:

```js
const res = await fetch(`/api/applications/${id}/stream`, { headers: { Authorization: `Bearer ${token}` } });
const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
// читайте блоки, разделённые пустой строкой; строки, начинающиеся с ":", — пинг
```

```bash
curl -N -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/applications/1/stream
```

Пример события:

```
event: update
data: {"status":"approved","title":"Одобрено","tone":"success","terminal":false,"last_event_id":14,"open_tasks":0}
```

Поток не заменяет `GET /api/applications/{id}`: по событию перечитайте заявку. Если поток недоступен, используйте опрос.

## 6. Ручки по группам

Все пути даны с префиксом `/api`, кроме `health`. «Любая» роль — любой авторизованный пользователь; клиент видит
только заявки своей компании, аналитик — все отправленные.

### Вход (`auth`)

| Метод | Путь | Роль | Назначение |
|---|---|---|---|
| POST | `/api/auth/login` | публично | Вход по почте и паролю → `TokenOut` |
| GET | `/api/auth/demo-accounts` | публично | Тестовые учётки и их сценарии (только в демо-режиме) |
| POST | `/api/auth/demo-login` | публично | Вход в один клик, тело `{email}` → `TokenOut` |
| GET | `/api/auth/me` | любая | Текущий пользователь: `role`, `can_sign`, `company` |

### Справочники и продукты (`meta`, `products`)

| Метод | Путь | Роль | Назначение |
|---|---|---|---|
| GET | `/api/meta` | публично | Этапы, статусы (`code`, `title`, `hint`, `stage`, `tone`, `action_required`, `terminal`) и цели кредита |
| GET | `/api/products` | публично | Каталог продуктов (`express`, `invest`, `overdraft`) |
| POST | `/api/products/match` | публично | Подбор продукта по `{purpose, amount, term_months}` → список `MatchOut` с обоснованием |
| GET | `/api/products/{code}/calculate` | публично | Платёж и график; query `amount`, `term_months` |

Цели (`purpose`): `working_capital`, `cash_gap`, `equipment`, `expansion`, `contract`.

### Компании (`companies`)

| Метод | Путь | Роль | Назначение |
|---|---|---|---|
| GET | `/api/companies/lookup` | любая | Карточка из ЕГРЮЛ/ЕГРИП; query `inn` (10 или 12 цифр) |
| POST | `/api/companies/link` | client | Привязать компанию по `{inn}`. Может руководитель или учредитель по выписке; право подписи получает только руководитель |
| GET | `/api/companies/me/financials` | client | Выручка и расходы в месяц, сотрудники, налоговый режим по данным ФНС; `available = false`, если данных нет |

### Заявки: жизненный цикл клиента (`applications`)

| Метод | Путь | Роль | Назначение |
|---|---|---|---|
| GET | `/api/applications` | любая | Список; необязательный query `status` |
| POST | `/api/applications` | client | Создать черновик (`201`), тело `ApplicationCreate` |
| GET | `/api/applications/{application_id}` | любая | Заявка с `allowed_actions`, предложением, решением |
| PATCH | `/api/applications/{application_id}` | client | Изменить черновик (любые поля `ApplicationCreate`); иначе `409` |
| POST | `/api/applications/{application_id}/submit` | client | Отправить в банк; заголовок `Idempotency-Key` |
| POST | `/api/applications/{application_id}/cancel` | client | Отозвать заявку; тело необязательно: `{comment}` |
| GET | `/api/applications/{application_id}/events` | любая | История (аналитику виден также `internal_comment`) |
| GET | `/api/applications/{application_id}/stream` | любая | Живой статус, SSE (раздел 5) |

### Запросы банка, документы, проверки

| Метод | Путь | Роль | Назначение |
|---|---|---|---|
| GET | `/api/applications/{application_id}/tasks` | любая | Запросы банка (`kind`: `document`, `field`, `question`) |
| POST | `/api/applications/{application_id}/tasks/{task_id}/answer` | client | Ответить на запрос, тело `{answer}`. Для `document` нужна загрузка файла |
| GET | `/api/applications/{application_id}/documents` | любая | Документы заявки |
| POST | `/api/applications/{application_id}/documents` | client | Загрузить файл (`201`), `multipart/form-data`: `file`, `kind` (`bank_statement`, `financial_report`, `collateral`, `other`), `task_id` (необязательно). Допустимы pdf, png, jpg, xlsx, xls, csv, doc, docx, txt |
| GET | `/api/applications/{application_id}/checks` | любая | Ход проверок во внешних источниках (`status`, `attempts`); `data` с содержимым получает только аналитик |

### Предложение, договор, подписание

| Метод | Путь | Роль | Назначение |
|---|---|---|---|
| POST | `/api/applications/{application_id}/offer/accept` | client с правом подписи | Принять предложение: статус `signing`, появляется номер договора |
| POST | `/api/applications/{application_id}/offer/decline` | client с правом подписи | Отказаться от предложения → `cancelled`; тело необязательно: `{comment}` |
| POST | `/api/applications/{application_id}/offer/handoff` | client без права подписи | Передать предложение руководителю: ему приходит уведомление в кабинете |
| GET | `/api/applications/{application_id}/contract` | любая | Договор: разделы, график, `signed`, `terms_hash`, `issue_delayed`. До принятия предложения — `404` |
| POST | `/api/applications/{application_id}/signing/code` | client с правом подписи | Выдать одноразовый код (`SigningCodeOut`); новый код отменяет прежние; не более 5 в час на заявку |
| POST | `/api/applications/{application_id}/signing/confirm` | client с правом подписи | Подписать, тело `{challenge_id, code}` |

Параметры кода: срок жизни 300 с, 3 попытки на код. Код привязан к хешу условий договора — подписать можно ровно те условия,
которые клиент видел. После подписи воркер выдаёт деньги через АБС и переводит заявку в `issued`; если по продукту есть
условия выдачи (залог, поручительство), выдача начнётся, когда клиент закроет последнее.

### Аналитик

| Метод | Путь | Роль | Назначение |
|---|---|---|---|
| GET | `/api/applications/{application_id}/assessment` | analyst | Карточка: причина ручного рассмотрения, оценка и факторы, стоп-факторы, выручка заявленная и подтверждённая, рекомендация конвейера, лимиты, трасса правил, `can_decide` |
| POST | `/api/applications/{application_id}/assessment/replay` | analyst | Воспроизвести решение конвейера на сохранённых признаках и сравнить с исходом; ничего не меняет |
| POST | `/api/applications/{application_id}/decision` | analyst | Решение по заявке в статусе `manual_review` |
| POST | `/api/policy/simulate` | analyst | «Что если» для порогов политики на сохранённых заявках; данные не меняются |

`outcome` в решении:

| `outcome` | Что делает | Обязательные поля кроме `comment` |
|---|---|---|
| `approve` | Одобрение на запрошенных условиях → `approved` | — (`rate` необязательно, не ниже ставки грейда) |
| `counter_offer` | Другие условия, сумма не больше запрошенной → `counter_offer` | `amount`, `term_months` |
| `request_info` | Запрос клиенту → `needs_info` | `task_title`; `task_kind` (`document` или `question`), `task_description` |
| `reject` | Отказ → `rejected` | `reasons[]` (для клиента), `tips[]` необязательно |
| `retry_checks` | Повторить проверки источников → `enrichment` | — (работает, только если какой-то источник не ответил) |

Стоп-факторы не переопределяются, нагрузка не выше политики, сумма в пределах полномочий аналитика. `comment` обязателен
и клиенту не показывается; `client_message` — текст для клиента (иначе подставится стандартный).

### Кредиты, уведомления, лента

| Метод | Путь | Роль | Назначение |
|---|---|---|---|
| GET | `/api/loans` | client | Кредиты компании |
| GET | `/api/loans/{loan_id}` | client | Кредит, остаток, график платежей |
| GET | `/api/notifications` | любая | Последние уведомления кабинета (вместо SMS и почты) |
| POST | `/api/notifications/read-all` | любая | Отметить прочитанными (`204`) |
| GET | `/api/feed` | client | Персональная лента новостей; новости синтетические (`is_synthetic`) |

### Служебное (`health`)

| Метод | Путь | Роль | Назначение |
|---|---|---|---|
| GET | `/health/live` | публично | Процесс жив: `{"status":"ok"}` |
| GET | `/health/ready` | публично | Готовность: `200 {"status":"ok","db":"up"}` или `503 {"status":"unavailable","db":"down"}` (не в формате ошибок) |

## 7. Основной сценарий

Учётка `bakery@demo.local` (директор, право подписи), продукт `express`: заявка одобряется автоматически примерно за 10 секунд.
Все запросы идут с `Authorization: Bearer <token>`, кроме первого.

**1. Вход**

```http
POST /api/auth/demo-login
{ "email": "bakery@demo.local" }
```

В ответе `access_token` и `user`.

**2. Черновик** (`201`, в ответе `id`, `status.code = "draft"`, `allowed_actions = ["edit","submit","cancel"]`)

```http
POST /api/applications
{
  "product_code": "express",
  "purpose": "working_capital",
  "amount": 3000000,
  "term_months": 12,
  "form": { "finance": { "monthly_revenue": 4000000 }, "consent_bki": true }
}
```

**3. Отправка** (без `consent_bki` будет `422` с `errors[].field = "form.consent_bki"`)

```http
POST /api/applications/{id}/submit
Idempotency-Key: 0f8a1c3e-5b6d-4e7f-8a9b-1c2d3e4f5a6b
```

**4. Ожидание решения.** Откройте `GET /api/applications/{id}/stream` или опрашивайте `GET /api/applications/{id}`.
Путь статусов: `submitted` → `validation` → `enrichment` → `scoring` → `approved`. Если банку не хватает данных —
`needs_info` (ответьте на `tasks`), если нужен специалист — `manual_review`.

**5. Принять предложение** (в `allowed_actions` есть `accept_offer`; статус станет `signing`)

```http
POST /api/applications/{id}/offer/accept
```

Договор — `GET /api/applications/{id}/contract`.

**6. Код подписи.** Электронная подпись **смоделирована**: вместо SMS код возвращается в ответе (`demo_code`) и показывается в окне подписания.

```http
POST /api/applications/{id}/signing/code
```
```json
{ "challenge_id": 7, "expires_at": "2026-10-23T12:05:00Z", "attempts_left": 3, "delivery": "in_app", "demo_code": "482913" }
```

**7. Подписание**

```http
POST /api/applications/{id}/signing/confirm
{ "challenge_id": 7, "code": "482913" }
```

Неверный код — `422` с `errors[0].field = "code"` и числом оставшихся попыток.

**8. Выдача.** Воркер переводит деньги через АБС, заявка получает `status.code = "issued"` и `loan_id`; поток закрывается.

```http
GET /api/loans/{loan_id}
```

**Решение аналитика** (`analyst@demo.local`, заявка в `manual_review`, например `vector@demo.local`):

```http
POST /api/applications/{id}/decision
{
  "outcome": "counter_offer",
  "comment": "Прибыль покрывает платёж только на длинном сроке; ставка по грейду C.",
  "amount": 19500000,
  "term_months": 60,
  "rate": 23.5,
  "client_message": "Предлагаем 19,5 млн на 60 месяцев: на запрошенном сроке платёж не покрывается прибылью."
}
```

Запрос информации:

```json
{ "outcome": "request_info", "comment": "Нужна выписка", "task_kind": "document", "task_title": "Выписка по счёту за 6 месяцев" }
```

Отказ:

```json
{ "outcome": "reject", "comment": "Текущая просрочка", "reasons": ["Есть текущая просрочка по кредиту"], "tips": ["Погасите просрочку и подайте заявку снова"] }
```

**Симулятор политики** (`POST /api/policy/simulate`, диапазоны: `max_dsr` 0.1–0.9, `min_coverage` 0.5–3.0):

```json
{ "max_dsr": 0.5, "min_coverage": 1.3 }
```

Ответ: `applications` (сколько заявок пересчитано), `current` и `simulated` (`max_dsr`, `min_coverage`, `counts` по исходам,
`approval_share`, `offered_total`) и `changed[]` — заявки, у которых изменился исход или предложенная сумма.

## 8. Эмулятор внешних систем

Эмулятор (`mocks/`, порт **8001**, доступен только с локальной машины) подменяет ЕГРЮЛ/ЕГРИП, ФНС «Прозрачный бизнес», БКИ и АБС
банка. Это **симуляция на синтетических данных**: контракты упрощены, реальных запросов никуда не уходит. Backend ходит
в эмулятор сам (воркер — с таймаутами и ретраями); клиентам эмулятор не нужен. Swagger: `http://localhost:8001/docs`.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/egrul/{inn}` | Выписка ЕГРЮЛ/ЕГРИП (ИНН из 10 или 12 цифр, иначе `404`) |
| GET | `/fns/{inn}` | Данные ФНС: выручка, расходы, сотрудники, налоговый режим |
| GET | `/bki/{inn}` | Кредитный отчёт: `loans[]` и `summary` (просрочки, платежи, запросы за 90 дней) |
| POST | `/abs/disbursements` | Выдача кредита в АБС: `{contract_number, inn, amount}` → `{payment_id, status: "executed", ...}`. Номер договора — ключ идемпотентности: повтор возвращает тот же платёж |
| POST | `/admin/faults` | Включить или снять сбой источника |
| GET | `/admin/faults` | Текущие сбои |
| GET | `/health` | Проверка эмулятора |

Тело `POST /admin/faults`:

| Поле | Значения |
|---|---|
| `source` | `egrul`, `bki`, `fns`, `abs`, `all` |
| `mode` | `error` (ответ `503`), `timeout` (зависание, затем `503`; пауза `MOCK_TIMEOUT_SLEEP_S`, по умолчанию 10 с), `none` (снять сбой) |
| `count` | Сколько запросов сломать; без поля — до отмены |

```bash
# два ближайших запроса к БКИ вернут 503: конвейер повторит их, а при неудаче отправит заявку специалисту
curl -X POST localhost:8001/admin/faults -H "Content-Type: application/json" -d '{"source":"bki","mode":"error","count":3}'

# банк не выдаёт деньги, пока сбой не снят
curl -X POST localhost:8001/admin/faults -H "Content-Type: application/json" -d '{"source":"abs","mode":"error"}'

# снять все сбои
curl -X POST localhost:8001/admin/faults -H "Content-Type: application/json" -d '{"source":"all","mode":"none"}'
```

В PowerShell: `Invoke-RestMethod -Method Post -Uri http://localhost:8001/admin/faults -ContentType 'application/json' -Body '{"source":"bki","mode":"error","count":3}'`.

Сбой ЕГРЮЛ виден и через публичное API: `GET /api/companies/lookup` ответит `503 integration_unavailable`.
Задержку ответов задаёт переменная `MOCK_LATENCY_MS`.
