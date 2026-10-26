"""Optional training checks, separate from the dependency-light backend test suite."""

import json

import numpy as np
import pytest

from app.ml.inference import ARTIFACT_PATH
from scripts.train_risk import generate_data, train


def test_generator_has_stochastic_outcomes_and_fixed_seed():
    x, y = generate_data(12000, 42)
    x2, y2 = generate_data(12000, 42)
    assert np.array_equal(x, x2) and np.array_equal(y, y2)
    assert x.shape == (12000, 7) and set(y) == {0, 1}
    assert 0.6 < np.mean(x[:, 5] == 0) < 0.7  # Zero tax debt is explicitly represented.
    assert not np.array_equal(y, generate_data(12000, 43)[1])


def test_retraining_matches_committed_model_and_beats_constant_baseline(tmp_path):
    train(12000, 42, tmp_path)
    expected = json.loads(ARTIFACT_PATH.read_bytes())
    actual = json.loads((tmp_path / "risk_model.json").read_bytes())
    for key in ("mean", "scale", "coefficients", "intercept", "threshold", "training_min", "training_max"):
        np.testing.assert_allclose(actual[key], expected[key], atol=1e-8, rtol=1e-8)
    report = json.loads((tmp_path / "evaluation.json").read_bytes())
    assert report["split_rows"] == {"train": 7200, "validation": 2400, "test": 2400}
    assert report["serving_max_absolute_error"] < 1e-12
    assert report["test"]["roc_auc"] > 0.7
    assert report["test"]["brier_score"] < report["constant_baseline"]["brier_score"]
    assert report["test"]["log_loss"] < report["constant_baseline"]["log_loss"]


def test_too_small_dataset_is_rejected(tmp_path):
    with pytest.raises(ValueError, match="1000"):
        train(10, 42, tmp_path)
