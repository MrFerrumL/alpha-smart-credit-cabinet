import { NBSP, monthLabel } from '../lib/format';

export interface BarRow {
  n: number;
  principal: number;
  interest: number;
  /** Дата платежа; если её нет (график по предложению), считаем от первого платежа помесячно. */
  date?: string;
}

function addMonths(iso: string, months: number): string {
  const d = new Date(iso);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d.toISOString();
}

/**
 * График платежей столбиками: основной долг и проценты по месяцам. Подписи — у первого месяца и у каждого января
 * с годом, между ними — каждый третий месяц. Обычные div, без библиотек графиков.
 */
export function PaymentBars({ rows, firstDate, current }: { rows: BarRow[]; firstDate?: string; current?: number }) {
  if (rows.length === 0) return null;
  const dated = rows.map((r, i) => ({ ...r, date: r.date ?? (firstDate ? addMonths(firstDate, i) : undefined) }));
  const max = Math.max(...dated.map((r) => r.principal + r.interest));
  const step = rows.length > 24 ? 6 : 3;
  // Подпись и её вес: с годом (первый месяц, январь) остаётся и на телефоне, промежуточные там скрыты.
  const label = (iso: string | undefined, i: number): [string, boolean] => {
    if (!iso) return [i === 0 || (i + 1) % step === 0 ? `${i + 1}` : '', i === 0];
    const month = new Date(iso).getMonth();
    if (i === 0 || month === 0) return [monthLabel(iso, true), true];
    return [i % step === 0 ? monthLabel(iso, false) : '', false];
  };
  return (
    <div className="potok-bars" aria-hidden="true">
      <div className="potok-bars-plot" style={{ gridTemplateColumns: `repeat(${rows.length}, 1fr)` }}>
        {dated.map((r, i) => (
          <div key={r.n} className="potok-bar" data-current={current === i}>
            <span className="potok-bar-i" style={{ height: `${(r.interest / max) * 100}%` }} />
            <span className="potok-bar-p" style={{ height: `${(r.principal / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="potok-bars-axis" style={{ gridTemplateColumns: `repeat(${rows.length}, 1fr)` }}>
        {dated.map((r, i) => {
          const [text, major] = label(r.date, i);
          return (
            <span key={r.n} data-major={major}>
              {text}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function BarsLegend() {
  return (
    <div className="potok-legend">
      <span>
        <i data-kind="p" />
        Основной{NBSP}долг
      </span>
      <span>
        <i data-kind="i" />
        Проценты
      </span>
    </div>
  );
}
