"""Microbenchmark cached in-process inference; excludes HTTP, authentication and database work."""

import argparse
import json
import platform
import statistics
import time
from pathlib import Path

from app.ml.inference import get_model
from app.ml.schema import RiskFeatures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=10000)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 100 <= args.iterations <= 1000000:
        parser.error("iterations must be between 100 and 1000000")
    features = RiskFeatures(business_age_years=5.0, dsr=0.25, margin=0.18, max_overdue_days_24m=0,
                            inquiries_90d=2, tax_debt_ratio=0.0, has_credit_history=True)
    model = get_model()
    for _ in range(200):
        model.predict(features)
    timings = []
    for _ in range(args.iterations):
        start = time.perf_counter_ns()
        model.predict(features)
        timings.append((time.perf_counter_ns() - start) / 1000)
    timings.sort()
    report = {
        "scope": "warm in-process inference only; no HTTP, DB, authentication or concurrency",
        "model_version": model.info().model_version, "artifact_sha256": model.sha256,
        "iterations": args.iterations, "warmup": 200, "unit": "microseconds",
        "p50": statistics.median(timings), "p95": timings[int(0.95 * (len(timings) - 1))],
        "p99": timings[int(0.99 * (len(timings) - 1))], "mean": statistics.mean(timings),
        "environment": {"python": platform.python_version(), "os": platform.system(), "machine": platform.machine()},
        "limitations": "Single process and one input; not an API load test or production SLO",
    }
    text = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding="utf-8", newline="\n")
    print(text)


if __name__ == "__main__":
    main()
