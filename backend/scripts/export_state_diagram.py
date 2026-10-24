"""Диаграмма состояний в docs/state-machine.md собирается из таблицы переходов в коде.

    python -m scripts.export_state_diagram          # обновить диаграмму в документе
    python -m scripts.export_state_diagram --check  # проверить, что документ совпадает с кодом (для CI)
"""

import re
import sys
from pathlib import Path

from app.domain.statuses import to_mermaid

TARGET = Path(__file__).resolve().parents[2] / "docs" / "state-machine.md"
BLOCK = re.compile(r"```mermaid\n.*?\n```", re.S)


def main() -> int:
    text = TARGET.read_text(encoding="utf-8")
    rendered = BLOCK.sub(lambda _: f"```mermaid\n{to_mermaid()}\n```", text, count=1)
    if "--check" in sys.argv:
        if rendered != text:
            print(f"{TARGET} устарел: выполните python -m scripts.export_state_diagram", file=sys.stderr)
            return 1
        print("docs/state-machine.md совпадает с кодом")
        return 0
    TARGET.write_text(rendered, encoding="utf-8", newline="\n")
    print(f"Записано: {TARGET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
