/** Ежемесячный платёж — та же формула, что в backend/app/domain/products.py. */
export function monthlyPayment(amount: number, ratePct: number, months: number, repayment: string): number {
  const r = ratePct / 100 / 12;
  if (repayment === 'interest_only') return Math.round(amount * r);
  if (r === 0) return Math.round(amount / months);
  return Math.round((amount * r) / (1 - Math.pow(1 + r, -months)));
}

/** Порог банка: все платежи по кредитам — не больше половины выручки. */
export const MAX_DEBT_SHARE = 0.5;
