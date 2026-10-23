"""
Эталонная (референсная) реализация кредитной политики MVP «Умный кредитный кабинет».

Назначение:
  * зафиксировать правила скоринга и решения в исполняемом виде — разработчики сверяют
    с ним свой сервис, продукт — тексты и тест-сценарии;
  * прогнать демо-компании и проверить, что каждая даёт ожидаемый исход.

Все числа (веса, пороги, ставки) — иллюстративные и задаются в POLICY.
Запуск:  python3 scoring_reference.py demo_companies.json
"""
from __future__ import annotations

import json
import statistics
import sys
from dataclasses import dataclass, field
from datetime import date

POLICY_VERSION = "2026-10-21.1"
TODAY = date(2026, 10, 21)
KEY_RATE = 14.0  # ключевая ставка Банка России, % годовых

# ---------------------------------------------------------------- продукты
PRODUCTS = {
    "EXPRESS": {
        "name": "Экспресс-кредит на любые цели",
        "min_amount": 300_000, "max_amount": 10_000_000,
        "min_term": 6, "max_term": 36,
        "min_age_months": 6, "auto_limit": 5_000_000,
        "spread": 6.0, "revenue_cap_share": 0.5,   # не больше 50% годовой выручки
        "collateral": False, "kind": "annuity",
    },
    "INVEST": {
        "name": "Кредит на развитие",
        "min_amount": 1_000_000, "max_amount": 50_000_000,
        "min_term": 12, "max_term": 60,
        "min_age_months": 12, "auto_limit": 5_000_000,
        "spread": 3.5, "revenue_cap_share": 1.0,
        "collateral": True, "kind": "annuity",
    },
    "OVERDRAFT": {
        "name": "Овердрафт",
        "min_amount": 100_000, "max_amount": 5_000_000,
        "min_term": 12, "max_term": 12,
        "min_age_months": 6, "auto_limit": 3_000_000,
        "spread": 7.0, "monthly_turnover_cap_share": 0.4,  # лимит ≤ 40% среднемесячных поступлений
        "collateral": False, "kind": "interest_only",
    },
}

GRADE_PREMIUM = {"A": 0.0, "B": 1.5, "C": 3.0, "D": 5.0}
DSR_CAP = {"A": 0.25, "B": 0.22, "C": 0.18, "D": 0.15}
PRIORITY_OKVED_PREFIXES = ("10", "11", "13", "14", "15", "16", "17", "20", "22", "25", "26", "27", "28", "29",
                           "31", "32", "33", "49", "52", "55", "62", "63", "72")  # обработка, логистика, туризм, ИТ, наука
GRADES = [(680, "A"), (620, "B"), (560, "C"), (500, "D"), (-10**9, "E")]


@dataclass
class Factor:
    code: str
    points: int
    text: str  # технический комментарий для досье андеррайтера


@dataclass
class Result:
    company: str
    outcome: str                   # APPROVED | COUNTER_OFFER | MANUAL_REVIEW | INFO_REQUESTED | DECLINED
    score: int | None = None
    grade: str | None = None
    factors: list[Factor] = field(default_factory=list)
    stops: list[str] = field(default_factory=list)
    manual_reasons: list[str] = field(default_factory=list)
    info_requests: list[str] = field(default_factory=list)
    offer: dict | None = None
    metrics: dict = field(default_factory=dict)


# ---------------------------------------------------------------- расчёты
def months_between(d1: date, d2: date) -> int:
    return (d2.year - d1.year) * 12 + (d2.month - d1.month) - (1 if d2.day < d1.day else 0)


def annuity(amount: float, rate_pct: float, n: int) -> float:
    r = rate_pct / 100 / 12
    return amount * r / (1 - (1 + r) ** -n)


def max_amount_for_payment(payment: float, rate_pct: float, n: int) -> float:
    r = rate_pct / 100 / 12
    return payment * (1 - (1 + r) ** -n) / r


