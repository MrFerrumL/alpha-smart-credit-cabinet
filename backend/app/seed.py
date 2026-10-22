"""Синтетические демо-данные: компании и учётные записи под каждый сценарий конвейера.

ИНН начинаются с «00» — такого кода региона не существует, поэтому они заведомо не совпадают
с реальными компаниями, но проходят проверку контрольных разрядов. Запуск: python -m app.seed
"""

from dataclasses import dataclass
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Company, User
from app.security import hash_password

DEMO_PASSWORD = "demo1234"


@dataclass(frozen=True)
class DemoCompany:
    inn: str
    name: str
    short_name: str
    legal_form: str
    ogrn: str
    registered_at: date
    okved: str
    okved_name: str
    address: str
    director: str


@dataclass(frozen=True)
class DemoUser:
    email: str
    full_name: str
    position: str
    role: str
    company_inn: str | None
    can_sign: bool
    scenario: str
    scenario_tone: str


COMPANIES: tuple[DemoCompany, ...] = (
    DemoCompany(
        "0077010019", "Общество с ограниченной ответственностью «Северная пекарня»", "ООО «Северная пекарня»",
        "ООО", "1007700100011", date(2018, 3, 14), "10.71",
        "Производство хлеба и мучных кондитерских изделий",
        "г. Москва, ул. Хлебная, д. 12", "Северова Ольга Николаевна",
    ),
    DemoCompany(
        "0077020024", "Общество с ограниченной ответственностью «ТехноСклад»", "ООО «ТехноСклад»",
        "ООО", "1007700200023", date(2016, 9, 2), "46.69",
        "Торговля оптовая прочими машинами и оборудованием",
        "г. Москва, Складской пр-д, д. 4, стр. 2", "Орлов Дмитрий Андреевич",
    ),
    DemoCompany(
        "007703003174", "Индивидуальный предприниматель Смирнова Анна Викторовна", "ИП Смирнова А. В.",
        "ИП", "300770000300034", date(2023, 5, 22), "96.02",
        "Предоставление услуг парикмахерскими и салонами красоты",
        "г. Москва, ул. Садовая, д. 8", "Смирнова Анна Викторовна",
    ),
    DemoCompany(
        "0077040045", "Общество с ограниченной ответственностью «Вектор Строй»", "ООО «Вектор Строй»",
        "ООО", "1007700400047", date(2020, 2, 11), "41.20",
        "Строительство жилых и нежилых зданий",
        "г. Москва, Строительный б-р, д. 21", "Волков Игорь Сергеевич",
    ),
    DemoCompany(
        "0077050050", "Общество с ограниченной ответственностью «Быстрый старт»", "ООО «Быстрый старт»",
        "ООО", "1007700500059", date(2024, 11, 5), "56.10",
        "Деятельность ресторанов и услуги по доставке продуктов питания",
        "г. Москва, ул. Новая, д. 1", "Быстров Павел Игоревич",
    ),
    DemoCompany(
        "0077060066", "Общество с ограниченной ответственностью «Закат»", "ООО «Закат»",
        "ООО", "1007700600060", date(2012, 7, 30), "47.19",
        "Торговля розничная прочая в неспециализированных магазинах",
        "г. Москва, ул. Вечерняя, д. 9", "Закатов Сергей Петрович",
    ),
    DemoCompany(
        "0077090092", "Общество с ограниченной ответственностью «Городская химчистка»", "ООО «Городская химчистка»",
        "ООО", "1007700900094", date(2015, 1, 15), "96.01",
        "Стирка и химическая чистка текстильных и меховых изделий",
        "г. Москва, ул. Прачечная, д. 5", "Тихонова Лариса Петровна",
    ),
)

USERS: tuple[DemoUser, ...] = (
    DemoUser(
        "bakery@demo.local", "Ольга Северова", "Генеральный директор", "client", "0077010019", True,
        "Надёжная компания: «Экспресс-оборот» одобряется автоматически", "success",
    ),
    DemoUser(
        "buh@demo.local", "Елена Счётова", "Главный бухгалтер", "client", "0077010019", False,
        "Бухгалтер готовит заявку, но подписать договор может только директор", "info",
    ),
    DemoUser(
        "sklad@demo.local", "Дмитрий Орлов", "Генеральный директор", "client", "0077020024", True,
        "Просит больше, чем позволяет выручка — банк сделает контрпредложение", "warning",
    ),
    DemoUser(
        "smirnova@demo.local", "Анна Смирнова", "Индивидуальный предприниматель", "client", "007703003174", True,
        "В налоговой нет данных о выручке — банк попросит выписку по счёту", "warning",
    ),
    DemoUser(
        "vector@demo.local", "Игорь Волков", "Генеральный директор", "client", "0077040045", True,
        "Крупный инвестиционный кредит — заявку рассматривает аналитик", "info",
    ),
    DemoUser(
        "start@demo.local", "Павел Быстров", "Генеральный директор", "client", "0077050050", True,
        "Просрочки и долг по налогам — отказ с объяснением, что улучшить", "danger",
    ),
    DemoUser(
        "zakat@demo.local", "Сергей Закатов", "Ликвидатор", "client", "0077060066", True,
        "Компания ликвидируется — срабатывает стоп-фактор", "danger",
    ),
    DemoUser(
        "clean@demo.local", "Лариса Тихонова", "Генеральный директор", "client", "0077090092", True,
        "Кредиты съедают почти половину выручки — банк предложит другой продукт: овердрафт", "warning",
    ),
    DemoUser(
        "new@demo.local", "Никита Новиков", "Собственник бизнеса", "client", None, True,
        "Новый клиент: вводит ИНН 0077070071, и данные подтягиваются из ЕГРЮЛ", "info",
    ),
    DemoUser(
        "analyst@demo.local", "Мария Кредитова", "Кредитный аналитик", "analyst", None, False,
        "Сотрудник банка: очередь заявок и ручное рассмотрение", "neutral",
    ),
)

DEMO_SCENARIOS = {u.email: u for u in USERS}


def seed(db: Session) -> None:
    companies: dict[str, Company] = {c.inn: c for c in db.scalars(select(Company))}
    for c in COMPANIES:
        if c.inn not in companies:
            company = Company(
                inn=c.inn, name=c.name, short_name=c.short_name, legal_form=c.legal_form, ogrn=c.ogrn,
                registered_at=c.registered_at, okved=c.okved, okved_name=c.okved_name, address=c.address,
                director=c.director,
            )
            db.add(company)
            companies[c.inn] = company
    db.flush()

    existing = set(db.scalars(select(User.email)))
    password_hash = hash_password(DEMO_PASSWORD)
    for u in USERS:
        if u.email in existing:
            continue
        db.add(
            User(
                email=u.email, full_name=u.full_name, position=u.position, role=u.role, can_sign=u.can_sign,
                password_hash=password_hash,
                company_id=companies[u.company_inn].id if u.company_inn else None,
            )
        )
    db.commit()


if __name__ == "__main__":
    from app.db import SessionLocal

    with SessionLocal() as session:
        seed(session)
    print("Демо-данные загружены")
