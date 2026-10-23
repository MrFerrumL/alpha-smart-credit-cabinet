/** Ежемесячный платёж — та же формула, что в backend/app/domain/products.py. */
export function monthlyPayment(amount: number, ratePct: number, months: number, repayment: string): number {
  const r = ratePct / 100 / 12;
  if (repayment === 'interest_only') return Math.round(amount * r);
  if (r === 0) return Math.round(amount / months);
  return Math.round((amount * r) / (1 - Math.pow(1 + r, -months)));
}

/** Порог банка: все платежи по кредитам — не больше половины выручки. */
export const MAX_DEBT_SHARE = 0.5;

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
