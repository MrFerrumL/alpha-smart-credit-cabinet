from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import require_analyst
from app.db import get_db
from app.models import User
from app.schemas import SystemJobOut
from app.services import system

router = APIRouter(prefix="/system", tags=["Состояние системы"])


@router.get(
    "/jobs",
    response_model=list[SystemJobOut],
    summary="Последние повторы и сбои шагов конвейера",
    description="Шаг, номер заявки, источник и причина простыми словами — без ИНН и текстов ошибок.",
)
def recent_jobs(
    limit: int = Query(10, ge=1, le=50, description="Сколько задач показать, свежие — сверху"),
    _: User = Depends(require_analyst),
    db: Session = Depends(get_db),
) -> list[SystemJobOut]:
    return system.recent_job_issues(db, limit)
