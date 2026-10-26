"""Reproducible synthetic experiment. Run from backend: python -m scripts.train_risk."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import sklearn
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, confusion_matrix, log_loss, roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from app.ml.inference import RiskModel
from app.ml.schema import FEATURE_NAMES, RiskFeatures

DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "app" / "ml" / "artifacts"


def generate_data(rows: int, seed: int):
    rng = np.random.default_rng(seed)
    age = rng.uniform(0, 20, rows)
    dsr = np.clip(rng.gamma(2, 0.16, rows), 0, 2)
    margin = np.clip(rng.normal(0.15, 0.12, rows), -0.8, 0.8)
    overdue = rng.choice([0, 15, 30, 60, 90, 180], rows, p=[0.65, 0.12, 0.10, 0.07, 0.04, 0.02])
    inquiries = rng.poisson(3, rows)
    tax_ratio = np.clip(rng.exponential(0.025, rows), 0, 1)
    history = rng.binomial(1, 0.8, rows)
    x = np.column_stack([age, dsr, margin, overdue, inquiries, tax_ratio, history])
    # A designed latent probability, not labels from the existing rule-based scorecard.
    logit = -2.8 - 0.055 * age + 3.4 * dsr - 2.5 * margin + 0.018 * overdue + 0.10 * inquiries + 5 * tax_ratio - 0.25 * history
    probability = 1 / (1 + np.exp(-logit))
    y = rng.binomial(1, probability)
    return x, y


def metrics(y, probability, threshold):
    tn, fp, fn, tp = confusion_matrix(y, probability >= threshold, labels=[0, 1]).ravel()
    return {
        "roc_auc": float(roc_auc_score(y, probability)),
        "average_precision": float(average_precision_score(y, probability)),
        "brier_score": float(brier_score_loss(y, probability)),
        "log_loss": float(log_loss(y, probability)),
        "confusion_matrix": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
        "cost_per_row": float((5 * fn + fp) / len(y)),
    }


def train(rows: int, seed: int, output: Path):
    if rows < 1000:
        raise ValueError("Use at least 1000 rows for the three stratified splits")
    x, y = generate_data(rows, seed)
    train_x, rest_x, train_y, rest_y = train_test_split(x, y, test_size=0.4, stratify=y, random_state=seed)
    val_x, test_x, val_y, test_y = train_test_split(rest_x, rest_y, test_size=0.5, stratify=rest_y, random_state=seed + 1)
    pipeline = make_pipeline(StandardScaler(), LogisticRegression(C=1.0, max_iter=1000, random_state=seed))
    pipeline.fit(train_x, train_y)  # Preprocessing is fitted exclusively on the training partition.
    val_p = pipeline.predict_proba(val_x)[:, 1]
    candidates = np.linspace(0.05, 0.95, 91)
    costs = [np.mean(5 * ((val_p < t) & (val_y == 1)) + ((val_p >= t) & (val_y == 0))) for t in candidates]
    threshold = float(candidates[np.argmin(costs)])  # Never tune on the test partition.
    scaler, classifier = pipeline.steps[0][1], pipeline.steps[1][1]
    artifact = {
        "schema_version": 1, "model_version": "synthetic-risk-logreg-v1", "training_data": "synthetic",
        "feature_names": list(FEATURE_NAMES), "mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist(),
        "coefficients": classifier.coef_[0].tolist(), "intercept": float(classifier.intercept_[0]),
        "threshold": threshold, "seed": seed,
    }
    raw = (json.dumps(artifact, indent=2, allow_nan=False) + "\n").encode()
    portable = RiskModel(raw)
    # Verify the JSON serving implementation against sklearn on the entire held-out partition.
    portable_p = []
    for row in test_x:
        body = dict(zip(FEATURE_NAMES, row.tolist(), strict=True))
        for name in ("max_overdue_days_24m", "inquiries_90d"):
            body[name] = int(body[name])
        body["has_credit_history"] = bool(body["has_credit_history"])
        portable_p.append(portable.predict(RiskFeatures(**body)).probability_default)
    test_p = pipeline.predict_proba(test_x)[:, 1]
    parity_error = float(np.max(np.abs(np.array(portable_p) - test_p)))
    if parity_error > 1e-12:
        raise ValueError(f"Export parity failed: {parity_error}")
    baseline_p = np.full(len(test_y), train_y.mean())
    calibration = []
    for low in np.arange(0, 1, 0.1):
        mask = (test_p >= low) & (test_p < low + 0.1)
        if mask.any():
            calibration.append({"lower": round(float(low), 1), "count": int(mask.sum()),
                                "predicted": float(test_p[mask].mean()), "observed": float(test_y[mask].mean())})
    report = {
        "dataset": "synthetic-v1; Bernoulli outcomes from designed latent probabilities",
        "seed": seed, "rows": rows, "split_rows": {"train": len(train_y), "validation": len(val_y), "test": len(test_y)},
        "dataset_sha256": hashlib.sha256(np.column_stack([x, y]).astype("<f8").tobytes()).hexdigest(),
        "artifact_sha256": hashlib.sha256(raw).hexdigest(),
        "versions": {"numpy": np.__version__, "scikit_learn": sklearn.__version__},
        "test_default_rate": float(test_y.mean()), "threshold": threshold,
        "threshold_selection": "validation only; minimize (5 * false_negatives + false_positives) / rows",
        "test": metrics(test_y, test_p, threshold), "constant_baseline": metrics(test_y, baseline_p, threshold),
        "test_calibration_bins": calibration, "serving_max_absolute_error": parity_error,
        "limitations": ["Synthetic outcomes only", "Random split; no temporal validation", "No real-world performance claim"],
    }
    output.mkdir(parents=True, exist_ok=True)
    (output / "risk_model.json").write_bytes(raw)
    (output / "evaluation.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"test": report["test"], "threshold": threshold, "output": str(output)}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, default=12000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    train(args.rows, args.seed, args.output_dir)


if __name__ == "__main__":
    main()
