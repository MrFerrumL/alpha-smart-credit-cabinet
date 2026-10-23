"""Замер пояснения на настоящей модели: время ответа и доля ответов, прошедших проверку.

    docker compose exec worker python -m app.explanation.bench            # все решения, по одному вызову
    docker compose exec worker python -m app.explanation.bench --runs 2   # каждое решение дважды
    python -m app.explanation.bench --dry-run                             # только список решений, без модели

Решения строятся той же кредитной логикой, что и в конвейере (признаки → оценка → решение), на синтетических
данных источников — по всем веткам: одобрение, контрпредложение по тому же продукту, другой продукт, овердрафт,
отказы по грейду, из-за убытка и из-за выручки. База и эмулятор не нужны. Модель и адрес — из настроек
(LLM_BASE_URL, LLM_MODEL, LLM_API_KEY), как у воркера; промпт, проверка и таймаут — те же.

Приёмка: не меньше 80 % ответов проходят проверку, 95-й процентиль времени меньше таймаута вызова.
"""

from __future__ import annotations

import argparse
import math
import os
import platform
import time
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

from app.config import get_settings
from app.domain.products import PRODUCTS, Purpose
from app.explanation.facts import Facts, eligible, lead, offer_facts
from app.explanation.prompt import MAX_TOKENS, PROMPT_VERSION, SYSTEM, TEMPERATURE, WARMUP_USER, user_message
from app.explanation.validate import Invalid, check, compose
from app.scoring import rules
from app.scoring.decision import decide
from app.scoring.features import build_features
from app.services.llm import LLM_TIMEOUT_S, ChatClient, LLMError

ACCEPT_PASS_SHARE = 0.8


@dataclass(frozen=True)
class Case:
    label: str
    branch: str  # approved | counter_same | counter_other | overdraft | reject_grade | reject_loss | reject_revenue
    product: str
    amount: int
    term: int
    revenue_year: int
    expenses_year: int
    purpose: Purpose | None = None
    age_years: float = 6.0
    payments: int = 0  # платежи по действующим кредитам в месяц, по БКИ
    history: bool = True
    max_overdue: int = 0
    inquiries: int = 1
    tax_debt: int = 0
    mass_address: bool = False


CASES: tuple[Case, ...] = (
    Case("пекарня, 3 млн на год", "approved", "express", 3_000_000, 12, 60_000_000, 48_000_000),
    Case("мастерская, 1 млн на 2 года", "approved", "express", 1_000_000, 24, 24_000_000, 20_000_000, age_years=4),
    Case("молодая компания без истории", "approved", "express", 500_000, 6, 18_000_000, 15_000_000,
         age_years=2, history=False),
    Case("овердрафт для магазина", "overdraft", "overdraft", 500_000, 12, 36_000_000, 30_000_000,
         purpose=Purpose.CASH_GAP),
    Case("сумма больше лимита по выручке", "counter_same", "express", 10_000_000, 12, 24_000_000, 19_000_000),
    Case("слишком короткий срок", "counter_same", "express", 3_000_000, 3, 30_000_000, 24_000_000),
    Case("нагрузка от действующих кредитов", "counter_same", "express", 3_000_000, 12, 36_000_000, 28_000_000,
         payments=1_300_000),
    Case("просрочки в прошлом, ставка выше", "counter_same", "express", 5_000_000, 12, 30_000_000, 25_000_000,
         max_overdue=20, inquiries=4),
    Case("овердрафт больше лимита", "overdraft", "overdraft", 5_000_000, 12, 24_000_000, 20_000_000,
         purpose=Purpose.CASH_GAP),
    Case("химчистка: вместо экспресс-кредита овердрафт", "counter_other", "express", 300_000, 12, 12_000_000,
         9_600_000, purpose=Purpose.WORKING_CAPITAL, payments=485_000),
    Case("кассовый разрыв: вместо кредита овердрафт", "counter_other", "express", 400_000, 6, 9_600_000,
         7_000_000, purpose=Purpose.CASH_GAP, payments=388_000),
    Case("много негатива, грейд E", "reject_grade", "express", 2_000_000, 12, 24_000_000, 26_000_000,
         age_years=0.5, max_overdue=90, inquiries=7, tax_debt=150_000),
    Case("массовый адрес и долги, грейд E", "reject_grade", "express", 1_000_000, 12, 12_000_000, 11_000_000,
         age_years=0.8, max_overdue=75, inquiries=8, tax_debt=90_000, mass_address=True),
    Case("убыток по налоговой", "reject_loss", "express", 1_000_000, 12, 24_000_000, 25_000_000),
    Case("убыток, овердрафт", "reject_loss", "overdraft", 300_000, 12, 18_000_000, 19_000_000,
         purpose=Purpose.CASH_GAP),
    Case("маленькая выручка", "reject_revenue", "express", 300_000, 12, 1_200_000, 900_000),
    Case("выручка уходит на платежи", "reject_revenue", "express", 500_000, 12, 6_000_000, 4_500_000,
         payments=320_000),
)