def monthly_payment(product: dict, amount: float, rate: float, term: int) -> float:
    if product["kind"] == "interest_only":   # овердрафт: проценты при полном использовании лимита
        return amount * rate / 100 / 12
    return annuity(amount, rate, term)


def grade_of(score: int) -> str:
    for threshold, g in GRADES:
        if score >= threshold:
            return g
    return "E"


def is_priority(okved: str) -> bool:
    return okved.split(".")[0] in PRIORITY_OKVED_PREFIXES


def round_down(x: float, step: int = 10_000) -> int:
    return int(x // step * step)


# ---------------------------------------------------------------- политика
def evaluate(c: dict, after_info: bool = False) -> Result:
    app = c["application"]
    product_code = app["product"]
    product = PRODUCTS[product_code]
    res = Result(company=c["name"], outcome="")

    revenue = list(c["turnover_monthly"])
    if after_info and c.get("additional_turnover_after_info"):
        revenue = c["additional_turnover_after_info"] + revenue
    revenue = revenue[-12:]
    age = months_between(date.fromisoformat(c["registry"]["registration_date"]), TODAY)
    bki = c["bki"]
    pb = c["fns_transparent_business"]

    # 0. источники данных
    if c.get("simulate", {}).get("bki_timeout"):
        res.manual_reasons.append("M3_SOURCE_UNAVAILABLE: БКИ не ответило за 10 с")

    # 1. стоп-факторы
    if c["registry"]["status"] != "ACTIVE" or c.get("fedresurs", {}).get("bankruptcy"):
        res.stops.append("S01_LIQUIDATION_OR_BANKRUPTCY")
    if pb.get("director_disqualified"):
        res.stops.append("S02_DIRECTOR_DISQUALIFIED")
    if c.get("aml_stop_list"):
        res.stops.append("S03_INTERNAL_RULES")
    if not c.get("simulate", {}).get("bki_timeout"):
        if bki["current_overdue_days"] > 30 or bki["max_overdue_days_24m"] > 90:
            res.stops.append("S04_SERIOUS_OVERDUE")
    avg_rev = statistics.mean(revenue) if revenue else 0
    if pb.get("tax_debt", 0) > 0.5 * avg_rev:
        res.stops.append("S06_TAX_DEBT")

    # 1a. возраст бизнеса меньше требований продукта — ищем другой продукт
    if age < product["min_age_months"]:
        res.stops.append("S05_BUSINESS_AGE_FOR_PRODUCT")

    res.metrics.update(age_months=age, avg_monthly_revenue=round(avg_rev), months_of_data=len(revenue))

    hard = [s for s in res.stops if s != "S05_BUSINESS_AGE_FOR_PRODUCT"]
    if hard:
        res.outcome = "DECLINED"
        return res

    # 2. достаточность данных
    if len(revenue) < 6:
        res.info_requests.append("I01_TURNOVER: нужна выписка из другого банка за 12 месяцев "
                                 "или подключение счёта через Open API")
        res.outcome = "INFO_REQUESTED"
        return res

    # 3. скоринг
    f: list[Factor] = []
    f.append(Factor("AGE", -40 if age < 12 else 0 if age < 36 else 20 if age < 60 else 40,
                    f"возраст бизнеса {age} мес"))
    cv = statistics.pstdev(revenue) / avg_rev
    f.append(Factor("STABILITY", 30 if cv < 0.2 else 10 if cv < 0.4 else -20 if cv < 0.6 else -50,
                    f"вариация выручки {cv:.2f}"))
    if len(revenue) >= 12:
        trend = sum(revenue[-6:]) / sum(revenue[:6]) - 1
    else:
        trend = 0.0
    f.append(Factor("TREND", 20 if trend >= 0.10 else 0 if trend >= -0.10 else -25 if trend >= -0.25 else -60,
                    f"динамика выручки {trend:+.0%}"))
    if bki["max_overdue_days_24m"] == 0 and bki["closed_loans"] > 0:
        pts, txt = 40, "кредиты погашались без просрочек"
    elif bki["max_overdue_days_24m"] == 0:
        pts, txt = 0, "нет кредитной истории"
    elif bki["max_overdue_days_24m"] <= 30:
        pts, txt = -30, f"просрочка до {bki['max_overdue_days_24m']} дн. за 24 мес"
    else:
        pts, txt = -80, f"просрочка {bki['max_overdue_days_24m']} дн. за 24 мес"
    if c.get("simulate", {}).get("bki_timeout"):
        pts, txt = 0, "нет данных БКИ (таймаут)"
    f.append(Factor("CREDIT_HISTORY", pts, txt))
    f.append(Factor("TAX", 10 if pb.get("tax_debt", 0) == 0 else -30, f"недоимка {pb.get('tax_debt', 0):,} ₽"))
    f.append(Factor("INDUSTRY", {"low": 10, "medium": 0, "high": -25}[c["industry_risk"]],
                    f"отраслевой риск {c['industry_risk']}"))
    court_share = c.get("arbitration_defendant_sum", 0) / (avg_rev * 12)
    f.append(Factor("COURT", 0 if court_share == 0 else -15 if court_share <= 0.05 else -50,
                    f"иски к компании {court_share:.1%} годовой выручки"))
    f.append(Factor("FSSP", -40 if c.get("fssp_active_sum", 0) > 0 else 0, "исполнительные производства"))
    f.append(Factor("MASS", -40 if (pb.get("mass_address") or pb.get("mass_director")) else 0,
                    "массовый адрес/руководитель"))
    declared = app["declared_annual_revenue"]
    observed = avg_rev * 12
    mismatch = abs(declared - observed) / observed
    if mismatch > 0.30:
        f.append(Factor("MISMATCH", -30, f"анкета расходится с данными на {mismatch:.0%}"))
        res.manual_reasons.append(f"M2_DATA_MISMATCH: расхождение {mismatch:.0%}")
    else:
        f.append(Factor("MISMATCH", 0, f"расхождение {mismatch:.0%}"))
    if product["collateral"] and app.get("collateral"):
        f.append(Factor("COLLATERAL", 25, "залог приобретаемого имущества"))

    score = 600 + sum(x.points for x in f)
    grade = grade_of(score)
    res.score, res.grade, res.factors = score, grade, f

    # 4. если продукт не подходит по возрасту — подбираем альтернативу
    target_code = product_code
    if "S05_BUSINESS_AGE_FOR_PRODUCT" in res.stops:
        alts = [k for k, p in PRODUCTS.items() if k != product_code and age >= p["min_age_months"]
                and p["kind"] == "annuity"]
        if not alts or grade == "E":
            res.outcome = "DECLINED"
            return res
        target_code = alts[0]
        res.stops.remove("S05_BUSINESS_AGE_FOR_PRODUCT")
        res.metrics["product_switched_from"] = product_code

    if grade == "E":
        res.outcome = "DECLINED"
        return res

    target = PRODUCTS[target_code]
    rate = KEY_RATE + target["spread"] + GRADE_PREMIUM[grade]
    preferential = (target_code == "INVEST" and is_priority(c["okved"]) and c["msp_category"] in ("micro", "small"))
    if preferential:
        rate = KEY_RATE  # программа «под ключевую ставку» — проверка права, итог по правилам программы
    term = min(max(app["term_months"], target["min_term"]), target["max_term"])
    amount = min(app["amount"], target["max_amount"])
    if target_code == "OVERDRAFT":
        amount = min(amount, target["monthly_turnover_cap_share"] * avg_rev)
    else:
        amount = min(amount, target["revenue_cap_share"] * avg_rev * 12)
    existing = bki["existing_monthly_payment"] if not c.get("simulate", {}).get("bki_timeout") else 0
    cap = DSR_CAP[grade]

    def dsr(a: float, n: int) -> float:
        return (existing + monthly_payment(target, a, rate, n)) / avg_rev

    # подбор условий: та же сумма на более длинный срок → меньшая сумма
    if dsr(amount, term) > cap:
        for n in range(term, target["max_term"] + 1, 6 if target["kind"] == "annuity" else 1):
            if dsr(amount, n) <= cap:
                term = n
                break
        else:
            pay_room = cap * avg_rev - existing
            if target["kind"] == "interest_only":
                amount = pay_room / (rate / 100 / 12)
            else:
                term = target["max_term"]
                amount = max_amount_for_payment(pay_room, rate, term) if pay_room > 0 else 0
    amount = round_down(amount)
    if amount < target["min_amount"]:
        res.outcome = "DECLINED"
        res.metrics["reason"] = "N_DSR: платёж не помещается в допустимую нагрузку"
        return res

    pay = monthly_payment(target, amount, rate, term)
    res.offer = {
        "product": target_code, "product_name": target["name"],
        "amount": amount, "term_months": term, "rate": round(rate, 2),
        "monthly_payment": round(pay), "dsr": round(dsr(amount, term), 3),
        "preferential_program": preferential, "policy_version": POLICY_VERSION,
    }
    changed = (amount < app["amount"] or term != app["term_months"] or target_code != product_code)

    if amount > target["auto_limit"]:
        res.manual_reasons.append(f"M1_ABOVE_AUTO_LIMIT: {amount:,} > {target['auto_limit']:,}")
    if grade == "D":
        res.manual_reasons.append("M4_GRADE_D: пограничный риск")

    if res.manual_reasons:
        res.outcome = "MANUAL_REVIEW"
    elif changed:
        res.outcome = "COUNTER_OFFER"
    else:
        res.outcome = "APPROVED"
    return res


def top_negative(res: Result, k: int = 3) -> list[str]:
    neg = sorted([x for x in res.factors if x.points < 0], key=lambda x: x.points)
    return [x.code for x in neg[:k]]


def main(path: str) -> int:
    data = json.load(open(path, encoding="utf-8"))
    failures = 0
    print(f"policy {POLICY_VERSION}, key rate {KEY_RATE}%\n")
    for c in data["companies"]:
        r = evaluate(c)
        exp = c["expected"]["first_decision"]
        ok = r.outcome == exp
        line = (f"{c['id']:<5} {c['name'][:34]:<34} {r.outcome:<14} "
                f"score={r.score!s:<4} grade={r.grade!s:<4} ")
        if r.offer:
            o = r.offer
            line += (f"{o['product']:<9} {o['amount']:>11,} ₽ {o['term_months']:>2} мес {o['rate']:>5}% "
                     f"плат {o['monthly_payment']:>9,} DSR {o['dsr']:.1%}")
        extra = r.stops + r.manual_reasons + r.info_requests
        if extra:
            line += "  | " + "; ".join(extra)
        if r.factors:
            line += "  | neg: " + ",".join(top_negative(r))
        print(("OK   " if ok else "FAIL ") + line)
        if not ok:
            failures += 1
            print(f"      ожидалось {exp}")
        if r.outcome == "INFO_REQUESTED" and c["expected"].get("after_info"):
            r2 = evaluate(c, after_info=True)
            ok2 = r2.outcome == c["expected"]["after_info"]
            o = r2.offer or {}
            print(("OK   " if ok2 else "FAIL ") + f"      после дозапроса: {r2.outcome} score={r2.score} "
                  f"grade={r2.grade} {o.get('product')} {o.get('amount', 0):,} ₽ {o.get('rate')}% "
                  f"DSR {o.get('dsr', 0):.1%} | " + "; ".join(r2.manual_reasons))
            failures += 0 if ok2 else 1
    print(f"\n{len(data['companies'])} компаний, расхождений с ожиданием: {failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "demo_companies.json"))
