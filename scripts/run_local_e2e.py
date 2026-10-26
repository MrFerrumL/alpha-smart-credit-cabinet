"""Start an isolated SQLite demo and run Playwright without Docker (development only)."""

import argparse
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tests", nargs="*", default=["ml-risk.spec.ts"])
    parser.add_argument("--port", type=int, default=18080)
    args = parser.parse_args()
    node = shutil.which("node")
    if not node:
        raise SystemExit("Node.js is required")
    for path in ("frontend/node_modules/vite/bin/vite.js", "e2e/node_modules/@playwright/test/cli.js"):
        if not (ROOT / path).exists():
            raise SystemExit("Run npm ci in frontend and e2e, then npx playwright install chromium in e2e")
    for port in (8000, 8001, args.port):
        with socket.socket() as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                raise SystemExit(f"Port {port} is already in use; stop that development service first")
    work = ROOT / ".local-e2e"
    work.mkdir(exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix="run-", dir=work))
    env = os.environ | {
        "DATABASE_URL": "sqlite:///" + (run / "credit.db").as_posix(),
        "UPLOAD_DIR": (run / "uploads").as_posix(), "MOCKS_URL": "http://127.0.0.1:8001",
        "ENVIRONMENT": "local", "DEMO_MODE": "true", "SEED_ON_START": "true",
        "MOCK_LATENCY_MS": "0", "PIPELINE_STEP_DELAY_S": "0", "WORKER_POLL_INTERVAL_S": "0.1",
        "PYTHONIOENCODING": "utf-8", "E2E_BASE_URL": f"http://127.0.0.1:{args.port}",
        "E2E_MOCKS_URL": "http://127.0.0.1:8001",
    }
    processes, logs = [], []

    def start(name, command, cwd):
        log = (run / f"{name}.log").open("w", encoding="utf-8")
        logs.append(log)
        processes.append(subprocess.Popen(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT,
                         creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0))

    def ready(url):
        for _ in range(200):
            if any(p.poll() is not None for p in processes):
                raise RuntimeError(f"A service exited; see {run}")
            try:
                with urllib.request.urlopen(url, timeout=1) as response:
                    if response.status == 200:
                        return
            except OSError:
                time.sleep(0.2)
        raise TimeoutError(url)

    try:
        subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=ROOT / "backend", env=env, check=True)
        start("mocks", [sys.executable, "-m", "uvicorn", "mockapi.main:app", "--host", "127.0.0.1", "--port", "8001"], ROOT / "mocks")
        ready("http://127.0.0.1:8001/health")
        start("backend", [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000"], ROOT / "backend")
        ready("http://127.0.0.1:8000/health/ready")
        start("worker", [sys.executable, "-m", "app.worker"], ROOT / "backend")
        start("frontend", [node, "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", str(args.port), "--strictPort"], ROOT / "frontend")
        ready(env["E2E_BASE_URL"])
        result = subprocess.run([node, "node_modules/@playwright/test/cli.js", "test", *args.tests], cwd=ROOT / "e2e", env=env)
        return result.returncode
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        for log in logs:
            log.close()
        print(f"Development stack logs and isolated database: {run}")


if __name__ == "__main__":
    raise SystemExit(main())
