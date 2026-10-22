from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_client
from app.db import get_db
from app.domain.inn import is_valid_inn
from app.errors import BusinessValidationError, Conflict, IntegrationUnavailable, NotFound
from app.models import Company, User
from app.schemas import CompanyLinkIn, CompanyLookupOut, CompanyOut, FinancialsOut
from app.services.integrations import ExternalSources, NotInSource, SourceUnavailable, get_sources

router = APIRouter(prefix="/companies", tags=["Компании"])


def _lookup(sources: ExternalSources, inn: str) -> CompanyLookupOut:
    if not is_valid_inn(inn):
        raise BusinessValidationError(errors=[{"field": "inn", "message": "ИНН введён с ошибкой — проверьте цифры"}])
    try:
        data = sources.egrul(inn)
    except NotInSource:
        raise NotFound("Компания с таким ИНН не найдена в ЕГРЮЛ/ЕГРИП")
    except SourceUnavailable:
        raise IntegrationUnavailable("ЕГРЮЛ сейчас не отвечает. Попробуйте через минуту или заполните данные вручную.")
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
    return _lookup(sources, inn)


@router.post("/link", response_model=CompanyOut, summary="Привязать компанию к учётной записи нового клиента")
def link(
    data: CompanyLinkIn,
    user: User = Depends(require_client),
    db: Session = Depends(get_db),
    sources: ExternalSources = Depends(get_sources),
) -> Company:
    if user.company_id is not None:
        raise Conflict("Компания уже привязана к учётной записи")
    card = _lookup(sources, data.inn)
    company = db.scalar(select(Company).where(Company.inn == card.inn))
    if company is None:
        company = Company(
            inn=card.inn, name=card.name, short_name=card.short_name, legal_form=card.legal_form, ogrn=card.ogrn,
            registered_at=card.registered_at, okved=card.okved, okved_name=card.okved_name, address=card.address,
            director=card.director,
        )
        db.add(company)
        db.flush()
    user.company_id = company.id
    db.commit()
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
