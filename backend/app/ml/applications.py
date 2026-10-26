"""Read-only adapter: predict from the saved scoring snapshot, never the mutable client form."""

import math
from datetime import timezone

from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.ml.inference import get_model
from app.ml.schema import ApplicationRisk, FEATURE_NAMES, RiskFeatures
from app.models import Application
from app.services.decisions import latest_scoring


def _finite_number(value) -> bool:
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def snapshot_features(snapshot: dict) -> tuple[RiskFeatures | None, list[str]]:
    data = {name: snapshot.get(name) for name in FEATURE_NAMES if name != "tax_debt_ratio"}
    revenue, tax = snapshot.get("revenue_monthly"), snapshot.get("tax_debt")
    # Missing/invalid values must not silently turn into zero debt or zero risk.
    if not _finite_number(revenue) or revenue <= 0:
        return None, ["revenue_monthly"]
    if not _finite_number(tax) or tax < 0:
        return None, ["tax_debt"]
    data["tax_debt_ratio"] = (tax / revenue) / 12
    try:
        return RiskFeatures.model_validate(data), []
    except ValidationError as exc:
        return None, sorted({str(error["loc"][0]) for error in exc.errors()})


def application_risk(db: Session, application: Application) -> ApplicationRisk:
    scoring = latest_scoring(db, application)
    if scoring is None or not isinstance(scoring.features, dict):
        return ApplicationRisk(application_id=application.id, status="unavailable", unavailable_fields=["scoring_snapshot"])
    features, invalid = snapshot_features(scoring.features)
    scored_at = scoring.created_at
    if scored_at.tzinfo is None:
        scored_at = scored_at.replace(tzinfo=timezone.utc)  # SQLite stores the UTC timestamp without its zone.
    common = {"application_id": application.id, "scoring_id": scoring.id, "scored_at": scored_at}
    if features is None:
        return ApplicationRisk(**common, status="unavailable", unavailable_fields=invalid)
    return ApplicationRisk(**common, status="available", prediction=get_model().predict(features))
