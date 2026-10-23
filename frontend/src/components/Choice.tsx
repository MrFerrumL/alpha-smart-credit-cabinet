import { Radio } from '@mantine/core';
import type { ReactNode } from 'react';

export interface ChoiceOption<T extends string> {
  value: T;
  title: string;
  /** Одна строка простого пояснения. */
  text?: ReactNode;
}

/**
 * Выбор одного варианта списком строк: заголовок и строка пояснения, отметка справа. Выбранная строка — красный
 * край слева и чуть темнее фон; без плиток, иконок в квадратах и теней.
 */
export function ChoiceList<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T | null;
  onChange: (value: T) => void;
  options: ChoiceOption<T>[];
}) {
  return (
    <Radio.Group value={value} onChange={(v) => onChange(v as T)}>
      <div className="potok-choices" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <Radio.Card key={o.value} value={o.value} className="potok-choice">
            <span className="potok-choice-text">
              <span className="potok-choice-title">{o.title}</span>
              {o.text && <span className="potok-choice-sub">{o.text}</span>}
            </span>
            <Radio.Indicator />
          </Radio.Card>
        ))}
      </div>
    </Radio.Group>
  );
}
