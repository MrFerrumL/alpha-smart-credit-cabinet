from fastapi import APIRouter, Depends

from app.api.deps import require_analyst
from app.ml.inference import RiskModel, get_model
from app.ml.schema import BatchRiskIn, BatchRiskOut, ModelInfo, RiskFeatures, RiskPrediction

router = APIRouter(prefix="/ml", tags=["ML risk"], dependencies=[Depends(require_analyst)])


@router.get("/model", response_model=ModelInfo, summary="Version and provenance of the experimental model")
def model_info(model: RiskModel = Depends(get_model)) -> ModelInfo:
    return model.info()


@router.post("/predict", response_model=RiskPrediction, summary="Experimental risk estimate on synthetic data")
def predict_risk(features: RiskFeatures, model: RiskModel = Depends(get_model)) -> RiskPrediction:
    return model.predict(features)


@router.post("/predict-batch", response_model=BatchRiskOut, summary="Experimental predictions for 1–100 rows, input order preserved")
def predict_batch(data: BatchRiskIn, model: RiskModel = Depends(get_model)) -> BatchRiskOut:
    return BatchRiskOut(predictions=[model.predict(item) for item in data.items])
