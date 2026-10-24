"""Трасса решения согласована с самим решением на всех путях политики."""

from dataclasses import replace

import pytest

from app.domain.products import PRODUCTS, Purpose
from app.scoring import rules
from app.scoring.decision import decide, explain
from app.scoring.features import Features
from tests.conftest import auth

BASE = Features(
    business_age_years=6.0, company_status="active", revenue_monthly=4_000_000, revenue_source="fns",
    declared_revenue_monthly=4_000_000, margin=0.15, existing_payments=50_000, total_debt=600_000,
    has_credit_history=True, max_overdue_days_24m=0, current_overdue_days=0, current_overdue_amount=0,
    inquiries_90d=1, tax_debt=0, mass_address=False, disqualified_director=False, blocked_accounts=False,
    requested_payment=100_000, dsr=0.04,
)
OUTCOME_TITLES = {"approved": "Одобрение", "counter_offer": "Контрпредложение", "manual_review": "Специалист",
                  "rejected": "Отказ", "needs_info": "Запрос информации"}


@pytest.mark.parametrize(
    ("changes", "product", "amount", "expected"),
    [
        ({}, "express", 1_000_000, "approved"),
        ({}, "express", 9_000_000, "counter_offer"),
        ({"company_status": "liquidating"}, "express", 1_000_000, "rejected"),
        ({"revenue_monthly": None, "revenue_source": None, "dsr": None}, "express", 1_000_000, "needs_info"),
        ({"current_overdue_days": 70}, "express", 1_000_000, "rejected"),
        ({"current_overdue_days": 10}, "express", 1_000_000, "manual_review"),
        ({}, "invest", 10_000_000, "manual_review"),
        ({"margin": -0.05}, "express", 1_000_000, "rejected"),
        ({"existing_payments": 1_990_000, "revenue_monthly": 4_000_000}, "express", 300_000, None),
    ],
)
def test_trace_ends_with_the_actual_outcome(changes, product, amount, expected):
    f = replace(BASE, **changes)
    s = rules.score(f)
    p = PRODUCTS[product]
    term = 24 if product == "invest" else 12
    d = decide(f, s, p, amount, term, Purpose.WORKING_CAPITAL if product != "invest" else Purpose.EQUIPMENT)
    if expected:
        assert d.outcome.value == expected
    trace = explain(f, s, p, amount, term, d)
    assert trace[-1]["title"] == "Итог"
    assert trace[-1]["detail"].startswith(OUTCOME_TITLES[d.outcome.value].split()[0]) or d.outcome.value == "rejected"
    if d.outcome.value == "rejected" and d.reasons and not any(t["title"].startswith("Стоп") and t["result"] == "fail"
                                                                for t in trace) and s.grade != "E":
        assert any(d.reasons[0] == t["detail"] for t in trace)  # причина отказа в трассе — та же, что у клиента


def test_replay_is_for_analysts_and_needs_scoring(client, mocks):
    from tests.test_pipeline import submit

    app_id, client_headers = submit(client, "bakery@demo.local", form={"consent_bki": True})
    analyst = auth(client, "analyst@demo.local")
    assert client.post(f"/api/applications/{app_id}/assessment/replay", headers=client_headers).status_code == 403
    assert client.post(f"/api/applications/{app_id}/assessment/replay", headers=analyst).status_code == 409


def test_features_saved_before_declared_debt_was_added_still_load():
    # Снимки признаков в старых заявках не содержат declared_debt_payments: воспроизведение и симулятор их читают.
    stored = {k: v for k, v in BASE.as_dict().items() if k != "declared_debt_payments"}
    assert Features(**stored).declared_debt_payments is None
