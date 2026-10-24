"""Документы по заявке: формат проверяется по содержимому, их число ограничено, файл без записи в БД не остаётся."""

from pathlib import Path

from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from app.config import get_settings
from app.services.tasks import MAX_DOCUMENTS
from tests.conftest import auth

PDF = "%PDF-1.4\n% Выписка\n%%EOF\n".encode()
OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + bytes(24)
ZIP = b"PK\x03\x04" + bytes(24)


def _draft(client, headers) -> int:
    body = {"product_code": "express", "purpose": "working_capital", "amount": 1_000_000, "term_months": 12}
    response = client.post("/api/applications", json=body, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _upload(client, app_id: int, headers: dict, name: str, content: bytes):
    return client.post(
        f"/api/applications/{app_id}/documents",
        headers=headers,
        data={"kind": "other"},
        files={"file": (name, content, "application/octet-stream")},
    )


def _stored_files() -> set[Path]:
    return {p for p in Path(get_settings().upload_dir).rglob("*") if p.is_file()}


def test_file_content_must_match_its_extension(client):
    headers = auth(client, "bakery@demo.local")
    app_id = _draft(client, headers)
    for name, content in {
        "vypiska.pdf": PDF,
        "scan.png": b"\x89PNG\r\n\x1a\n" + bytes(24),
        "photo.JPG": b"\xff\xd8\xff\xe0" + bytes(24),
        "report.xlsx": ZIP,
        "contract.docx": ZIP,
        "old.xls": OLE,
        "old.doc": OLE,
        "oboroty.csv": "﻿дата;сумма\n01.10.2026;150000\n".encode(),
        "notes.txt": "Выручка за полгода".encode(),
    }.items():
        response = _upload(client, app_id, headers, name, content)
        assert response.status_code == 201, (name, response.text)

    before = _stored_files()
    for name, content, message in (
        ("virus.pdf", b"MZ\x90\x00" + bytes(24), "Файл не похож на PDF: содержимое не совпадает с расширением"),
        ("photo.png", b"\xff\xd8\xff\xe0" + bytes(24), "Файл не похож на PNG: содержимое не совпадает с расширением"),
        ("contract.docx", OLE, "Файл не похож на DOCX: содержимое не совпадает с расширением"),
        ("old.xls", ZIP, "Файл не похож на XLS: содержимое не совпадает с расширением"),
        ("oboroty.csv", "дата;сумма".encode("cp1251"), "Файл CSV должен быть текстом в кодировке UTF-8"),
        ("program.txt", b"MZ\x00\x00", "Файл TXT должен быть текстом в кодировке UTF-8"),
        ("cut.txt", "Выручка".encode()[:-1], "Файл TXT должен быть текстом в кодировке UTF-8"),  # оборван на букве
        ("empty.pdf", b"", "Файл пустой"),
    ):
        response = _upload(client, app_id, headers, name, content)
        assert response.status_code == 422, (name, response.text)
        assert response.json()["errors"] == [{"field": "file", "message": message}]
    assert _stored_files() == before  # отклонённые файлы на диске не остаются


def test_application_takes_a_limited_number_of_documents(client):
    headers = auth(client, "sklad@demo.local")
    app_id = _draft(client, headers)
    for n in range(MAX_DOCUMENTS):
        assert _upload(client, app_id, headers, f"doc-{n}.pdf", PDF).status_code == 201
    before = _stored_files()
    extra = _upload(client, app_id, headers, "lishniy.pdf", PDF)
    assert extra.status_code == 409
    assert extra.json()["detail"] == "К заявке можно приложить не больше 20 документов"
    assert _stored_files() == before
    assert len(client.get(f"/api/applications/{app_id}/documents", headers=headers).json()) == MAX_DOCUMENTS


def test_stored_file_is_removed_when_the_database_write_fails(client, monkeypatch):
    headers = auth(client, "bakery@demo.local")
    app_id = _draft(client, headers)
    before = _stored_files()

    def concurrent_change(_session):
        raise StaleDataError("заявку изменили параллельно")

    monkeypatch.setattr(Session, "commit", concurrent_change)
    response = _upload(client, app_id, headers, "vypiska.pdf", PDF)
    assert response.status_code == 409 and response.json()["code"] == "concurrent_update"
    assert _stored_files() == before
    assert client.get(f"/api/applications/{app_id}/documents", headers=headers).json() == []
