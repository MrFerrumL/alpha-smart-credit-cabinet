from fastapi import APIRouter

from app.domain.products import PURPOSES
from app.domain.statuses import STAGES, Status
from app.schemas import MetaOut, PurposeOut
from app.services.applications import status_out

router = APIRouter(tags=["Справочники"])


@router.get("/meta", response_model=MetaOut, summary="Этапы, статусы и цели кредита для интерфейса")
def meta() -> MetaOut:
    return MetaOut(
        stages=list(STAGES),
        statuses=[status_out(s) for s in Status],
        purposes=[
            PurposeOut(code=code, title=info.title, description=info.description, icon=info.icon)
            for code, info in PURPOSES.items()
        ],
    )
