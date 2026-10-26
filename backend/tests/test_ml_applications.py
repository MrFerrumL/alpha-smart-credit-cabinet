import pytest
from sqlalchemy import func, select

from app.db import SessionLocal
from app.ml.applications import snapshot_features
from app.ml.inference import get_model
from app.ml.schema import RiskFeatures
from app.models import ApplicationEvent, Offer, ScoringResult
from tests.conftest import auth, run_pipeline
from tests.test_ml import SAMPLE
from tests.test_pipeline import get, submit


def test_prediction_uses_saved_snapshot_and_does_not_mutate_application(client, mocks):
    app_id, customer = submit(client, "bakery@demo.local")
    run_pipeline(mocks)
    analyst = auth(client, "analyst@demo.local")
    before = get(client, app_id, customer)
    with SessionLocal() as db:
        counts = [db.scalar(select(func.count()).select_from(table)) for table in (ApplicationEvent, Offer, ScoringResult)]
        saved = db.scalar(select(ScoringResult).where(ScoringResult.application_id == app_id).order_by(ScoringResult.id.desc()))
        expected_features, errors = snapshot_features(saved.features)
        expected_probability = get_model().predict(expected_features).probability_default
        saved_id = saved.id
    assert errors == []
    for _ in range(2):
        response = client.get(f"/api/applications/{app_id}/ml-risk", headers=analyst)
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "available" and body["scoring_id"] == saved_id
        assert body["source"] == "saved_scoring_snapshot" and body["scored_at"]
        assert body["scored_at"].endswith(("Z", "+00:00"))
        assert body["prediction"]["probability_default"] == pytest.approx(expected_probability)
        assert body["affects_credit_decision"] is False
    assert get(client, app_id, customer) == before
    with SessionLocal() as db:
        assert counts == [db.scalar(select(func.count()).select_from(table)) for table in (ApplicationEvent, Offer, ScoringResult)]


def test_no_snapshot_and_bad_latest_snapshot_do_not_produce_fake_risk(client, mocks):
    app_id, _ = submit(client, "bakery@demo.local")
    analyst = auth(client, "analyst@demo.local")
    path = f"/api/applications/{app_id}/ml-risk"
    early = client.get(path, headers=analyst).json()
    assert early["status"] == "unavailable" and early["prediction"] is None
    assert early["unavailable_fields"] == ["scoring_snapshot"]
    run_pipeline(mocks)
    with SessionLocal() as db:
        previous = db.scalar(select(ScoringResult).where(ScoringResult.application_id == app_id))
        latest = ScoringResult(application_id=app_id, method="rules", model_version="test-snapshot",
                               grade="A", score=90, features=previous.features | {"margin": None})
        db.add(latest)
        db.commit()
        latest_id = latest.id
    result = client.get(path, headers=analyst).json()
    assert result["status"] == "unavailable" and result["prediction"] is None
    assert result["scoring_id"] == latest_id and result["unavailable_fields"] == ["margin"]


def test_snapshot_route_restricts_roles_and_hides_drafts(client):
    customer = auth(client, "bakery@demo.local")
    analyst = auth(client, "analyst@demo.local")
    created = client.post("/api/applications", json={"product_code": "express", "purpose": "working_capital", "amount": 500000, "term_months": 12}, headers=customer)
    assert created.status_code == 201
    path = f"/api/applications/{created.json()['id']}/ml-risk"
    assert client.get(path).status_code == 401
    assert client.get(path, headers=customer).status_code == 403
    assert client.get(path, headers=analyst).status_code == 404
    assert client.get("/api/applications/999999999/ml-risk", headers=analyst).status_code == 404


@pytest.mark.parametrize("changes,field", [
    ({"revenue_monthly": None}, "revenue_monthly"), ({"revenue_monthly": 0}, "revenue_monthly"),
    ({"revenue_monthly": True}, "revenue_monthly"), ({"revenue_monthly": 10**400}, "revenue_monthly"),
    ({"tax_debt": None}, "tax_debt"), ({"tax_debt": -1}, "tax_debt"),
    ({"tax_debt": 10**400}, "tax_debt"), ({"margin": None}, "margin"),
    ({"dsr": 99}, "dsr"), ({"inquiries_90d": "2"}, "inquiries_90d"),
])
def test_snapshot_adapter_rejects_missing_or_invalid_inputs(changes, field):
    snapshot = SAMPLE | {"revenue_monthly": 1_000_000, "tax_debt": 120_000} | changes
    features, fields = snapshot_features(snapshot)
    assert features is None and field in fields


def test_snapshot_adapter_uses_annual_revenue_for_tax_ratio():
    features, fields = snapshot_features(SAMPLE | {"revenue_monthly": 1_000_000, "tax_debt": 120_000})
    assert not fields and features.tax_debt_ratio == pytest.approx(0.01)


def test_snapshot_ratio_does_not_overflow_annual_revenue():
    features, errors = snapshot_features(SAMPLE | {"revenue_monthly": 1e308, "tax_debt": 1e308})
    assert not errors and features.tax_debt_ratio == pytest.approx(1 / 12)


def test_batch_preserves_order_and_has_same_predictions_as_single_requests(client):
    analyst = auth(client, "analyst@demo.local")
    items = [SAMPLE, SAMPLE | {"dsr": 1.0, "max_overdue_days_24m": 90}]
    batch = client.post("/api/ml/predict-batch", json={"items": items}, headers=analyst)
    assert batch.status_code == 200, batch.text
    expected = [client.post("/api/ml/predict", json=item, headers=analyst).json() for item in items]
    assert batch.json()["predictions"] == expected


def test_batch_limits_are_atomic_and_require_analyst(client):
    analyst = auth(client, "analyst@demo.local")
    customer = auth(client, "bakery@demo.local")
    path = "/api/ml/predict-batch"
    assert client.post(path, json={"items": [SAMPLE]}).status_code == 401
    assert client.post(path, json={"items": [SAMPLE]}, headers=customer).status_code == 403
    for items in ([], [SAMPLE] * 101, [SAMPLE, SAMPLE | {"dsr": -1}]):
        response = client.post(path, json={"items": items}, headers=analyst)
        assert response.status_code == 422 and "predictions" not in response.json()
    assert len(client.post(path, json={"items": [SAMPLE] * 100}, headers=analyst).json()["predictions"]) == 100


@pytest.mark.parametrize("content", [b'{"secret-path":"do-not-expose"}', b'not-json', None])
def test_bad_or_missing_artifact_returns_safe_503_and_core_stays_ready(client, monkeypatch, tmp_path, content):
    from app.ml import inference

    path = tmp_path / "model.json"
    if content is not None:
        path.write_bytes(content)
    get_model.cache_clear()
    monkeypatch.setattr(inference, "ARTIFACT_PATH", path)
    try:
        analyst = auth(client, "analyst@demo.local")
        response = client.post("/api/ml/predict", json=SAMPLE, headers=analyst)
        assert response.status_code == 503
        assert response.json()["code"] == "model_unavailable"
        assert "do-not-expose" not in response.text and str(path) not in response.text
        assert client.get("/health/ready").status_code == 200
        assert client.get("/api/products").status_code == 200
    finally:
        get_model.cache_clear()


def test_valid_extreme_input_reports_training_range_warning():
    prediction = get_model().predict(RiskFeatures(**(SAMPLE | {"business_age_years": 100.0})))
    assert "business_age_years" in prediction.out_of_training_range
