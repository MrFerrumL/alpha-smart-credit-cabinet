from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db import get_db
from app.models import Notification, User
from app.schemas import NotificationOut
from app.services import notifications as svc

router = APIRouter(prefix="/notifications", tags=["Уведомления"])


@router.get("", response_model=list[NotificationOut], summary="Последние уведомления")
def list_notifications(
    user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[Notification]:
    return svc.list_for(db, user)


@router.post("/read-all", status_code=status.HTTP_204_NO_CONTENT, summary="Отметить все как прочитанные")
def read_all(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> None:
    svc.mark_all_read(db, user)
