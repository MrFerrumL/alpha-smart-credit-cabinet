"""Синтетические ответы внешних источников для демо-компаний.

Каждая компания собрана под свой сценарий конвейера (см. README, раздел «Демо-сценарии»).
ИНН начинаются с «00» — несуществующий код региона, совпадений с реальными компаниями нет.
"""

ACTIVE = {"code": "active", "title": "Действующая"}
LIQUIDATING = {"code": "liquidating", "title": "Находится в стадии ликвидации"}
REORGANIZING = {"code": "reorganizing", "title": "Находится в процессе реорганизации"}
BANKRUPT = {"code": "bankrupt", "title": "В отношении компании введена процедура банкротства"}


def _fns(year=2025, *, regime, employees, revenue, expenses, taxes_paid, tax_debt=0, mass_address=False,
         mass_director=False, disqualified_director=False, blocked_accounts=False) -> dict:
    return {
        "reporting_year": year,
        "tax_regime": regime,
        "employees": employees,
        "revenue": revenue,
        "expenses": expenses,
        "taxes_paid": taxes_paid,
        "tax_debt": tax_debt,
        "mass_address": mass_address,
        "mass_director": mass_director,
        "disqualified_director": disqualified_director,
        "blocked_accounts": blocked_accounts,
    }


def _loan(lender, kind, amount, balance, monthly, opened, overdue_now=0, overdue_max=0, overdue_amount=0) -> dict:
    return {
        "lender": lender,
        "type": kind,
        "amount": amount,
        "balance": balance,
        "monthly_payment": monthly,
        "opened_at": opened,
        "overdue_days_current": overdue_now,
        "overdue_amount_current": overdue_amount,
        "overdue_max_days_24m": overdue_max,
    }


