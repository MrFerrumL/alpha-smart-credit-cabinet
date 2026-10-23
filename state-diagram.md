# Диаграмма состояний заявки

Сервер принимает только переходы из таблицы ниже; любой другой переход → `409 INVALID_TRANSITION`.
Конечные состояния: `DISBURSED`, `DECLINED`, `CANCELLED`, `EXPIRED`.

```mermaid
stateDiagram-v2
    [*] --> DRAFT
    DRAFT --> SUBMITTED: отправить (владелец или МЧД)
    DRAFT --> CANCELLED: клиент удалил черновик
    SUBMITTED --> CHECKING: взята в обработку
    CHECKING --> INFO_REQUESTED: оборотов < 6 мес / нет документа
    INFO_REQUESTED --> CHECKING: данные загружены
    INFO_REQUESTED --> CANCELLED: клиент отказался
    INFO_REQUESTED --> EXPIRED: 14 дней без ответа
    CHECKING --> MANUAL_REVIEW: M1 авто-лимит / M2 расхождение / M3 источник / M4 класс D
    CHECKING --> APPROVED: политика
    CHECKING --> COUNTER_OFFER: политика
    CHECKING --> DECLINED: стоп-фактор / класс E / нагрузка
    MANUAL_REVIEW --> APPROVED: андеррайтер
    MANUAL_REVIEW --> COUNTER_OFFER: андеррайтер
    MANUAL_REVIEW --> DECLINED: андеррайтер
    MANUAL_REVIEW --> INFO_REQUESTED: андеррайтер запросил данные
    APPROVED --> ACCEPTED: клиент принял (владелец или МЧД)
    COUNTER_OFFER --> ACCEPTED: клиент принял (владелец или МЧД)
    APPROVED --> CANCELLED: клиент отказался
    COUNTER_OFFER --> CANCELLED: клиент отказался
    APPROVED --> EXPIRED: 10 дней без ответа
    COUNTER_OFFER --> EXPIRED: 10 дней без ответа
    ACCEPTED --> SIGNED: код подтверждения (подписант)
    SIGNED --> DISBURSED: симуляция зачисления
    DISBURSED --> [*]
    DECLINED --> [*]
    CANCELLED --> [*]
    EXPIRED --> [*]
```

## Таблица переходов

| Из | В | Кто | Условие | Событие в журнале |
|---|---|---|---|---|
| DRAFT | SUBMITTED | OWNER или PREPARER с МЧД (`CREDIT_APPLICATION_SUBMIT`) | Обязательные поля, согласия ПДн и БКИ | `application_submitted` |
| DRAFT | CANCELLED | Участник компании (кроме VIEWER) | — | `cancelled` |
| SUBMITTED | CHECKING | Система | Воркер взял заявку | `checking_started` |
| CHECKING | INFO_REQUESTED | Система | Оборотов < 6 мес или нет обязательного документа | `info_requested` |
| CHECKING | MANUAL_REVIEW | Система | M1–M4 | `manual_review_started` |
| CHECKING | APPROVED / COUNTER_OFFER / DECLINED | Система | Политика решения | `decision_*` |
| INFO_REQUESTED | CHECKING | Участник компании (кроме VIEWER) | Данные загружены | `info_uploaded` |
| INFO_REQUESTED | CANCELLED / EXPIRED | Клиент / система | Отказ / 14 дней | `cancelled` / `expired` |
| MANUAL_REVIEW | APPROVED / COUNTER_OFFER / DECLINED | UNDERWRITER | В пределах `approval_limit` | `decision_*`, `underwriter_comment` |
| MANUAL_REVIEW | INFO_REQUESTED | UNDERWRITER | Нужны данные | `info_requested` |
| APPROVED / COUNTER_OFFER | ACCEPTED | OWNER или PREPARER с МЧД | Оффер не истёк | `offer_accepted` |
| APPROVED / COUNTER_OFFER | CANCELLED / EXPIRED | Клиент / система | Отказ / 10 дней | `offer_declined` / `expired` |
| ACCEPTED | SIGNED | OWNER или PREPARER с МЧД (`CREDIT_AGREEMENT_SIGN`) | Верный код | `signed` |
| SIGNED | DISBURSED | Система | Симуляция зачисления | `disbursed` |

Каждый переход пишется в append-only журнал `Event` (кто, когда, из какого статуса, в какой) в одной
транзакции со сменой статуса; уведомления и лента читают журнал через outbox.
