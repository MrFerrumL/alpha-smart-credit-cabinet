"""Симулятор политики: пересчёт сохранённых заявок при других порогах, без изменения данных."""

from tests.conftest import auth, run_pipeline
from tests.test_pipeline import get, submit


def test_tighter_policy_changes_outcomes_without_touching_applications(client, mocks):
    app_id, headers = submit(client, "bakery@demo.local")
    run_pipeline(mocks)
    assert get(client, app_id, headers)["status"]["code"] == "approved"
    analyst = auth(client, "analyst@demo.local")

    same = client.post("/api/policy/simulate", json={"max_dsr": 0.5, "min_coverage": 1.2}, headers=analyst).json()
    assert same["changed"] == [] and same["applications"] >= 1
    assert same["current"]["approval_share"] == same["simulated"]["approval_share"]

    strict = client.post("/api/policy/simulate", json={"max_dsr": 0.1, "min_coverage": 2.5}, headers=analyst).json()
    row = next(r for r in strict["changed"] if r["id"] == app_id)
    assert row["outcome_now"] == "approved" and row["outcome_then"] != "approved"
    assert strict["simulated"]["offered_total"] < strict["current"]["offered_total"]
    assert get(client, app_id, headers)["status"]["code"] == "approved"  # заявка не изменилась


def test_simulator_is_for_bank_staff_only_and_validates_thresholds(client):
    client_headers = auth(client, "bakery@demo.local")
    analyst = auth(client, "analyst@demo.local")
    body = {"max_dsr": 0.5, "min_coverage": 1.2}
    assert client.post("/api/policy/simulate", json=body, headers=client_headers).status_code == 403
    assert client.post("/api/policy/simulate", json={"max_dsr": 5, "min_coverage": 1.2}, headers=analyst).status_code == 422


def test_manual_review_recommendation_changes_are_reported_and_policy_resets(client, mocks):
    from app.scoring.decision import MAX_DSR, MIN_DSCR, policy

    app_id, _ = submit(
        client, "vector@demo.local", product_code="invest", purpose="equipment", amount=25_000_000, term_months=48,
        form={"finance": {"monthly_revenue": 8_000_000}, "collateral": {"kind": "equipment", "value": 30_000_000},
              "consent_bki": True},
    )
    run_pipeline(mocks)
    analyst = auth(client, "analyst@demo.local")
    result = client.post("/api/policy/simulate", json={"max_dsr": 0.5, "min_coverage": 2.0}, headers=analyst).json()
    row = next(r for r in result["changed"] if r["id"] == app_id)
    assert row["outcome_now"] == row["outcome_then"] == "manual_review"
    assert row["offered_then"] < row["offered_now"] == 19_500_000
    assert row["status"] == "manual_review"
    assert (policy().max_dsr, policy().min_dscr) == (MAX_DSR, MIN_DSCR)  # пороги вернулись к действующим