COMPANIES: dict[str, dict] = {
    # Сценарий: автоматическое одобрение.
    "0077010019": {
        "egrul": {
            "full_name": "Общество с ограниченной ответственностью «Северная пекарня»",
            "short_name": "ООО «Северная пекарня»",
            "legal_form": "ООО",
            "ogrn": "1007700100011",
            "kpp": "007701001",
            "registered_at": "2018-03-14",
            "status": ACTIVE,
            "okved": {"code": "10.71", "name": "Производство хлеба и мучных кондитерских изделий"},
            "okved_extra": [{"code": "47.24", "name": "Торговля розничная хлебом и кондитерскими изделиями"}],
            "address": "г. Москва, ул. Хлебная, д. 12",
            "director": {"name": "Северова Ольга Николаевна", "position": "Генеральный директор", "since": "2018-03-14"},
            "founders": [{"name": "Северова Ольга Николаевна", "share": 100}],
            "capital": 500_000,
        },
        "fns": _fns(regime="ОСН", employees=38, revenue=54_000_000, expenses=47_500_000, taxes_paid=3_100_000),
        "bki": {
            "loans": [_loan("ЛизингПлюс", "Лизинг оборудования", 3_000_000, 1_200_000, 85_000, "2023-06-01")],
            "inquiries_90d": 1,
        },
    },
    # Сценарий: контрпредложение — запрошенная сумма больше, чем позволяет выручка.
    "0077020024": {
        "egrul": {
            "full_name": "Общество с ограниченной ответственностью «ТехноСклад»",
            "short_name": "ООО «ТехноСклад»",
            "legal_form": "ООО",
            "ogrn": "1007700200023",
            "kpp": "007702001",
            "registered_at": "2016-09-02",
            "status": ACTIVE,
            "okved": {"code": "46.69", "name": "Торговля оптовая прочими машинами и оборудованием"},
            "okved_extra": [{"code": "52.10", "name": "Деятельность по складированию и хранению"}],
            "address": "г. Москва, Складской пр-д, д. 4, стр. 2",
            "director": {"name": "Орлов Дмитрий Андреевич", "position": "Генеральный директор", "since": "2016-09-02"},
            "founders": [{"name": "Орлов Дмитрий Андреевич", "share": 60}, {"name": "Орлова Мария Ильинична", "share": 40}],
            "capital": 1_000_000,
        },
        "fns": _fns(regime="ОСН", employees=22, revenue=36_000_000, expenses=31_000_000, taxes_paid=1_900_000),
        "bki": {
            "loans": [_loan("Банк Развитие", "Кредит на пополнение оборотных средств", 4_000_000, 2_400_000, 150_000, "2024-02-15")],
            "inquiries_90d": 2,
        },
    },
    # Сценарий: запрос информации — ИП на патенте, в налоговой нет данных о выручке.
    "007703003174": {
        "egrul": {
            "full_name": "Индивидуальный предприниматель Смирнова Анна Викторовна",
            "short_name": "ИП Смирнова А. В.",
            "legal_form": "ИП",
            "ogrn": "300770000300034",
            "kpp": None,
            "registered_at": "2023-05-22",
            "status": ACTIVE,
            "okved": {"code": "96.02", "name": "Предоставление услуг парикмахерскими и салонами красоты"},
            "okved_extra": [],
            "address": "г. Москва, ул. Садовая, д. 8",
            "director": {"name": "Смирнова Анна Викторовна", "position": "Индивидуальный предприниматель", "since": "2023-05-22"},
            "founders": [],
            "capital": None,
        },
        "fns": _fns(regime="ПСН", employees=3, revenue=None, expenses=None, taxes_paid=96_000),
        "bki": {"loans": [], "inquiries_90d": 0},
    },
    # Сценарий: ручное рассмотрение — крупный инвестиционный кредит, высокая долговая нагрузка.
    "0077040045": {
        "egrul": {
            "full_name": "Общество с ограниченной ответственностью «Вектор Строй»",
            "short_name": "ООО «Вектор Строй»",
            "legal_form": "ООО",
            "ogrn": "1007700400047",
            "kpp": "007704001",
            "registered_at": "2020-02-11",
            "status": ACTIVE,
            "okved": {"code": "41.20", "name": "Строительство жилых и нежилых зданий"},
            "okved_extra": [{"code": "43.99", "name": "Работы строительные специализированные прочие"}],
            "address": "г. Москва, Строительный б-р, д. 21",
            "director": {"name": "Волков Игорь Сергеевич", "position": "Генеральный директор", "since": "2021-08-01"},
            "founders": [{"name": "Волков Игорь Сергеевич", "share": 51}, {"name": "ООО «Опора Капитал»", "share": 49}],
            "capital": 10_000_000,
        },
        "fns": _fns(regime="ОСН", employees=64, revenue=96_000_000, expenses=88_000_000, taxes_paid=4_200_000),
        "bki": {
            "loans": [
                _loan("Банк Развитие", "Инвестиционный кредит", 20_000_000, 14_000_000, 780_000, "2022-04-20", overdue_max=15),
                _loan("Северный банк", "Кредитная линия", 6_000_000, 4_000_000, 320_000, "2024-09-10"),
            ],
            "inquiries_90d": 6,
        },
    },
    # Сценарий: отказ — просрочки, налоговый долг, убыточная деятельность.
    "0077050050": {
        "egrul": {
            "full_name": "Общество с ограниченной ответственностью «Быстрый старт»",
            "short_name": "ООО «Быстрый старт»",
            "legal_form": "ООО",
            "ogrn": "1007700500059",
            "kpp": "007705001",
            "registered_at": "2024-11-05",
            "status": ACTIVE,
            "okved": {"code": "56.10", "name": "Деятельность ресторанов и услуги по доставке продуктов питания"},
            "okved_extra": [],
            "address": "г. Москва, ул. Новая, д. 1",
            "director": {"name": "Быстров Павел Игоревич", "position": "Генеральный директор", "since": "2024-11-05"},
            "founders": [{"name": "Быстров Павел Игоревич", "share": 100}],
            "capital": 10_000,
        },
        "fns": _fns(regime="УСН", employees=12, revenue=9_600_000, expenses=9_900_000, taxes_paid=310_000, tax_debt=340_000),
        "bki": {
            "loans": [
                _loan("МФО «Быстрые деньги»", "Микрозаём", 800_000, 600_000, 95_000, "2025-03-01",
                      overdue_now=45, overdue_max=75, overdue_amount=120_000),
                _loan("Банк Развитие", "Кредитная карта", 500_000, 480_000, 40_000, "2025-01-20", overdue_max=30),
            ],
            "inquiries_90d": 9,
        },
    },
    # Сценарий: стоп-фактор — компания в стадии ликвидации.
    "0077060066": {
        "egrul": {
            "full_name": "Общество с ограниченной ответственностью «Закат»",
            "short_name": "ООО «Закат»",
            "legal_form": "ООО",
            "ogrn": "1007700600060",
            "kpp": "007706001",
            "registered_at": "2012-07-30",
            "status": LIQUIDATING,
            "okved": {"code": "47.19", "name": "Торговля розничная прочая в неспециализированных магазинах"},
            "okved_extra": [],
            "address": "г. Москва, ул. Вечерняя, д. 9",
            "director": {"name": "Закатов Сергей Петрович", "position": "Ликвидатор", "since": "2026-06-01"},
            "founders": [{"name": "Закатов Сергей Петрович", "share": 100}],
            "capital": 100_000,
        },
        "fns": _fns(regime="УСН", employees=2, revenue=4_000_000, expenses=4_400_000, taxes_paid=120_000),
        "bki": {"loans": [], "inquiries_90d": 0},
    },
    # Новый клиент: компания, которую можно привязать по ИНН.
    "0077070071": {
        "egrul": {
            "full_name": "Общество с ограниченной ответственностью «Новые горизонты»",
            "short_name": "ООО «Новые горизонты»",
            "legal_form": "ООО",
            "ogrn": "1007700700072",
            "kpp": "007707001",
            "registered_at": "2019-04-18",
            "status": ACTIVE,
            "okved": {"code": "62.01", "name": "Разработка компьютерного программного обеспечения"},
            "okved_extra": [{"code": "62.02", "name": "Деятельность консультативная в области компьютерных технологий"}],
            "address": "г. Москва, Инновационный пр-т, д. 3",
            "director": {"name": "Новиков Никита Алексеевич", "position": "Генеральный директор", "since": "2019-04-18"},
            "founders": [{"name": "Новиков Никита Алексеевич", "share": 100}],
            "capital": 300_000,
        },
        "fns": _fns(regime="УСН", employees=18, revenue=30_000_000, expenses=24_000_000, taxes_paid=1_200_000),
        "bki": {"loans": [], "inquiries_90d": 1},
    },
    # Сценарий: контрпредложение другим продуктом — действующие платежи съедают почти половину выручки,
    # «Экспресс-оборот» не проходит даже на минимальную сумму, а у овердрафта минимум ниже, и 150 тыс. проходят.
    "0077090092": {
        "egrul": {
            "full_name": "Общество с ограниченной ответственностью «Городская химчистка»",
            "short_name": "ООО «Городская химчистка»",
            "legal_form": "ООО",
            "ogrn": "1007700900096",
            "kpp": "007709001",
            "registered_at": "2015-01-15",
            "status": ACTIVE,
            "okved": {"code": "96.01", "name": "Стирка и химическая чистка текстильных и меховых изделий"},
            "okved_extra": [],
            "address": "г. Москва, ул. Прачечная, д. 5",
            "director": {"name": "Тихонова Лариса Петровна", "position": "Генеральный директор", "since": "2015-01-15"},
            "founders": [{"name": "Тихонова Лариса Петровна", "share": 100}],
            "capital": 100_000,
        },
        "fns": _fns(regime="УСН", employees=9, revenue=12_000_000, expenses=9_600_000, taxes_paid=360_000),
        "bki": {
            "loans": [_loan("Банк Развитие", "Кредит на пополнение оборотных средств", 11_640_000, 5_820_000, 485_000,
                            "2023-01-01")],
            "inquiries_90d": 1,
        },
    },
}
