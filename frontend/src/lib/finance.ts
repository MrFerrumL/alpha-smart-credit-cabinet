/** Ежемесячный платёж — та же формула, что в backend/app/domain/products.py. */
export function monthlyPayment(amount: number, ratePct: number, months: number, repayment: string): number {
  const r = ratePct / 100 / 12;
  if (repayment === 'interest_only') return Math.round(amount * r);
  if (r === 0) return Math.round(amount / months);
  return Math.round((amount * r) / (1 - Math.pow(1 + r, -months)));
}

// Пороги правил решения — копия значений из backend/app/scoring/decision.py и backend/app/domain/products.py
// (/api/products их не отдаёт). Что они значат — docs/scoring.md, раздел «Правила решения (policy-1.1)». Поменяли
// там — поменяйте и здесь: анкета показывает клиенту те же проверки, что сделает банк.

/** Порог банка: все платежи по кредитам — не больше половины выручки (MAX_DSR). */
export const MAX_DEBT_SHARE = 0.5;

/** Прибыль (выручка − расходы) покрывает платёж по новому кредиту не меньше чем в 1,2 раза (MIN_DSCR). */
export const MIN_COVERAGE = 1.2;

/** Лимит по выручке: сколько месячных выручек даёт продукт (revenue_multiplier в каталоге продуктов). */
export const REVENUE_MULTIPLIER: Record<string, number> = { express: 1.5, invest: 6, overdraft: 0.5 };

/** Шаг, до которого банк округляет лимит вниз (STEP в правилах решения). */
export const LIMIT_STEP = 50_000;

/**
 * Платёж, по которому банк проверяет посильность. У овердрафта в месяц платятся только проценты, но проверки
 * считаются по аннуитету на тот же срок — как будто лимит гасится равными долями (service_payment в правилах).
 */
export function servicePayment(amount: number, ratePct: number, months: number): number {
  return monthlyPayment(amount, ratePct, months, 'annuity');
}

/**
 * Лимит по выручке при лучшей оценке: выручка × множитель продукта, вниз до 50 тыс., не больше максимума продукта.
 * При оценке ниже банк берёт от него долю (грейд B — 80 %, C — 60 %), поэтому это верхняя граница.
 */
export function revenueLimit(revenue: number, productCode: string, maxAmount: number): number | null {
  const multiplier = REVENUE_MULTIPLIER[productCode];
  if (!multiplier || !(revenue > 0)) return null;
  return Math.min(Math.floor((revenue * multiplier) / LIMIT_STEP) * LIMIT_STEP, maxAmount);
}

export interface ScheduleRowCalc {
  n: number;
  payment: number;
  principal: number;
  interest: number;
  balance: number;
}

const rub = (v: number) => Math.round(v + Number.EPSILON);

/**
 * График по условиям предложения — тот же расчёт, что `schedule` в backend/app/domain/products.py: проценты от
 * остатка, в последний месяц — весь остаток. Платёж берём из предложения банка, чтобы суммы совпали с договором.
 */
export function schedule(amount: number, ratePct: number, months: number, repayment: string, payment: number): ScheduleRowCalc[] {
  const r = ratePct / 100 / 12;
  let balance = amount;
  const rows: ScheduleRowCalc[] = [];
  for (let n = 1; n <= months; n++) {
    const interest = rub(balance * r);
    const principal = repayment === 'interest_only' ? (n === months ? balance : 0) : n === months ? balance : payment - interest;
    balance -= principal;
    rows.push({ n, payment: rub(principal + interest), principal: rub(principal), interest, balance: rub(balance) });
  }
  return rows;
}
