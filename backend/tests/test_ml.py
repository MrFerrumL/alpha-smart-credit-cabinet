import hashlib
import json
import math

import pytest
from pydantic import ValidationError

from app.ml.inference import ARTIFACT_PATH, RiskModel, get_model
from app.ml.schema import RiskFeatures
from tests.conftest import auth

SAMPLE = {
    "business_age_years": 5.0, "dsr": 0.25, "margin": 0.18,
    "max_overdue_days_24m": 0, "inquiries_90d": 2,
    "tax_debt_ratio": 0.0, "has_credit_history": True,
}


def test_probability_explanation_and_provenance():
    prediction = get_model().predict(RiskFeatures(**SAMPLE))
    logit = prediction.intercept_log_odds + sum(c.log_odds for c in prediction.contributions)
    assert prediction.probability_default == pytest.approx(1 / (1 + math.exp(-logit)), abs=1e-14)
    assert prediction.artifact_sha256 == hashlib.sha256(ARTIFACT_PATH.read_bytes()).hexdigest()
    assert prediction.affects_credit_decision is False and prediction.experimental is True
    report = json.loads(ARTIFACT_PATH.with_name("evaluation.json").read_text())
    assert report["artifact_sha256"] == prediction.artifact_sha256


def test_learned_risk_increases_for_more_debt_and_overdue():
    model = get_model()
    good = model.predict(RiskFeatures(**SAMPLE)).probability_default
    bad = model.predict(RiskFeatures(**(SAMPLE | {"dsr": 0.9, "max_overdue_days_24m": 90}))).probability_default
    assert bad > good


@pytest.mark.parametrize("changes", [
    {"dsr": float("nan")}, {"margin": float("inf")}, {"dsr": -0.1},
    {"dsr": "0.2"}, {"tax_debt_ratio": 11}, {"inquiries_90d": 1.5},
    {"has_credit_history": 1}, {"unknown": 1}, {"business_age_years": None},
])
def test_feature_contract_rejects_bad_inputs(changes):
    with pytest.raises(ValidationError):
        RiskFeatures(**(SAMPLE | changes))


@pytest.mark.parametrize("key,value", [
    ("feature_names", []), ("scale", [0] * 7), ("coefficients", [1] * 6),
    ("threshold", 2), ("intercept", float("nan")), ("schema_version", 999),
    ("scale", [1e-300] * 7), ("coefficients", [1e300] * 7),
    ("training_min", [1e10] * 7), ("training_max", []), ("model_version", ""),
])
def test_invalid_artifact_is_rejected(key, value):
    artifact = json.loads(ARTIFACT_PATH.read_bytes())
    artifact[key] = value
    with pytest.raises(ValueError):
        RiskModel(json.dumps(artifact).encode())


def test_extreme_valid_values_are_finite():
    row = SAMPLE | {"business_age_years": 100.0, "dsr": 5.0, "margin": -1.0,
                    "max_overdue_days_24m": 730, "inquiries_90d": 100, "tax_debt_ratio": 10.0}
    probability = get_model().predict(RiskFeatures(**row)).probability_default
    assert math.isfinite(probability) and 0 <= probability <= 1


def test_ml_routes_require_analyst(client):
    customer = auth(client, "bakery@demo.local")
    analyst = auth(client, "analyst@demo.local")
    for path, method, kwargs in [("/api/ml/model", client.get, {}), ("/api/ml/predict", client.post, {"json": SAMPLE})]:
        assert method(path, **kwargs).status_code == 401
        assert method(path, headers=customer, **kwargs).status_code == 403
        response = method(path, headers=analyst, **kwargs)
        assert response.status_code == 200, response.text
        assert response.json()["affects_credit_decision"] is False
    assert client.post("/api/ml/predict", json={}, headers=analyst).status_code == 422
    assert client.post("/api/ml/predict", json=SAMPLE | {"dsr": -1}, headers=analyst).status_code == 422
