"""Дымовая проверка поднятого стенда: демо-вход → заявка «Северной пекарни» → одобрение.

Только стандартная библиотека Python 3.10+, работает на Windows, Linux и macOS:

    python scripts/smoke.py                      # кабинет на http://localhost:8080
    python scripts/smoke.py http://localhost:8080 --timeout 120
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
import uuid


def call(base: str, method: str, path: str, body: dict | None = None, token: str | None = None,
         headers: dict | None = None) -> dict:
    request = urllib.request.Request(base + path, method=method)
    request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(request, data=data, timeout=30) as response:
            return json.loads(response.read() or b"null")
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"{method} {path} → HTTP {exc.code}: {exc.read().decode(errors='replace')}") from exc


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("base", nargs="?", default="http://localhost:8080")
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args()
    base = args.base.rstrip("/")

    ready = call(base, "GET", "/health/ready")
    print("ready:", ready)
    token = call(base, "POST", "/api/auth/demo-login", {"email": "bakery@demo.local"})["access_token"]
    draft = call(base, "POST", "/api/applications", {
        "product_code": "express",
        "purpose": "working_capital",
        "amount": 3_000_000,
        "term_months": 12,
        "form": {"finance": {"monthly_revenue": 4_000_000}, "consent_bki": True},
    }, token)
    app_id = draft["id"]
    call(base, "POST", f"/api/applications/{app_id}/submit", token=token,
         headers={"Idempotency-Key": f"smoke-{uuid.uuid4()}"})
    print(f"submitted application {draft['number']}")

    deadline = time.monotonic() + args.timeout
    status = draft["status"]["code"]
    while time.monotonic() < deadline:
        app = call(base, "GET", f"/api/applications/{app_id}", token=token)
        if app["status"]["code"] != status:
            status = app["status"]["code"]
            print("status:", status)
        if app["status"]["terminal"] or app["status"]["action_required"] or status == "manual_review":
            break
        time.sleep(1)
    if status != "approved":
        print(f"FAIL: expected approved, got {status}", file=sys.stderr)
        return 1
    print("OK: application approved")
    return 0


if __name__ == "__main__":
    sys.exit(main())
