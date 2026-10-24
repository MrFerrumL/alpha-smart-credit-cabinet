import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "mocks"))

# По умолчанию — временный SQLite. В CI тесты идут на PostgreSQL со схемой, созданной миграциями.
_db_file = Path(tempfile.mkdtemp()) / "test.db"
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{_db_file.as_posix()}"
os.environ["SEED_ON_START"] = "false"
os.environ["MOCK_LATENCY_MS"] = "0"
os.environ["PIPELINE_STEP_DELAY_S"] = "0"
os.environ["PIPELINE_RETRY_BASE_S"] = "0"
os.environ["PIPELINE_MAX_ATTEMPTS"] = "3"
os.environ["UPLOAD_DIR"] = (Path(tempfile.mkdtemp()) / "uploads").as_posix()

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.db import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.pipeline.runner import run_until_idle  # noqa: E402
from app.seed import seed  # noqa: E402
from app.services.integrations import ExternalSources, get_sources  # noqa: E402
from mockapi.main import app as mock_app  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def database():
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        seed(db)
    yield
    engine.dispose()


@pytest.fixture
def mocks():
    client = TestClient(mock_app)
    yield client
    client.post("/admin/faults", json={"source": "all", "mode": "none"})


@pytest.fixture
def client(mocks):
    app.dependency_overrides[get_sources] = lambda: ExternalSources(mocks, timeout=2, retries=2, backoff=0)
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def auth(client: TestClient, email: str) -> dict:
    response = client.post("/api/auth/demo-login", json={"email": email})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def run_pipeline(mocks) -> int:
    """Прогоняет конвейер до конца синхронно — как воркер, но без пауз."""
    return run_until_idle(SessionLocal, ExternalSources(mocks, timeout=2, retries=1, backoff=0))
