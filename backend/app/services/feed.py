"""Персональная лента новостей в кабинете клиента.

Новости синтетические (`app/data/news.json`, помечены как смоделированные) и размечены тегами: разделы
ОКВЭД, продукты, правовая форма, регион и статусы заявки. Лента ранжирует их под компанию клиента: её
отрасль по ОКВЭД, правовую форму и регион, продукты и цели её заявок и то, что с заявками происходит
сейчас. Поэтому у разных компаний и на разных этапах заявки лента разная. Внешних источников нет; в
промышленной версии здесь будет редакционный контент банка с той же разметкой.
"""

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Application, Company, User

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

_STATUS_TITLES = {
    "draft": "у вас есть черновик заявки",
    "needs_info": "банк ждёт от вас информацию",
    "manual_review": "заявку рассматривает специалист",
    "counter_offer": "у вас контрпредложение банка",
    "rejected": "по заявке пришёл отказ",
    "issued": "кредит выдан",
}


_TAG_KEYS = ("okved_sections", "legal_forms", "regions", "products", "statuses")


@dataclass(frozen=True)
class FeedItem:
    id: str
    published_at: str
    title: str
    summary: str
    reasons: list[str]
    is_synthetic: bool


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


def feed_for(db: Session, user: User, limit: int = 6) -> list[FeedItem]:
    company: Company | None = user.company
    if company is None:
        general = [n for n in _news() if not any(n["tags"][k] for k in _TAG_KEYS)]
        return [_item(n, ["Полезно всем предпринимателям"]) for n in general[:limit]]

    section = okved_section(company.okved)
    region = company.inn[:2]
    is_ip = company.legal_form == "ИП"
    apps = list(db.scalars(select(Application).where(Application.company_id == company.id)))
    product_tags: set[str] = set()
    for app in apps:
        product_tags |= _PRODUCT_TAGS.get(app.product_code, set()) | _PURPOSE_TAGS.get(app.purpose, set())
    # Статус берётся по самой свежей заявке: старый отказ не должен вечно висеть в ленте.
    latest = max(apps, key=lambda a: (a.updated_at, a.id), default=None)
    statuses = {latest.status} if latest else set()

    ranked = []
    for news in _news():
        tags = news["tags"]
        score, reasons = 0.0, []
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
        status = next((s for s in tags.get("statuses", []) if s in statuses), None)
        if status:
            score += 6
            reasons.append(f"Сейчас {_STATUS_TITLES.get(status, 'это важно для вашей заявки')}")
        untargeted = not any(tags[k] for k in _TAG_KEYS)
        if untargeted:
            score += 0.5
            reasons.append("Полезно всем предпринимателям")
        # Новость про чужую отрасль, правовую форму или регион клиенту не показываем.
        foreign_sector = tags["okved_sections"] and not (section and section[0] in tags["okved_sections"])
        foreign_form = tags["legal_forms"] and not is_ip
        foreign_region = tags["regions"] and region not in tags["regions"]
        if score > 0 and not (foreign_sector or foreign_form or foreign_region):
            ranked.append((score, news["published_at"], news, reasons))
    ranked.sort(key=lambda row: (row[0], row[1]), reverse=True)
    return [_item(news, reasons) for _, _, news, reasons in ranked[:limit]]


def _item(news: dict, reasons: list[str]) -> FeedItem:
    return FeedItem(
        id=news["id"],
        published_at=news["published_at"],
        title=news["title"],
        summary=news["summary"],
        reasons=reasons,
        is_synthetic=news.get("is_synthetic", True),
    )
