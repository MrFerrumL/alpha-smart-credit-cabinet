"""Portable logistic inference: JSON weights, no pickle or sklearn in the API image."""

import hashlib
import json
import math
from functools import lru_cache
from pathlib import Path

from app.ml.schema import FEATURE_NAMES, Contribution, ModelInfo, RiskFeatures, RiskPrediction

ARTIFACT_PATH = Path(__file__).parent / "artifacts" / "risk_model.json"


class RiskModel:
    def __init__(self, raw: bytes):
        artifact = json.loads(raw)
        if artifact["schema_version"] != 1 or artifact["feature_names"] != list(FEATURE_NAMES):
            raise ValueError("Unsupported model feature contract")
        for key in ("mean", "scale", "coefficients"):
            values = artifact[key]
            if len(values) != len(FEATURE_NAMES) or not all(math.isfinite(v) for v in values):
                raise ValueError(f"Invalid model {key}")
        if any(v <= 0 for v in artifact["scale"]):
            raise ValueError("Model scales must be positive")
        if not math.isfinite(artifact["intercept"]) or not 0 < artifact["threshold"] < 1:
            raise ValueError("Invalid intercept or threshold")
        if artifact["training_data"] != "synthetic":
            raise ValueError("Only the synthetic demonstration model is supported")
        self.artifact = artifact
        self.sha256 = hashlib.sha256(raw).hexdigest()

    def info(self) -> ModelInfo:
        return ModelInfo(
            model_version=self.artifact["model_version"],
            artifact_sha256=self.sha256,
            feature_names=list(FEATURE_NAMES),
        )

    def predict(self, features: RiskFeatures) -> RiskPrediction:
        a = self.artifact
        values = features.model_dump()
        terms = [
            (float(values[name]) - mean) / scale * coefficient
            for name, mean, scale, coefficient in zip(
                FEATURE_NAMES, a["mean"], a["scale"], a["coefficients"], strict=True
            )
        ]
        logit = a["intercept"] + math.fsum(terms)
        # Stable sigmoid at both extremes, without clipping the probability.
        probability = 1 / (1 + math.exp(-logit)) if logit >= 0 else math.exp(logit) / (1 + math.exp(logit))
        return RiskPrediction(
            model_version=a["model_version"], artifact_sha256=self.sha256,
            probability_default=probability, threshold=a["threshold"],
            above_threshold=probability >= a["threshold"], intercept_log_odds=a["intercept"],
            contributions=[Contribution(feature=n, log_odds=t) for n, t in zip(FEATURE_NAMES, terms, strict=True)],
        )


@lru_cache(maxsize=1)
def get_model() -> RiskModel:
    return RiskModel(ARTIFACT_PATH.read_bytes())
