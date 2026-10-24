"""Выгрузка спецификации API в docs/openapi.json.

    python -m scripts.export_openapi          # перезаписать файл
    python -m scripts.export_openapi --check  # проверить, что файл совпадает с кодом (для CI)
"""

import json
import sys
from pathlib import Path

from app.main import app

TARGET = Path(__file__).resolve().parents[2] / "docs" / "openapi.json"


def render() -> str:
    return json.dumps(app.openapi(), ensure_ascii=False, indent=2) + "\n"


def main() -> int:
    spec = render()
    if "--check" in sys.argv:
        if TARGET.read_text(encoding="utf-8") != spec:
            print(f"{TARGET} устарел: выполните python -m scripts.export_openapi", file=sys.stderr)
            return 1
        print("docs/openapi.json совпадает с кодом")
        return 0
    TARGET.write_text(spec, encoding="utf-8", newline="\n")
    print(f"Записано: {TARGET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
