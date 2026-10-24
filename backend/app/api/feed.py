from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import require_client
from app.db import get_db
from app.models import User
from app.schemas import FeedItemOut
from app.services import feed as svc

router = APIRouter(prefix="/feed", tags=["Лента"])


@router.get(
    "",
    response_model=list[FeedItemOut],
    summary="Персональная лента новостей (синтетические новости, подобраны под компанию и её заявки)",
)
def news_feed(user: User = Depends(require_client), db: Session = Depends(get_db)) -> list[FeedItemOut]:
    return [FeedItemOut(**item.__dict__) for item in svc.feed_for(db, user)]
