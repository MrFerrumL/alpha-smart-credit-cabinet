// Числа как в банковском интерфейсе: разряды — узкий неразрывный пробел (U+202F), между числом и единицей —
// неразрывный пробел (U+00A0), десятичная часть — через запятую. Строка не рвётся внутри суммы или срока.
export const NBSP = ' ';
export const THIN = ' ';

const intFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

/** Целое с узкими пробелами между разрядами: 3 000 000. */
export function int(value: number): string {
  return intFmt.format(Math.round(value)).replace(/[\s  ]/g, THIN);
}

/** Десятичное с запятой: 0,82; 22,9. */
export function decimal(value: number, digits = 1): string {
  return value.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: digits }).replace(/[\s  ]/g, THIN);
}

export function money(value: number): string {
  return `${int(value)}${NBSP}₽`;
}

export function moneyShort(value: number): string {
  if (value >= 1_000_000) return `${decimal(value / 1_000_000)}${NBSP}млн${NBSP}₽`;
  if (value >= 1_000) return `${int(value / 1_000)}${NBSP}тыс.${NBSP}₽`;
  return money(value);
}

export function plural(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

export function months(n: number): string {
  return `${n}${NBSP}${plural(n, ['месяц', 'месяца', 'месяцев'])}`;
}

/** Срок коротко: 16 мес. */
export function monthsShort(n: number): string {
  return `${n}${NBSP}мес.`;
}

export function rate(value: number): string {
  return `${decimal(value)}%`;
}

/** Доля в процентах: 0,239 → 23,9%. */
export function percent(share: number, digits = 1): string {
  return `${decimal(share * 100, digits)}%`;
}

/** Длительность коротко: 1 ч 43 мин, 25 мин, 2 дн 4 ч. */
export function duration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}${NBSP}дн${hours ? `${NBSP}${hours}${NBSP}ч` : ''}`;
  if (hours > 0) return `${hours}${NBSP}ч${mins ? `${NBSP}${mins}${NBSP}мин` : ''}`;
  return `${mins}${NBSP}мин`;
}

const dateTimeFmt = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
});

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const dayMonthFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const shortDateFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
const monthFmt = new Intl.DateTimeFormat('ru-RU', { month: 'short' });

export function dateTime(iso: string): string {
  return dateTimeFmt.format(new Date(iso)).replace(' в ', `${NBSP}в${NBSP}`);
}

export function date(iso: string): string {
  return dateFmt.format(new Date(iso)).replace(/\s*г\.$/, '');
}

/** 30 октября — без года, для сроков в пределах ближайших недель. */
export function dayMonth(iso: string): string {
  return dayMonthFmt.format(new Date(iso));
}

/** 23.11.2026 — для таблиц. */
export function shortDate(iso: string): string {
  return shortDateFmt.format(new Date(iso));
}

/** Подпись месяца на оси графика: «ноя», с годом — «ноя 2026». */
export function monthLabel(iso: string, withYear: boolean): string {
  const d = new Date(iso);
  const m = monthFmt.format(d).replace('.', '');
  return withYear ? `${m}${NBSP}${d.getFullYear()}` : m;
}

export function yearsSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / (365.25 * 24 * 3600 * 1000)));
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return 'Доброй ночи';
  if (h < 12) return 'Доброе утро';
  if (h < 18) return 'Добрый день';
  return 'Добрый вечер';
}
