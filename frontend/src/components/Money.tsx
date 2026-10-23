import { NumberInput, Slider, type NumberInputProps } from '@mantine/core';
import type { ReactNode } from 'react';

import { THIN } from '../lib/format';

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
