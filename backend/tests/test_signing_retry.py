"""Повтор подтверждения подписи, ответ на которое не дошёл до клиента: тот же код — 200 и текущее состояние,
договор подписан один раз и выдача запущена один раз. Любой другой повтор по-прежнему отклоняется."""

from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import Job
from tests.conftest import auth, run_pipeline
from tests.test_pipeline import events
from tests.test_signing import approved, other


def confirm(client, app_id: int, headers: dict, challenge: dict, code: str | None = None):
    return client.post(
        f"/api/applications/{app_id}/signing/confirm",
        json={"challenge_id": challenge["challenge_id"], "code": code or challenge["demo_code"]},
        headers=headers,
    )


def disburse_jobs(app_id: int) -> int:
    with SessionLocal() as db:
        query = select(func.count()).select_from(Job).where(Job.application_id == app_id)
        return db.scalar(query.where(Job.kind == "pipeline.disburse"))


def test_repeated_confirm_returns_the_signed_contract_instead_of_409(client, mocks):
    app_id, headers = approved(client, mocks)
    assert client.post(f"/api/applications/{app_id}/offer/accept", headers=headers).status_code == 200
    challenge = client.post(f"/api/applications/{app_id}/signing/code", headers=headers).json()
    first = confirm(client, app_id, headers, challenge)
    assert first.status_code == 200, first.text

    again = confirm(client, app_id, headers, challenge)
    assert again.status_code == 200, again.text
    assert again.json()["offer"] == first.json()["offer"]
    assert again.json()["status"]["code"] == first.json()["status"]["code"] == "signing"
    assert events(client, app_id, headers).count("contract_signed") == 1
    assert disburse_jobs(app_id) == 1

    run_pipeline(mocks)
    after_issue = confirm(client, app_id, headers, challenge)  # повтор пришёл уже после зачисления денег
    assert after_issue.status_code == 200, after_issue.text
    assert after_issue.json()["status"]["code"] == "issued"
    assert events(client, app_id, headers).count("contract_signed") == 1


def test_only_the_exact_repeat_is_accepted(client, mocks):
    app_id, headers = approved(client, mocks)
    client.post(f"/api/applications/{app_id}/offer/accept", headers=headers)
    earlier = client.post(f"/api/applications/{app_id}/signing/code", headers=headers).json()
    later = client.post(f"/api/applications/{app_id}/signing/code", headers=headers).json()
    assert confirm(client, app_id, headers, later).status_code == 200

    assert confirm(client, app_id, headers, later, code=other(later["demo_code"])).status_code == 409
    assert confirm(client, app_id, headers, earlier).status_code == 409  # отменённый код — не повтор
    unknown = {"challenge_id": later["challenge_id"] + 10_000, "demo_code": later["demo_code"]}
    assert confirm(client, app_id, headers, unknown).status_code == 409
    accountant = auth(client, "buh@demo.local")  # у бухгалтера нет права подписи
    assert confirm(client, app_id, accountant, later).status_code == 403
    assert events(client, app_id, headers).count("contract_signed") == 1
    assert disburse_jobs(app_id) == 1
