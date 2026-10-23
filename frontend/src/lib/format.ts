// Числа как в банковском интерфейсе: разряды и единицы — через неразрывный пробел (U+00A0), десятичная часть —
// через запятую; строка не рвётся внутри суммы или срока. Узкий U+202F в Onest — 0,14 em: в тексте до 20 px его
// почти не видно («329024 ₽»), поэтому он только у крупных цифр (moneyBig).
export const NBSP = ' ';
export const THIN = ' ';

const intFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const SPACES = /[\s  ]/g;

/** Целое с разрядами: 3 000 000. */
export function int(value: number, sep: string = NBSP): string {
  return intFmt.format(Math.round(value)).replace(SPACES, sep);
}

/** Десятичное с запятой: 0,82; 22,9. */
export function decimal(value: number, digits = 1): string {
  return value.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: digits }).replace(SPACES, NBSP);
}

export function money(value: number): string {
  return `${int(value)}${NBSP}₽`;
}

/** Сумма для крупных цифр (20 px и больше): разряды — узким пробелом, иначе они слишком широкие. */
export function moneyBig(value: number): string {
  return `${int(value, THIN)}${NBSP}₽`;
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
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
// День и месяц не разрываются переносом: «23 октября».
const glueDay = (s: string) => s.replace(/^(\d{1,2}) /, `$1${NBSP}`);

export function dateTime(iso: string): string {
  return glueDay(dateTimeFmt.format(new Date(iso)).replace(' в ', `${NBSP}в${NBSP}`));
}

export function date(iso: string): string {
  return glueDay(dateFmt.format(new Date(iso)).replace(/\s*г\.$/, ''));
}

/** 30 октября — без года, для сроков в пределах ближайших недель. */
export function dayMonth(iso: string): string {
  return glueDay(dayMonthFmt.format(new Date(iso)));
}

/** 23.11.2026 — для таблиц. */
export function shortDate(iso: string): string {
  return shortDateFmt.format(new Date(iso));
}

/** Подпись месяца на оси графика: «ноя», с годом — «ноя 2026». */
export function monthLabel(iso: string, withYear: boolean): string {
  const d = new Date(iso);
  const m = MONTHS_SHORT[d.getMonth()];
  return withYear ? `${m}${NBSP}${d.getFullYear()}` : m;
}

/**
 * Типографика для текстов с сервера: строка не начинается с тире, диапазон «1–2» не рвётся.
 * Тире приклеивается к слову слева неразрывным пробелом, у диапазона — «словосоединителем» U+2060.
 */
export function typo(text: string): string {
  return text.replace(/ — /g, `${NBSP}— `).replace(/(\d)–(\d)/g, '$1⁠–⁠$2');
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