def facts_for(case: Case, today: date | None = None) -> Facts | None:
    """Решение по синтетическим данным источников — той же логикой, что в конвейере; None — не подходит для пояснения."""
    today = today or date.today()
    product = PRODUCTS[case.product]
    egrul = {"registered_at": (today - timedelta(days=round(case.age_years * 365.25))).isoformat(),
             "status": {"code": "active"}}
    fns = {"revenue": case.revenue_year, "expenses": case.expenses_year, "tax_debt": case.tax_debt,
           "mass_address": case.mass_address}
    bki = {"loans": [{"kind": "loan"}] if case.history else [],
           "summary": {"monthly_payments": case.payments, "max_overdue_days_24m": case.max_overdue,
                       "inquiries_90d": case.inquiries}}
    features = build_features(egrul=egrul, fns=fns, bki=bki, declared_revenue=None, has_statement=False,
                              product=product, amount=case.amount, term_months=case.term, today=today)
    d = decide(features, rules.score(features), product, case.amount, case.term, case.purpose)
    snapshot = {"outcome": d.outcome.value, "stop_factors": d.stop_factors}
    if not eligible(snapshot):
        return None
    offer = d.offer and offer_facts(d.offer.product_code, d.offer.amount, d.offer.term_months, d.offer.rate,
                                    d.offer.monthly_payment)
    return Facts(d.outcome.value, product.name, case.amount, case.term, offer or None,
                 tuple(d.reasons[:6]), tuple(d.tips[:4]))


@dataclass
class Result:
    case: Case
    latency_ms: int | None = None
    error: str | None = None  # код сбоя вызова или invalid:<правило>
    text: str = ""
    raw: str = ""
    extra: dict = field(default_factory=dict)


def _percentile(values: list[int], share: float) -> int:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, math.ceil(share * len(ordered)) - 1))]


def _host() -> list[str]:
    """Процессор и ограничения контейнера — чтобы цифры можно было сравнить с другим ПК."""
    lines = [f"Модель: {get_settings().llm_model}, промпт {PROMPT_VERSION}, таймаут {LLM_TIMEOUT_S:.0f} с"]
    cpu = next((ln.split(":", 1)[1].strip() for ln in _read("/proc/cpuinfo").splitlines()
                if ln.startswith("model name")), platform.processor() or "?")
    available = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else os.cpu_count()
    lines.append(f"Процессор: {cpu}; видно ядер: {available}")
    quota = _read("/sys/fs/cgroup/cpu.max").split()
    if len(quota) == 2 and quota[0] != "max":
        lines.append(f"Ограничение контейнера по CPU: {int(quota[0]) / int(quota[1]):g}")
    mem = next((ln.split()[1] for ln in _read("/proc/meminfo").splitlines() if ln.startswith("MemTotal")), None)
    if mem:
        lines.append(f"Память: {int(mem) / 1024 / 1024:.1f} ГБ")
    return lines


def _read(path: str) -> str:
    try:
        return Path(path).read_text(encoding="utf-8")
    except OSError:
        return ""


def run(runs: int, dry_run: bool) -> int:
    cases = [(c, facts_for(c)) for c in CASES]
    for c, f in cases:
        outcome = f.outcome if f else "не подходит"
        print(f"- [{c.branch}] {c.label}: {outcome}" + (f" — {lead(f)}" if f else ""))
    usable = [(c, f) for c, f in cases if f is not None]
    if dry_run:
        return 0

    settings = get_settings()
    client = ChatClient(settings.llm_base_url, settings.llm_model, settings.llm_api_key.get_secret_value())
    print("\n" + "\n".join(_host()))
    started = time.monotonic()
    try:
        client.complete(SYSTEM, WARMUP_USER, max_tokens=1, temperature=0)
        print(f"Прогрев: {time.monotonic() - started:.1f} с")
    except LLMError as exc:
        print(f"Прогрев не удался: {exc.code}")

    results: list[Result] = []
    for _ in range(runs):
        for c, f in usable:
            r = Result(c)
            try:
                completion = client.complete(SYSTEM, user_message(f), max_tokens=MAX_TOKENS, temperature=TEMPERATURE)
                r.latency_ms, r.raw = completion.latency_ms, completion.text
                r.text = compose(f, check(completion.text, completion.finish_reason, f))
            except LLMError as exc:
                r.error = exc.code
            except Invalid as exc:
                r.error = f"invalid:{exc.rule}"
            results.append(r)
            mark = "ok" if r.error is None else r.error
            took = f"{r.latency_ms / 1000:.1f} с" if r.latency_ms is not None else "—"
            print(f"\n[{c.branch}] {c.label} — {mark}, {took}\n  {r.text or r.raw}")

    latencies = [r.latency_ms for r in results if r.latency_ms is not None]
    passed = sum(r.error is None for r in results)
    share = passed / len(results) if results else 0
    print(f"\nИтого: {passed} из {len(results)} прошли проверку ({share:.0%})")
    if latencies:
        print(f"Время ответа: p50 {_percentile(latencies, 0.5) / 1000:.1f} с, p95 {_percentile(latencies, 0.95) / 1000:.1f} с,"
              f" максимум {max(latencies) / 1000:.1f} с")
    for branch in dict.fromkeys(c.branch for c, _ in usable):
        mine = [r for r in results if r.case.branch == branch]
        print(f"  {branch}: {sum(r.error is None for r in mine)} из {len(mine)}")
    failed = [r.error for r in results if r.error]
    if failed:
        print("Причины отказов: " + ", ".join(f"{e} ×{failed.count(e)}" for e in dict.fromkeys(failed)))
    ok = share >= ACCEPT_PASS_SHARE and bool(latencies) and _percentile(latencies, 0.95) < LLM_TIMEOUT_S * 1000
    print("Приёмка: " + ("пройдена" if ok else "не пройдена"))
    return 0 if ok else 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--runs", type=int, default=1, help="сколько раз вызвать модель на каждом решении")
    parser.add_argument("--dry-run", action="store_true", help="только показать решения, модель не вызывать")
    args = parser.parse_args()
    raise SystemExit(run(max(1, args.runs), args.dry_run))


if __name__ == "__main__":
    main()
