const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

export function money(value: number): string {
  return `${rub.format(value)} ₽`;
}

export function moneyShort(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
  }
  if (value >= 1_000) return `${rub.format(Math.round(value / 1_000))} тыс. ₽`;
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
  return `${n} ${plural(n, ['месяц', 'месяца', 'месяцев'])}`;
}

export function rate(value: number): string {
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
}

const dateTimeFmt = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
});

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

export function dateTime(iso: string): string {
  return dateTimeFmt.format(new Date(iso));
}

export function date(iso: string): string {
  return dateFmt.format(new Date(iso));
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
