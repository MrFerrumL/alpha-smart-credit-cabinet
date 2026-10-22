"""Хранение документов клиентов на диске (в Docker — отдельный том).

В промышленной версии это объектное хранилище (S3-совместимое) с антивирусной проверкой;
интерфейс save/open останется тем же.
"""

import uuid
from pathlib import Path

from fastapi import UploadFile

from app.config import get_settings
from app.errors import BusinessValidationError

ALLOWED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".xlsx", ".xls", ".csv", ".doc", ".docx", ".txt"}
_CHUNK = 1024 * 1024


def _root() -> Path:
    root = Path(get_settings().upload_dir)
    root.mkdir(parents=True, exist_ok=True)
    return root


def save(upload: UploadFile, company_id: int) -> tuple[str, int]:
    """Сохраняет файл, возвращает (ключ хранения, размер в байтах)."""
    name = upload.filename or "document"
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise BusinessValidationError(
            errors=[{"field": "file", "message": "Поддерживаются PDF, изображения, Excel, Word, CSV и TXT"}]
        )
    limit = get_settings().max_upload_mb * 1024 * 1024
    key = f"company_{company_id}/{uuid.uuid4().hex}{ext}"
    path = _root() / key
    path.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    with path.open("wb") as out:
        while chunk := upload.file.read(_CHUNK):
            size += len(chunk)
            if size > limit:
                out.close()
                path.unlink(missing_ok=True)
                raise BusinessValidationError(
                    errors=[{"field": "file", "message": f"Файл больше {get_settings().max_upload_mb} МБ"}]
                )
            out.write(chunk)
    if size == 0:
        path.unlink(missing_ok=True)
        raise BusinessValidationError(errors=[{"field": "file", "message": "Файл пустой"}])
    return key, size
