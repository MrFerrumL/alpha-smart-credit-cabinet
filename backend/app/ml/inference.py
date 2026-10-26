"""Portable logistic inference: JSON weights, no pickle or sklearn in the API image."""

import hashlib
import logging
import math
from functools import lru_cache
from pathlib import Path

from app.errors import AppError
from app.ml.artifact import ModelArtifact
from app.ml.schema import FEATURE_NAMES, Contribution, ModelInfo, RiskFeatures, RiskPrediction

ARTIFACT_PATH = Path(__file__).parent / "artifacts" / "risk_model.json"
log = logging.getLogger("app.ml")


class ModelUnavailable(AppError):
    status, code, title = 503, "model_unavailable", "Экспериментальная модель временно недоступна"


class RiskModel:
    def __init__(self, raw: bytes):
        self.artifact = ModelArtifact.model_validate_json(raw)
        self.sha256 = hashlib.sha256(raw).hexdigest()

    def info(self) -> ModelInfo:
        return ModelInfo(
            model_version=self.artifact.model_version,
            artifact_sha256=self.sha256,
            feature_names=list(FEATURE_NAMES),
        )

    def predict(self, features: RiskFeatures) -> RiskPrediction:
        a = self.artifact
        values = features.model_dump()
        terms = [
            (float(values[name]) - mean) / scale * coefficient
            for name, mean, scale, coefficient in zip(
                FEATURE_NAMES, a.mean, a.scale, a.coefficients, strict=True
            )
        ]
        logit = a.intercept + math.fsum(terms)
        # Stable sigmoid at both extremes, without clipping the probability.
        probability = 1 / (1 + math.exp(-logit)) if logit >= 0 else math.exp(logit) / (1 + math.exp(logit))
        return RiskPrediction(
            model_version=a.model_version, artifact_sha256=self.sha256,
            probability_default=probability, threshold=a.threshold,
            above_threshold=probability >= a.threshold, intercept_log_odds=a.intercept,
            contributions=[Contribution(feature=n, log_odds=t) for n, t in zip(FEATURE_NAMES, terms, strict=True)],
            out_of_training_range=[
                name for name, low, high in zip(FEATURE_NAMES, a.training_min, a.training_max, strict=True)
                if not low <= float(values[name]) <= high
            ],
        )


@lru_cache(maxsize=1)
def get_model() -> RiskModel:
    try:
        return RiskModel(ARTIFACT_PATH.read_bytes())
    except (OSError, ValueError) as exc:
        # Keep paths, raw JSON and parser details out of the API response and logs.
        log.error("Experimental model could not be loaded", extra={"error_type": type(exc).__name__})
        raise ModelUnavailable() from exc
