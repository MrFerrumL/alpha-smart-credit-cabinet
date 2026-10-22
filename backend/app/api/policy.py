from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import require_analyst
from app.db import get_db
from app.models import User
from app.schemas import PolicySimulationIn, PolicySimulationOut
from app.services import policy_sim

router = APIRouter(prefix="/policy", tags=["Политика"])


@router.post(
    "/simulate",
    response_model=PolicySimulationOut,
    summary="Что если изменить пороги политики: пересчёт сохранённых заявок без изменения данных",
)
def simulate_policy(
    data: PolicySimulationIn, _: User = Depends(require_analyst), db: Session = Depends(get_db)
) -> PolicySimulationOut:
    return policy_sim.simulate(db, data)
