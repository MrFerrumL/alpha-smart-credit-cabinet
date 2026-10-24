"""Хранение документов клиентов на диске (в Docker — отдельный том).

В промышленной версии это объектное хранилище (S3-совместимое) с антивирусной проверкой;
интерфейс save/delete останется тем же.
"""

import codecs
import uuid
from pathlib import Path

from fastapi import UploadFile

from app.config import get_settings
from app.errors import BusinessValidationError

_OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"  # контейнер старых xls и doc
# С чего начинается файл каждого формата: под расширением .pdf не примем исполняемый файл или архив.
SIGNATURES = {
    ".pdf": b"%PDF-",
    ".png": b"\x89PNG\r\n\x1a\n",
    ".jpg": b"\xff\xd8\xff",
    ".jpeg": b"\xff\xd8\xff",
    ".xlsx": b"PK\x03\x04",  # xlsx и docx — ZIP-архивы
    ".docx": b"PK\x03\x04",
    ".xls": _OLE,
    ".doc": _OLE,
}
TEXT_EXTENSIONS = {".csv", ".txt"}  # сигнатуры нет: проверяется, что это текст в UTF-8
ALLOWED_EXTENSIONS = set(SIGNATURES) | TEXT_EXTENSIONS
_CHUNK = 1024 * 1024


def _root() -> Path:
    root = Path(get_settings().upload_dir)
    root.mkdir(parents=True, exist_ok=True)
    return root


def _invalid(message: str) -> BusinessValidationError:
    return BusinessValidationError(errors=[{"field": "file", "message": message}])


def _is_text(decoder: codecs.IncrementalDecoder, chunk: bytes, final: bool = False) -> bool:
    """Кусок продолжает текст в UTF-8. Нулевых байтов в тексте не бывает — это двоичный файл."""
    try:
        decoder.decode(chunk, final=final)
    except UnicodeDecodeError:
        return False
    return b"\x00" not in chunk


def save(upload: UploadFile, company_id: int) -> tuple[str, int]:
    """Сохраняет файл, возвращает (ключ хранения, размер в байтах)."""
    name = upload.filename or "document"
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise _invalid("Поддерживаются PDF, изображения, Excel, Word, CSV и TXT")
    limit = get_settings().max_upload_mb * 1024 * 1024
    key = f"company_{company_id}/{uuid.uuid4().hex}{ext}"
    path = _root() / key
    path.parent.mkdir(parents=True, exist_ok=True)
    decoder = codecs.getincrementaldecoder("utf-8")() if ext in TEXT_EXTENSIONS else None
    not_text = f"Файл {ext[1:].upper()} должен быть текстом в кодировке UTF-8"
    size = 0
    try:
        with path.open("wb") as out:
            while chunk := upload.file.read(_CHUNK):
                if size == 0 and not chunk.startswith(SIGNATURES.get(ext, b"")):
                    raise _invalid(f"Файл не похож на {ext[1:].upper()}: содержимое не совпадает с расширением")
                if decoder is not None and not _is_text(decoder, chunk):
                    raise _invalid(not_text)
                size += len(chunk)
                if size > limit:
                    raise _invalid(f"Файл больше {get_settings().max_upload_mb} МБ")
                out.write(chunk)
        if size == 0:
            raise _invalid("Файл пустой")
        if decoder is not None and not _is_text(decoder, b"", final=True):  # текст оборван посреди символа
            raise _invalid(not_text)
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return key, size


def delete(key: str) -> None:
    """Удаляет сохранённый файл — например, если запись о документе в БД так и не появилась."""
    (_root() / key).unlink(missing_ok=True)
