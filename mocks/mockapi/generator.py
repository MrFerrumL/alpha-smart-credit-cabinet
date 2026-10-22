"""Детерминированный генератор данных для любого корректного ИНН, которого нет в демо-наборе.

Один и тот же ИНН всегда даёт один и тот же ответ, поэтому проверки воспроизводимы. Профиль риска задаёт
девятая цифра ИНН, чтобы произвольный ИНН давал разные исходы, а не только одобрения:

    0–4  благополучная компания
    5    низкая рентабельность (прибыль ~1,5 % выручки)
    6    высокая долговая нагрузка (действующие платежи ~49 % выручки)
    7    текущая просрочка 20 дней, в истории — до 40 дней
    8    налоговая задолженность и массовый адрес регистрации
    9    компания не действует: ликвидация, реорганизация или банкротство (по восьмой цифре)
"""

import random

from mockapi.data import ACTIVE, BANKRUPT, LIQUIDATING, REORGANIZING

PROFILES = {
    **{d: "healthy" for d in "01234"},
    "5": "thin_margin",
    "6": "heavy_debt",
    "7": "overdue",
    "8": "tax_debt",
    "9": "inactive",
}


def profile_of(inn: str) -> str:
    return PROFILES[inn[8]]

_NAME_A = ("Альфа", "Вега", "Орион", "Гранит", "Север", "Престиж", "Импульс", "Дельта", "Меридиан", "Атлас")
_NAME_B = ("Трейд", "Строй", "Сервис", "Логистик", "Групп", "Маркет", "Тех", "Пром")
_LAST = ("Иванов", "Кузнецов", "Соколов", "Попов", "Лебедев", "Морозов", "Павлов", "Фёдоров")
_FIRST = ("Алексей", "Михаил", "Андрей", "Сергей", "Илья", "Роман")
_MIDDLE = ("Андреевич", "Олегович", "Петрович", "Викторович", "Ильич")
_OKVED = (
    ("46.90", "Торговля оптовая неспециализированная"),
    ("47.11", "Торговля розничная в неспециализированных магазинах"),
    ("49.41", "Деятельность автомобильного грузового транспорта"),
    ("62.01", "Разработка компьютерного программного обеспечения"),
    ("43.21", "Производство электромонтажных работ"),
    ("56.10", "Деятельность ресторанов и услуги по доставке продуктов питания"),
)


def generate(inn: str) -> dict:
    rng = random.Random(int(inn))
    is_ip = len(inn) == 12
    person = f"{rng.choice(_LAST)} {rng.choice(_FIRST)} {rng.choice(_MIDDLE)}"
    year = rng.randint(2010, 2024)
    registered = f"{year}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}"
    okved_code, okved_name = rng.choice(_OKVED)
    if is_ip:
        short = f"ИП {person.split()[0]} {person.split()[1][0]}. {person.split()[2][0]}."
        full = f"Индивидуальный предприниматель {person}"
    else:
        brand = f"{rng.choice(_NAME_A)}{rng.choice(_NAME_B)}"
        short = f"ООО «{brand}»"
        full = f"Общество с ограниченной ответственностью «{brand}»"

    revenue = rng.randrange(6_000_000, 120_000_000, 100_000)
    loans = []
    for i in range(rng.choice((0, 0, 1, 1, 2))):
        amount = rng.randrange(1_000_000, max(2_000_000, revenue // 3), 100_000)
        balance = int(amount * rng.uniform(0.2, 0.9)) // 1000 * 1000
        loans.append({
            "lender": rng.choice(("Банк Развитие", "Северный банк", "ЛизингПлюс")),
            "type": rng.choice(("Кредит на пополнение оборотных средств", "Лизинг", "Кредитная линия")),
            "amount": amount,
            "balance": balance,
            "monthly_payment": balance // rng.randint(12, 36) // 1000 * 1000,
            "opened_at": f"{rng.randint(2021, 2025)}-{rng.randint(1, 12):02d}-01",
            "overdue_days_current": 0,
            "overdue_amount_current": 0,
            "overdue_max_days_24m": rng.choice((0, 0, 0, 5, 12)),
        })

    data = {
        "egrul": {
            "full_name": full,
            "short_name": short,
            "legal_form": "ИП" if is_ip else "ООО",
            "ogrn": None,
            "kpp": None if is_ip else inn[:4] + "01001",
            "registered_at": registered,
            "status": ACTIVE,
            "okved": {"code": okved_code, "name": okved_name},
            "okved_extra": [],
            "address": f"г. Москва, ул. {rng.choice(('Лесная', 'Речная', 'Заводская', 'Луговая'))}, д. {rng.randint(1, 80)}",
            "director": {
                "name": person,
                "position": "Индивидуальный предприниматель" if is_ip else "Генеральный директор",
                "since": registered,
            },
            "founders": [] if is_ip else [{"name": person, "share": 100}],
            "capital": None if is_ip else rng.choice((10_000, 100_000, 500_000)),
        },
        "fns": {
            "reporting_year": 2025,
            "tax_regime": "УСН" if revenue < 60_000_000 else "ОСН",
            "employees": rng.randint(3, 120),
            "revenue": revenue,
            "expenses": int(revenue * rng.uniform(0.75, 0.97)),
            "taxes_paid": int(revenue * rng.uniform(0.02, 0.06)),
            "tax_debt": 0,
            "mass_address": False,
            "mass_director": False,
            "disqualified_director": False,
            "blocked_accounts": False,
        },
        "bki": {"loans": loans, "inquiries_90d": rng.randint(0, 4)},
    }
    _apply_profile(data, inn, revenue)
    return data


def _apply_profile(data: dict, inn: str, revenue: int) -> None:
    profile = profile_of(inn)
    fns, loans = data["fns"], data["bki"]["loans"]
    if profile == "thin_margin":
        fns["expenses"] = int(revenue * 0.985)
    elif profile == "heavy_debt":
        monthly = revenue // 12 * 49 // 100 // 1000 * 1000
        loans.append({
            "lender": "Северный банк", "type": "Кредитная линия", "amount": monthly * 30, "balance": monthly * 20,
            "monthly_payment": monthly, "opened_at": "2024-03-01", "overdue_days_current": 0,
            "overdue_amount_current": 0, "overdue_max_days_24m": 0,
        })
    elif profile == "overdue":
        loans.append({
            "lender": "Банк Развитие", "type": "Кредит на пополнение оборотных средств", "amount": 2_000_000,
            "balance": 1_200_000, "monthly_payment": 95_000, "opened_at": "2024-06-01", "overdue_days_current": 20,
            "overdue_amount_current": 95_000, "overdue_max_days_24m": 40,
        })
    elif profile == "tax_debt":
        fns["tax_debt"] = 150_000
        fns["mass_address"] = True
    elif profile == "inactive":
        data["egrul"]["status"] = (LIQUIDATING, REORGANIZING, BANKRUPT)[int(inn[7]) % 3]
