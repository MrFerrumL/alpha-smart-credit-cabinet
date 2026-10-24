import { Radio } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import type { ReactNode } from 'react';

export interface ChoiceOption<T extends string> {
  value: T;
  title: string;
  /** Одна строка простого пояснения. */
  text?: ReactNode;
}

/** Отметка справа: пустой кружок, у выбранного — красный с белой галочкой. */
export function ChoiceMark() {
  return (
    <span className="potok-choice-mark" aria-hidden="true">
      <IconCheck size={14} stroke={3} />
    </span>
  );
}

/** Выбор одного варианта списком строк: заголовок, пояснение, отметка справа; выбранная строка — в красной рамке. */
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
            <ChoiceMark />
          </Radio.Card>
        ))}
      </div>
    </Radio.Group>
  );
}
