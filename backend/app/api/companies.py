from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_client
from app.db import get_db
from app.domain.authority import authority_of
from app.domain.inn import is_valid_inn
from app.errors import BusinessValidationError, Conflict, Forbidden, IntegrationUnavailable, NotFound
from app.models import Company, User
from app.schemas import CompanyLinkIn, CompanyLookupOut, CompanyOut, FinancialsOut
from app.services.integrations import ExternalSources, NotInSource, SourceUnavailable, get_sources
from app.services.notifications import notify_company

router = APIRouter(prefix="/companies", tags=["Компании"])


def _registry(sources: ExternalSources, inn: str) -> dict:
    if not is_valid_inn(inn):
        raise BusinessValidationError(errors=[{"field": "inn", "message": "ИНН введён с ошибкой — проверьте цифры"}])
    try:
        return sources.egrul(inn)
    except NotInSource:
        raise NotFound("Компания с таким ИНН не найдена в ЕГРЮЛ/ЕГРИП")
    except SourceUnavailable:
        raise IntegrationUnavailable("ЕГРЮЛ сейчас не отвечает. Попробуйте через минуту или заполните данные вручную.")


def _card(data: dict) -> CompanyLookupOut:
    return CompanyLookupOut(
        inn=data["inn"],
        name=data["full_name"],
        short_name=data["short_name"],
        legal_form=data["legal_form"],
        ogrn=data.get("ogrn"),
        registered_at=date.fromisoformat(data["registered_at"]) if data.get("registered_at") else None,
        okved=data.get("okved", {}).get("code"),
        okved_name=data.get("okved", {}).get("name"),
        address=data.get("address"),
        director=data.get("director", {}).get("name"),
        status=data["status"]["code"],
        status_title=data["status"]["title"],
    )


@router.get("/lookup", response_model=CompanyLookupOut, summary="Найти компанию по ИНН (ЕГРЮЛ/ЕГРИП)")
def lookup(
    inn: str = Query(pattern=r"^\d{10}(\d{2})?$"),
    _: User = Depends(get_current_user),
    sources: ExternalSources = Depends(get_sources),
) -> CompanyLookupOut:
    return _card(_registry(sources, inn))


@router.post("/link", response_model=CompanyOut, summary="Привязать компанию к учётной записи нового клиента")
def link(
    data: CompanyLinkIn,
    user: User = Depends(require_client),
    db: Session = Depends(get_db),
    sources: ExternalSources = Depends(get_sources),
) -> Company:
    """Подключить компанию к кабинету может её руководитель или учредитель по данным ЕГРЮЛ. К уже
    подключённой компании присоединяется только руководитель — он источник полномочий и не должен остаться
    без доступа, если первым компанию подключил учредитель. Право подписи получает только руководитель."""
    if user.company_id is not None:
        raise Conflict("Компания уже привязана к учётной записи")
    registry = _registry(sources, data.inn)
    card = _card(registry)
    # Полномочия проверяются первыми: постороннему не сообщаем, обслуживается ли компания в банке.
    authority = authority_of(user.full_name, registry)
    if not authority.may_connect:
        raise Forbidden(
            "По данным ЕГРЮЛ вы не руководитель и не учредитель этой компании. "
            "Подключить её может руководитель — он же выдаст доступ сотрудникам."
        )
    already_connected = Conflict("Эта компания уже подключена к кабинету. Доступ сотрудникам выдаёт её руководитель.")
    company = db.scalar(select(Company).where(Company.inn == card.inn).with_for_update())
    connected = company is not None and db.scalar(select(User.id).where(User.company_id == company.id).limit(1))
    if connected and not authority.is_head:
        raise already_connected
    try:
        if company is None:
            company = Company(
                inn=card.inn, name=card.name, short_name=card.short_name, legal_form=card.legal_form,
                ogrn=card.ogrn, registered_at=card.registered_at, okved=card.okved, okved_name=card.okved_name,
                address=card.address, director=card.director,
            )
            db.add(company)
            db.flush()
        user.company_id = company.id
        user.can_sign = authority.can_sign
        if connected:
            notify_company(
                db,
                company.id,
                kind="info",
                title="К кабинету компании подключился руководитель",
                body=f"{user.full_name} подключился как руководитель по данным ЕГРЮЛ и получил право подписи.",
                link="/",
            )
        db.commit()
    except IntegrityError:
        # Компанию одновременно подключил другой представитель.
        db.rollback()
        raise already_connected
    return company


@router.get("/me/financials", response_model=FinancialsOut, summary="Финансы своей компании по данным ФНС")
def my_financials(user: User = Depends(require_client), sources: ExternalSources = Depends(get_sources)) -> FinancialsOut:
    if user.company is None:
        raise Conflict("Сначала укажите компанию")
    try:
        data = sources.fns(user.company.inn)
    except (NotInSource, SourceUnavailable):
        return FinancialsOut(available=False)
    revenue, expenses = data.get("revenue"), data.get("expenses")
    return FinancialsOut(
        available=revenue is not None,
        reporting_year=data.get("reporting_year"),
        revenue_monthly=revenue // 12 if revenue else None,
        expenses_monthly=expenses // 12 if expenses else None,
        employees=data.get("employees"),
        tax_regime=data.get("tax_regime"),
    )
