"""Персональная лента новостей в кабинете клиента.

Новости синтетические (`app/data/news.json`, помечены как смоделированные) и размечены тегами: разделы
ОКВЭД, продукты, правовая форма, регион и статусы заявки. Лента ранжирует их под компанию клиента: её
отрасль по ОКВЭД, правовую форму и регион, продукты и цели её заявок и этап главной заявки — той же, что
кабинет показывает первой на главной. Поэтому у разных компаний и на разных этапах заявки лента разная.
Внешних источников нет; в промышленной версии здесь будет редакционный контент банка с той же разметкой.
"""

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.statuses import STATUS_INFO, Status
from app.models import Application, Company, User
from app.services.applications import latest_offer, open_tasks_count

NEWS_FILE = Path(__file__).resolve().parents[1] / "data" / "news.json"

# Разделы ОКВЭД 2 по первым двум цифрам кода.
_SECTIONS: tuple[tuple[int, int, str, str], ...] = (
    (1, 3, "A", "сельское хозяйство"),
    (5, 9, "B", "добыча"),
    (10, 33, "C", "производство"),
    (35, 35, "D", "энергетика"),
    (36, 39, "E", "водоснабжение и отходы"),
    (41, 43, "F", "строительство"),
    (45, 47, "G", "торговля"),
    (49, 53, "H", "транспорт и логистика"),
    (55, 56, "I", "гостиницы и общепит"),
    (58, 63, "J", "IT и связь"),
    (64, 66, "K", "финансы"),
    (68, 68, "L", "недвижимость"),
    (69, 75, "M", "профессиональные услуги"),
    (77, 82, "N", "административные услуги"),
    (84, 84, "O", "госуправление"),
    (85, 85, "P", "образование"),
    (86, 88, "Q", "здравоохранение"),
    (90, 93, "R", "культура и спорт"),
    (94, 96, "S", "услуги населению"),
    (97, 98, "T", "домашние хозяйства"),
    (99, 99, "U", "экстерриториальные организации"),
)

# Продукт и цель заявки → теги продуктов в новостях.
_PRODUCT_TAGS = {
    "express": {"EXPRESS", "WORKING_CAPITAL"},
    "overdraft": {"OVERDRAFT"},
    "invest": {"INVEST"},
}
_PURPOSE_TAGS = {
    "working_capital": {"WORKING_CAPITAL"},
    "cash_gap": {"OVERDRAFT"},
    "equipment": {"INVEST"},
    "expansion": {"INVEST", "GOS_MSP"},
    "contract": {"GUARANTEE"},
}

# Этап главной заявки словами клиента — причина «Сейчас …» у новости, которую он поднял.
_CHECKS = "банк проверяет вашу заявку"
_STATUS_TITLES = {
    "draft": "у вас есть черновик заявки",
    "submitted": _CHECKS,
    "validation": _CHECKS,
    "enrichment": _CHECKS,
    "scoring": _CHECKS,
    "needs_info": "банк ждёт от вас информацию",
    "manual_review": "заявку рассматривает специалист",
    "approved": "банк одобрил вашу заявку",
    "counter_offer": "у вас контрпредложение банка",
    "signing": "договор ждёт вашей подписи",
    "rejected": "по заявке пришёл отказ",
    "issued": "деньги уже у вас",
}

# Этап заявки весит больше всех остальных совпадений вместе (отрасль 3 + ИП 3 + регион 2 + продукты 2):
# новость о том, что сейчас происходит с заявкой, всегда первая.
_STAGE_WEIGHT = 11

# Какую заявку кабинет показывает главной — как byAction во frontend/src/components/Status.tsx: сначала та, где
# ход за клиентом (подписать договор, ответить на предложение, на запрос банка, дозаполнить черновик), затем
# остальные идущие; среди равных — более новая.
_ACTION_RANK = {"signing": 0, "approved": 1, "counter_offer": 1, "needs_info": 2, "draft": 3}


_TAG_KEYS = ("okved_sections", "legal_forms", "regions", "products", "statuses")


@dataclass(frozen=True)
class FeedItem:
    id: str
    published_at: str
    title: str
    summary: str
    reasons: list[str]
    is_synthetic: bool
    # Заявка, этап которой поднял новость (главная заявка клиента); у остальных новостей — None.
    application_id: int | None = None


@lru_cache
def _news() -> list[dict]:
    return json.loads(NEWS_FILE.read_text(encoding="utf-8"))


def okved_section(code: str | None) -> tuple[str, str] | None:
    if not code:
        return None
    try:
        division = int(code.split(".")[0])
    except ValueError:
        return None
    return next(((letter, name) for lo, hi, letter, name in _SECTIONS if lo <= division <= hi), None)


