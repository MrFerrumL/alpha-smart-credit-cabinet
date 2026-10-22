# Модель данных

Источник — `backend/app/models.py`, схема БД создаётся миграциями Alembic (`backend/migrations`).

```mermaid
erDiagram
    companies ||--o{ users : "сотрудники"
    companies ||--o{ applications : "заявки"
    users ||--o{ applications : "создал"
    applications ||--o{ application_events : "журнал"
    applications ||--o{ check_results : "проверки"
    applications ||--o{ scoring_results : "скоринг"
    applications ||--o{ offers : "предложения"
    applications ||--o{ client_tasks : "запросы клиенту"
    applications ||--o{ documents : "документы"
    companies ||--o{ documents : "документы"
    applications ||--o{ jobs : "шаги конвейера"

    companies {
        int id PK
        string inn UK "ИНН, 10 или 12 цифр"
        string name
        string short_name
        string legal_form "ООО | ИП"
        string ogrn
        date registered_at
        string okved
        string address
        string director
    }
    users {
        int id PK
        string email UK
        string full_name
        string position
        string role "client | analyst"
        bool can_sign "право подписи"
        string password_hash "PBKDF2-SHA256"
        int company_id FK
    }
    applications {
        int id PK
        string number UK "2026-000001"
        int company_id FK
        int created_by_id FK
        string product_code
        string purpose
        decimal amount
        int term_months
        string status "см. state-machine.md"
        json form "анкета: финансы, залог, контакт"
        string submit_key UK "Idempotency-Key"
        int version "оптимистическая блокировка"
        datetime submitted_at
        datetime decided_at
    }
    application_events {
        int id PK
        int application_id FK
        string actor_type "client | analyst | system"
        int actor_id FK
        string event
        string from_status
        string to_status
        string comment
        json payload
        datetime created_at
    }
    check_results {
        int id PK
        int application_id FK
        string source "egrul | bki | fns"
        string status "ok | failed"
        json data "ответ источника как есть"
        int attempts
    }
    scoring_results {
        int id PK
        int application_id FK
        string method "rules | ml"
        string model_version
        decimal probability_default
        int score
        string grade "A..E"
        json factors "вклад факторов"
    }
    offers {
        int id PK
        int application_id FK
        string kind "approved | counter"
        decimal amount
        int term_months
        decimal rate
        decimal monthly_payment
        json explanation
        string status "active | accepted | declined | expired"
    }
    client_tasks {
        int id PK
        int application_id FK
        string kind "document | question"
        string title
        string status "open | done"
        string answer
    }
    documents {
        int id PK
        int company_id FK
        int application_id FK
        string kind
        string filename
        string storage_key
    }
    jobs {
        int id PK
        string kind
        int application_id FK
        string status "pending | running | done | failed"
        int attempts
        datetime run_after
        string last_error
    }
```

## Зачем так

- **Заявка хранит параметры, анкета — гибкий JSON.** Параметры, по которым идут выборки и правила
  (продукт, сумма, срок, статус), — отдельные колонки. Анкета меняется чаще и хранится как JSON со схемой
  `ApplicationForm` в `app/schemas.py`.
- **Каждый этап конвейера оставляет след.** Ответы источников (`check_results`), скоринг с версией модели
  (`scoring_results`) и предложения (`offers`) хранятся отдельно — решение по заявке можно воспроизвести и
  объяснить.
- **Компания отделена от пользователя.** У одной компании несколько сотрудников с разными правами: бухгалтер
  готовит заявку, подписывает руководитель (`can_sign`).
