"""Strict, immutable artifact contract: malformed weights never reach inference."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.ml.schema import FEATURE_NAMES


class ModelArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True, allow_inf_nan=False)

    schema_version: Literal[2]
    model_version: str = Field(min_length=1, max_length=64)
    training_data: Literal["synthetic"]
    feature_names: tuple[str, ...]
    mean: tuple[float, ...]
    scale: tuple[float, ...]
    coefficients: tuple[float, ...]
    intercept: float
    threshold: float = Field(gt=0, lt=1)
    seed: int
    training_min: tuple[float, ...]
    training_max: tuple[float, ...]

    @model_validator(mode="after")
    def validate_vectors(self):
        if self.feature_names != FEATURE_NAMES:
            raise ValueError("Unsupported model feature order")
        for name in ("mean", "scale", "coefficients", "training_min", "training_max"):
            if len(getattr(self, name)) != len(FEATURE_NAMES):
                raise ValueError(f"Invalid model dimension: {name}")
        if any(s <= 0 for s in self.scale):
            raise ValueError("Model scales must be positive")
        # Bound local artifact parameters as well as inputs: prevent overflow in logit/contributions.
        if any(s < 1e-12 for s in self.scale) or any(abs(v) > 1e6 for v in (*self.mean, *self.coefficients, self.intercept)):
            raise ValueError("Unsafe model parameter magnitude")
        if any(low > high for low, high in zip(self.training_min, self.training_max, strict=True)):
            raise ValueError("Invalid training ranges")
        return self