def main_application(apps: Sequence[Application], signed: Mapping[int, bool] | None = None) -> Application | None:
    """Главная заявка — та же, что первая на главной кабинета; если идущих нет — последняя закрытая.

    `signed` — заявки на подписании с уже подписанным договором: id → открыты ли ещё условия выдачи. Такая заявка
    ждёт клиента, только пока условия не закрыты, — как status.action_required в ответе API.
    """
    signed = signed or {}

    def rank(app: Application) -> int:
        waits = signed[app.id] if app.id in signed else STATUS_INFO[Status(app.status)].action_required
        return _ACTION_RANK.get(app.status, 4) if waits else 5

    active = [a for a in apps if not STATUS_INFO[Status(a.status)].terminal]
    if active:
        return min(active, key=lambda a: (rank(a), -a.id))
    # Идущих заявок нет — этап берётся по последней закрытой: отказ или выданный кредит.
    return max(apps, key=lambda a: (a.updated_at, a.id), default=None)


def feed_for(db: Session, user: User, limit: int = 6) -> list[FeedItem]:
    company: Company | None = user.company
    if company is None:
        return personal_feed(None, [], limit=limit)
    apps = list(db.scalars(select(Application).where(Application.company_id == company.id)))
    signed = {
        app.id: open_tasks_count(db, app) > 0
        for app in apps
        if app.status == Status.SIGNING and (offer := latest_offer(db, app)) is not None and offer.status == "signed"
    }
    return personal_feed(company, apps, signed, limit=limit)


def personal_feed(
    company: Company | None,
    apps: Sequence[Application],
    signed: Mapping[int, bool] | None = None,
    limit: int = 6,
) -> list[FeedItem]:
    """Лента компании по её заявкам (`signed` — как в main_application), без обращений к БД."""
    if company is None:
        general = [n for n in _news() if not any(n["tags"][k] for k in _TAG_KEYS)]
        return [_item(n, ["Полезно всем предпринимателям"]) for n in general[:limit]]

    section = okved_section(company.okved)
    region = company.inn[:2]
    is_ip = company.legal_form == "ИП"
    product_tags: set[str] = set()
    for app in apps:
        product_tags |= _PRODUCT_TAGS.get(app.product_code, set()) | _PURPOSE_TAGS.get(app.purpose, set())
    # Этап — по главной заявке: свежий черновик не перебивает договор на подписи, старый отказ не висит в ленте,
    # пока идёт новая заявка. После подписи договора новости о подписании уже не к месту — этап не учитывается.
    main = main_application(apps, signed)
    stage = main.status if main is not None and main.id not in (signed or {}) else None

    ranked = []
    for news in _news():
        tags = news["tags"]
        score, reasons, raised_by = 0.0, [], None
        if section and section[0] in tags["okved_sections"]:
            score += 3
            reasons.append(f"Для вашей отрасли: {section[1]}")
        if is_ip and "IP" in tags["legal_forms"]:
            score += 3
            reasons.append("Для индивидуальных предпринимателей")
        if region in tags["regions"]:
            score += 2
            reasons.append("Для вашего региона")
        matched = product_tags & set(tags["products"])
        if matched:
            score += 2
            reasons.append("По продуктам, которые вы оформляете")
        if main is not None and stage in tags.get("statuses", []):
            score += _STAGE_WEIGHT
            reasons.append(f"Сейчас {_STATUS_TITLES.get(stage, 'это важно для вашей заявки')}")
            raised_by = main.id
        untargeted = not any(tags[k] for k in _TAG_KEYS)
        if untargeted:
            score += 0.5
            reasons.append("Полезно всем предпринимателям")
        # Новость про чужую отрасль, правовую форму или регион клиенту не показываем.
        foreign_sector = tags["okved_sections"] and not (section and section[0] in tags["okved_sections"])
        foreign_form = tags["legal_forms"] and not is_ip
        foreign_region = tags["regions"] and region not in tags["regions"]
        if score > 0 and not (foreign_sector or foreign_form or foreign_region):
            ranked.append((score, news["published_at"], news, reasons, raised_by))
    ranked.sort(key=lambda row: (row[0], row[1]), reverse=True)
    return [_item(news, reasons, raised_by) for _, _, news, reasons, raised_by in ranked[:limit]]


def _item(news: dict, reasons: list[str], application_id: int | None = None) -> FeedItem:
    return FeedItem(
        id=news["id"],
        published_at=news["published_at"],
        title=news["title"],
        summary=news["summary"],
        reasons=reasons,
        is_synthetic=news.get("is_synthetic", True),
        application_id=application_id,
    )
