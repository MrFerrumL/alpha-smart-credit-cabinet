from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class RiskFeatures(BaseModel):
    """Versioned numeric contract shared by training and serving. No identifiers or outcomes."""

    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)

    business_age_years: float = Field(ge=0, le=100, examples=[5.0])
    dsr: float = Field(ge=0, le=5, description="Debt payments / monthly revenue", examples=[0.25])
    margin: float = Field(ge=-1, le=1, examples=[0.18])
    max_overdue_days_24m: int = Field(ge=0, le=730, examples=[0])
    inquiries_90d: int = Field(ge=0, le=100, examples=[2])
    tax_debt_ratio: float = Field(ge=0, le=10, description="Tax debt / annual revenue", examples=[0.0])
    has_credit_history: bool = Field(examples=[True])


FEATURE_NAMES = tuple(RiskFeatures.model_fields)


class Contribution(BaseModel):
    feature: str
    log_odds: float


class RiskPrediction(BaseModel):
    model_version: str
    artifact_sha256: str
    experimental: Literal[True] = True
    affects_credit_decision: Literal[False] = False
    probability_default: float
    threshold: float
    above_threshold: bool
    intercept_log_odds: float
    contributions: list[Contribution]
    notice: str = "Synthetic-data demonstration; not a validated estimate of real credit risk."


class ModelInfo(BaseModel):
    model_version: str
    artifact_sha256: str
    feature_names: list[str]
    training_data: Literal["synthetic"] = "synthetic"
    experimental: Literal[True] = True
    affects_credit_decision: Literal[False] = False
