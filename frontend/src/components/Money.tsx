import { NumberInput, Slider, type NumberInputProps } from '@mantine/core';
import type { ReactNode } from 'react';

import { NBSP, moneyShort, months, monthsShort } from '../lib/format';

/** Поле суммы: разряды через узкий пробел, «₽» в поле справа, без стрелок, на телефоне — цифровая клавиатура. */
export function MoneyInput({ unit = '₽', ...props }: NumberInputProps & { unit?: ReactNode }) {
  return (
    <NumberInput
      thousandSeparator={NBSP}
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

// Логарифмическая шкала: 100 делений от минимума до максимума, значение округляется до круглого — 3 000 000
// оказывается в середине шкалы, а не прижат к левому краю. Шаг округления растёт вместе с суммой.
const LOG_STEPS = 100;
function roundAmount(v: number): number {
  const unit = v < 1_000_000 ? 10_000 : v < 10_000_000 ? 100_000 : 500_000;
  return Math.round(v / unit) * unit;
}

/**
 * Сумма: поле — такое же, как у срока (подпись, значение и «₽» на одной линии), под ним отдельной строкой — слайдер
 * по ширине поля. Под слайдером — только минимум и максимум.
 */
export function AmountControl({
  label,
  value,
  onChange,
  min,
  max,
  step,
  scale = 'linear',
  unit = '₽',
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
  scale?: 'linear' | 'log';
  unit?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  sliderLabel?: string;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const log = scale === 'log';
  const toPos = (v: number) => (log ? Math.round((LOG_STEPS * Math.log(clamp(v) / min)) / Math.log(max / min)) : clamp(v));
  const fromPos = (p: number) => (log ? clamp(roundAmount(min * (max / min) ** (p / LOG_STEPS))) : p);
  return (
    <div className="potok-amount">
      <MoneyInput
        label={label}
        value={value}
        min={min}
        max={max}
        unit={unit}
        onChange={(v) => onChange(typeof v === 'number' ? v : Number(v) || 0)}
        onBlur={() => onChange(clamp(value))}
        error={error}
        thousandSeparator={unit === '₽' ? NBSP : undefined}
      />
      <div className="potok-amount-row">
        <Slider
          value={toPos(value)}
          onChange={(p) => onChange(fromPos(p))}
          min={log ? 0 : min}
          max={log ? LOG_STEPS : max}
          step={log ? 1 : step}
          label={null}
          thumbLabel={sliderLabel ?? label}
          className="potok-amount-slider"
        />
      </div>
      <div className="potok-ticks" aria-hidden="true">
        <span>{moneyShort(min)}</span>
        <span>{moneyShort(max)}</span>
      </div>
      {description && <div className="potok-amount-hint">{description}</div>}
    </div>
  );
}

/** Сумма и срок для подбора и анкеты. Если срок у продукта фиксированный, он показан текстом. */
export function AmountTermFields({
  amount,
  onAmount,
  term,
  onTerm,
  minAmount,
  maxAmount,
  minTerm,
  maxTerm,
  amountError,
  termError,
}: {
  amount: number;
  onAmount: (v: number) => void;
  term: number;
  onTerm: (v: number) => void;
  minAmount: number;
  maxAmount: number;
  minTerm: number;
  maxTerm: number;
  amountError?: ReactNode;
  termError?: ReactNode;
}) {
  return (
    <div className="potok-amount-term">
      <AmountControl
        label="Сумма"
        sliderLabel="Ползунок суммы"
        value={amount}
        onChange={onAmount}
        min={minAmount}
        max={maxAmount}
        step={50_000}
        scale="log"
        error={amountError}
      />
      {minTerm === maxTerm ? (
        <div className="potok-term-fixed">
          <span>Срок</span>
          <b>{monthsShort(minTerm)}</b>
          <span>Лимит открывается на {months(minTerm)} и продлевается</span>
        </div>
      ) : (
        <TermControl value={term} onChange={onTerm} min={minTerm} max={maxTerm} step={minTerm >= 12 ? 6 : 3} error={termError} />
      )}
    </div>
  );
}

const TERM_PRESETS = [6, 12, 18, 24, 36];

/** Срок: поле в месяцах и быстрые значения в диапазоне продукта; при уходе из поля значение возвращается в диапазон. */
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
  // Ровные ряды: четыре — 2 × 2; из пяти второе значение убираем, чтобы не было ряда 3 + 2.
  if (presets.length === 5) presets.splice(1, 1);
  const columns = presets.length === 4 ? 2 : Math.min(presets.length, 3);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  // Текст — как у правила продукта на сервере. Меньше минимума не ругаемся: человек, скорее всего, ещё печатает.
  const rangeError = value > max ? `Срок — от ${min} до ${max} мес.` : undefined;
  return (
    <div className="potok-term">
      <MoneyInput
        label={label}
        unit="мес."
        thousandSeparator={undefined}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(v) => onChange(typeof v === 'number' ? v : Number(v) || 0)}
        onBlur={() => onChange(clamp(value))}
        error={error ?? rangeError}
      />
      <div
        className="potok-presets"
        role="group"
        aria-label="Быстрый выбор срока"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
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
