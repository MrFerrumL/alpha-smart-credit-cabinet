"""Отчёт о ресурсах стенда после прогона сценариев: пик памяти контейнеров, размеры образов, диск.

Только стандартная библиотека Python 3.10+. Нужен docker compose в текущей папке (корень репозитория):

    python3 scripts/resource_report.py --samples resources/stats.log --out resources/resources.md

Файл замеров ведёт фоновый цикл, который раз в 2 секунды пишет метку `# <секунды>` и вывод
`docker stats --no-stream --format '{{.Name}} {{.MemUsage}}'`. Пик памяти контейнера берётся из cgroup v2
(`/sys/fs/cgroup/memory.peak` внутри контейнера — максимум за всё время его работы, вместе со страничным
кэшем файлов); если файла нет, остаётся максимум по замерам. Недостающий замер не приводит к ошибке:
в таблице будет «нет данных», код возврата всегда 0.
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

NO_DATA = "нет данных"
SAMPLE = re.compile(r"^(?P<name>\S+)\s+(?P<value>[\d.]+)\s*(?P<unit>[A-Za-z]*)\s*/")
# docker stats показывает двоичные единицы (MiB), но на всякий случай понимаем и десятичные.
UNITS_IN_MIB = {
    "b": 1 / 1024**2,
    "kib": 1 / 1024,
    "mib": 1,
    "gib": 1024,
    "tib": 1024**2,
    "kb": 1000 / 1024**2,
    "mb": 1000**2 / 1024**2,
    "gb": 1000**3 / 1024**2,
}


def to_mib(value: str, unit: str) -> float | None:
    factor = UNITS_IN_MIB.get(unit.lower() or "b")
    if factor is None:
        return None
    try:
        return float(value) * factor
    except ValueError:
        return None


def parse_samples(text: str) -> list[dict[str, float]]:
    """Замеры по кругам: каждый круг — {контейнер: МиБ} на один момент времени."""
    rounds: list[dict[str, float]] = []
    for line in text.splitlines():
        if line.startswith("#"):
            rounds.append({})
            continue
        match = SAMPLE.match(line.strip())
        if not match:
            continue
        used = to_mib(match["value"], match["unit"])
        if used is None:
            continue
        if not rounds:
            rounds.append({})
        rounds[-1][match["name"]] = used
    return [r for r in rounds if r]


def run(command: list[str], timeout: float = 60) -> str | None:
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout if done.returncode == 0 else None


def compose_containers() -> list[str]:
    out = run(["docker", "compose", "ps", "-a", "--format", "{{.Name}}"])
    return sorted({line.strip() for line in (out or "").splitlines() if line.strip()})


def cgroup_peak_mib(container: str) -> float | None:
    out = run(["docker", "exec", container, "cat", "/sys/fs/cgroup/memory.peak"], timeout=20)
    try:
        return int((out or "").strip()) / 1024**2
    except ValueError:
        return None


def number(value: float | None) -> str:
    return NO_DATA if value is None else f"{value:.1f}".replace(".", ",")


def block(title: str, command: list[str]) -> list[str]:
    out = run(command)
    body = out.rstrip() if out and out.strip() else NO_DATA
    return [f"### {title}", "", "```", body, "```", ""]


def build_report(samples_text: str, containers: list[str], peaks: dict[str, float | None]) -> str:
    rounds = parse_samples(samples_text)
    sampled = {name for r in rounds for name in r}
    names = containers or sorted(sampled)
    if containers:
        rounds = [{n: v for n, v in r.items() if n in containers} for r in rounds]
        rounds = [r for r in rounds if r]
    sampler_max = {n: max((r[n] for r in rounds if n in r), default=None) for n in names}

    lines = [
        "## Ресурсы стенда после полного прогона сценариев",
        "",
        "### Память контейнеров",
        "",
        "| Контейнер | Пик, МиБ | Максимум по docker stats, МиБ |",
        "|---|---:|---:|",
    ]
    peak_values: list[float] = []
    fallback_used = False
    for name in names:
        peak = peaks.get(name)
        mark = ""
        if peak is None and sampler_max[name] is not None:
            peak, mark, fallback_used = sampler_max[name], " *", True
        if peak is not None:
            peak_values.append(peak)
        lines.append(f"| {name} | {number(peak)}{mark} | {number(sampler_max[name])} |")
    sampler_total = [v for v in sampler_max.values() if v is not None]
    lines.append(
        f"| **Сумма** | **{number(sum(peak_values) if peak_values else None)}** "
        f"| **{number(sum(sampler_total) if sampler_total else None)}** |"
    )
    lines.append("")
    if rounds:
        together = max(sum(r.values()) for r in rounds)
        lines.append(f"Наибольшая сумма по контейнерам в один момент замера: {number(together)} МиБ (замеров: {len(rounds)}).")
    else:
        lines.append(f"Замеры docker stats: {NO_DATA}.")
    if fallback_used:
        lines += ["", "\\* `memory.peak` в контейнере недоступен, взят максимум по замерам docker stats."]
    lines += [
        "",
        "«Пик» — `memory.peak` контейнера (cgroup v2) за всё время его работы, вместе со страничным кэшем файлов, "
        "поэтому это оценка сверху. «Максимум по docker stats» — рабочий набор без неактивного кэша на момент "
        "замера (раз в 2 секунды), кратковременный всплеск между замерами он может не поймать. Сумма пиков "
        "не обязана совпадать с одновременной нагрузкой: пики контейнеров приходятся на разное время.",
        "",
    ]
    lines += block("Хост раннера", ["bash", "-c", "nproc; free -m"])
    lines += block("Образы (docker compose images)", ["docker", "compose", "images"])
    lines += block("Диск Docker (docker system df)", ["docker", "system", "df"])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=Path, required=True, help="файл замеров docker stats")
    parser.add_argument("--out", type=Path, required=True, help="куда записать отчёт (Markdown)")
    args = parser.parse_args()

    try:
        samples_text = args.samples.read_text(encoding="utf-8", errors="replace")
    except OSError:
        samples_text = ""
    containers = compose_containers()
    names = containers or sorted({n for r in parse_samples(samples_text) for n in r})
    peaks = {name: cgroup_peak_mib(name) for name in names}
    report = build_report(samples_text, containers, peaks)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(report + "\n", encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    print(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
