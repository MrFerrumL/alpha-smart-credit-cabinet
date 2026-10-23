import { NumberInput, Slider, type NumberInputProps } from '@mantine/core';
import type { ReactNode } from 'react';

import { THIN, moneyShort, monthsShort } from '../lib/format';

/** Поле суммы: разряды через узкий пробел, «₽» в поле справа, без стрелок, на телефоне — цифровая клавиатура. */
export function MoneyInput({ unit = '₽', ...props }: NumberInputProps & { unit?: ReactNode }) {
  return (
    <NumberInput
      thousandSeparator={THIN}
      allowNegative={false}
      allowDecimal={false}
      inputMode="numeric"
      hideControls
      rightSection={<span className="potok-unit">{unit}</span>}
      rightSectionPointerEvents="none"
      rightSectionWidth={56}
      {...props}
    />
  );
}

export interface Tick {
  value: number;
  label: string;
  /** Подпись остаётся и на узком экране (края шкалы). */
  major?: boolean;
}

/**
 * Сумма или срок: поле сверху и слайдер под ним — один контрол на подборе и в анкете. Подписи шкалы — у краёв и
 * у 2–3 опорных значений, на телефоне — только у краёв, чтобы не сталкивались.
 */
export function AmountControl({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit = '₽',
  ticks,
  description,
  error,
  sliderLabel,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  unit?: ReactNode;
  ticks: Tick[];
  description?: ReactNode;
  error?: ReactNode;
  sliderLabel?: string;
}) {
  const position = (v: number) => `${((v - min) / (max - min)) * 100}%`;
  return (
    <div className="potok-amount">
      <MoneyInput
        label={label}
        value={value}
        min={min}
        max={max}
        unit={unit}
        onChange={(v) => onChange(typeof v === 'number' ? v : Number(v) || 0)}
        onBlur={() => onChange(Math.min(max, Math.max(min, value)))}
        error={error}
        thousandSeparator={unit === '₽' ? THIN : undefined}
      />
      <Slider
        value={Math.min(max, Math.max(min, value))}
        onChange={onChange}
        min={min}
        max={max}
        step={step}
        label={null}
        thumbLabel={sliderLabel ?? label}
        className="potok-amount-slider"
      />
      <div className="potok-ticks" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t.value} data-major={t.major ?? false} style={{ left: position(t.value) }}>
            {t.label}
          </span>
        ))}
      </div>
      {description && <div className="potok-amount-hint">{description}</div>}
    </div>
  );
}

/** Ближайшее «круглое» число ряда 1–2–2,5–5: 25 млн, а не 16,7 млн. */
function nice(v: number): number {
  const exp = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * exp).reduce((best, c) => (Math.abs(c - v) < Math.abs(best - v) ? c : best));
}

/** Подписи шкалы суммы: края и одна круглая опорная точка посередине. */
export function amountTicks(min: number, max: number): Tick[] {
  const mid = nice((min + max) / 2);
  const values = mid > min && mid < max ? [min, mid, max] : [min, max];
  return values.map((value, i) => ({ value, label: moneyShort(value), major: i === 0 || i === values.length - 1 }));
}

const TERM_PRESETS = [6, 12, 18, 24, 36];

/**
 * Срок: поле в месяцах, быстрые значения и слайдер — всё синхронно. Быстрые значения — 6, 12, 18, 24, 36 и
 * максимум продукта, только в его диапазоне; без слайдера срок задаётся с клавиатуры или кнопкой.
 */
export function TermControl({
  label = 'Срок',
  value,
  onChange,
  min,
  max,
  step,
  description,
  error,
}: {
  label?: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  description?: ReactNode;
  error?: ReactNode;
}) {
  const presets = [...new Set([...TERM_PRESETS, max])].filter((v) => v >= min && v <= max).sort((a, b) => a - b);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <div className="potok-amount potok-term">
      <MoneyInput
        label={label}
        unit="мес."
        thousandSeparator={undefined}
        value={value}
        min={min}
        max={max}
        onChange={(v) => onChange(typeof v === 'number' ? v : Number(v) || 0)}
        onBlur={() => onChange(clamp(value))}
        error={error}
      />
      <Slider
        value={clamp(value)}
        onChange={onChange}
        min={min}
        max={max}
        step={step}
        label={null}
        thumbLabel="Ползунок срока"
        className="potok-amount-slider"
      />
      <div className="potok-presets" role="group" aria-label="Быстрый выбор срока">
        {presets.map((p) => (
          <button key={p} type="button" className="potok-preset" aria-pressed={value === p} onClick={() => onChange(p)}>
            {monthsShort(p)}
          </button>
        ))}
      </div>
      {description && <div className="potok-amount-hint">{description}</div>}
    </div>
  );
}
