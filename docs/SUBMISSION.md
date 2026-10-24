# Поток — запуск и проверка

«Поток» — прототип кредитного кабинета для малого бизнеса (Альфа-Хакатон 2026, кейс «Умный кредитный кабинет
предпринимателя»). Предприниматель подбирает кредит под задачу, подаёт заявку и видит, что с ней происходит. Банк
проверяет компанию по ЕГРЮЛ, ФНС и бюро кредитных историй, решает сам или руками аналитика и после подписи договора
выдаёт деньги. Решение принимают объяснимые правила, внешние системы эмулируются на синтетических данных. Пояснение
решения локальной моделью с открытыми весами есть, но по умолчанию выключено.

## Версия

| | |
|---|---|
| Репозиторий | https://github.com/donaldtrumpdev-commits/alpha |
| Версия | тег <!--TAG-->`v1.0.1`<!--/TAG--> |
| Коммит | <!--COMMIT-->хеш указан в форме сдачи и в приложенном к ней PDF; проверить: `git rev-parse v1.0.1^{commit}`<!--/COMMIT--> |
| Доступ | репозиторий приватный, приглашение отправлено аккаунту `alfa-hack-2026` |

## Запуск

Нужен только Docker (Docker Desktop или Docker Engine с Compose v2). Хватит ПК с 8 ГБ памяти без видеокарты.

```bash
git clone https://github.com/donaldtrumpdev-commits/alpha.git
cd alpha
git checkout v1.0.1
docker compose up --build
```

`docker compose up --build -d --wait` вернёт управление, когда всё готово. Файл `.env` не нужен.

| Что | Адрес |
|---|---|
| Кабинет клиента и банка | http://localhost:8080 |
| API и Swagger | http://localhost:8000/api/docs |
| Эмулятор ЕГРЮЛ, ФНС, БКИ и АБС | http://localhost:8001/docs |

Адреса открываются только с этой машины. Проверить стенд: `python scripts/smoke.py` (Python 3.10+) входит под
пекарней, подаёт заявку и ждёт одобрения.

## Демо-учётки

На странице входа поле «Почта» открывает список профилей с компанией и исходом. Пароль у всех `demo1234`.

| Учётка | Что получится |
|---|---|
| `bakery@demo.local` | Одобрение 3 млн, подпись кодом, деньги на счёте и кредит с графиком |
| `buh@demo.local` | Бухгалтер готовит заявку и передаёт руководителю на подпись |
| `sklad@demo.local` | Другие условия: 4,5 млн на 16 мес. вместо 10 млн на 12 |
| `clean@demo.local` | Другой продукт: овердрафт на 150 тыс. |
| `smirnova@demo.local` | Банк просит выписку, заявку одобряет аналитик |
| `vector@demo.local` | Инвестиционный кредит у специалиста, контрпредложение аналитика, условия выдачи |
| `start@demo.local` | Отказ с причинами и подсказками |
| `zakat@demo.local` | Отказ по стоп-фактору: ликвидация |
| `new@demo.local` | Подключение компании по ИНН `0077070071` и одобрение |
| `analyst@demo.local` | Очередь, карточка оценки, трасса правил, решение, симулятор политики |

Что именно вводить для каждой учётки, описано в разделе
[«Демо-сценарии» README](https://github.com/donaldtrumpdev-commits/alpha/blob/v1.0.1/README.md#демо-сценарии).

## Основной сценарий

Кабинет открывается в двух вкладках: клиент и банк. Шаги с точными данными — в разделе
[«Проверка за 10 минут» README](https://github.com/donaldtrumpdev-commits/alpha/blob/v1.0.1/README.md#проверка-за-10-минут).

1. Пекарня получает одобрение, подписывает договор кодом и видит кредит с графиком.
2. «ТехноСклад» получает другие условия, химчистка — другой продукт.
3. «Вектор Строй» уходит к специалисту, аналитик делает контрпредложение, клиент закрывает условия выдачи.
4. «Быстрый старт» получает отказ, у ИП Смирновой банк просит выписку.
5. Сбой бюро кредитных историй: конвейер повторяет запрос и доходит до решения.
6. Симулятор политики показывает, как изменились бы решения при других порогах.

Видео этого сценария записывает CI, оно лежит в артефакте `demo-video` прогона на коммите тега.

## Документы

| Документ | Что внутри |
|---|---|
| [README.md](https://github.com/donaldtrumpdev-commits/alpha/blob/v1.0.1/README.md) | Запуск, сценарии, переменные, тесты, ограничения |
| [docs/product.md](https://github.com/donaldtrumpdev-commits/alpha/blob/v1.0.1/docs/product.md) | Пользователи, модель кредитного процесса, почему такой MVP |
| [docs/architecture.md](https://github.com/donaldtrumpdev-commits/alpha/blob/v1.0.1/docs/architecture.md) | Компоненты и ключевые решения |
| [docs/api.md](https://github.com/donaldtrumpdev-commits/alpha/blob/v1.0.1/docs/api.md) | API; спецификация [openapi.json](https://github.com/donaldtrumpdev-commits/alpha/blob/v1.0.1/docs/openapi.json) и [коллекция запросов](https://github.com/donaldtrumpdev-commits/alpha/blob/v1.0.1/docs/postman_collection.json) |
| [docs/state-machine.md](https://github.com/donaldtrumpdev-commits/alpha/blob/v1.0.1/docs/state-machine.md) | Статусы заявки и переходы; модель данных — [data-model.md](https://github.com/donaldtrumpdev-commits/alpha/blob/v1.0.1/docs/data-model.md) |
| [docs/scoring.md](https://github.com/donaldtrumpdev-commits/alpha/blob/v1.0.1/docs/scoring.md) | Правила оценки и решения |
| [docs/test-scenarios.md](https://github.com/donaldtrumpdev-commits/alpha/blob/v1.0.1/docs/test-scenarios.md) | Тестовые сценарии |
| [docs/llm.md](https://github.com/donaldtrumpdev-commits/alpha/blob/v1.0.1/docs/llm.md) | Необязательное пояснение решения |
| [THIRD_PARTY_NOTICES.md](https://github.com/donaldtrumpdev-commits/alpha/blob/v1.0.1/THIRD_PARTY_NOTICES.md) | Сторонние компоненты и лицензии |

## Ограничения

- Внешние системы эмулируются, продукты, ставки и пороги условные, подпись смоделирована (код показывается в окне
  подписания). Публичного стенда нет.
- Подключить компанию может только её руководитель или учредитель по ЕГРЮЛ; из демо-учёток это `new@`.
- Выписка не разбирается, такую заявку всегда смотрит специалист. Аналитик не предлагает другой продукт,
  кредитного комитета нет.
