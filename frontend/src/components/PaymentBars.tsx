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
 * График платежей столбиками: основной долг и проценты по месяцам. Подписи — с постоянным шагом (каждый третий
 * месяц, у длинных сроков — каждый шестой); год — у первой подписи и у первой подписи нового года (январь, если
 * он попал на шаг). Обычные div, без библиотек графиков.
 */
export function PaymentBars({ rows, firstDate, current }: { rows: BarRow[]; firstDate?: string; current?: number }) {
  if (rows.length === 0) return null;
  const dated = rows.map((r, i) => ({ ...r, date: r.date ?? (firstDate ? addMonths(firstDate, i) : undefined) }));
  const max = Math.max(...dated.map((r) => r.principal + r.interest));
  const step = rows.length > 24 ? 6 : 3;
  const year = (i: number) => (dated[i].date ? new Date(dated[i].date!).getFullYear() : 0);
  // Подпись и её вес: с годом остаётся и на телефоне, остальные там скрыты.
  const label = (iso: string | undefined, i: number): [string, boolean] => {
    if (i % step !== 0) return ['', false];
    if (!iso) return [`${i + 1}`, i === 0];
    const withYear = i === 0 || year(i) !== year(i - step);
    return [monthLabel(iso, withYear), withYear];
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
