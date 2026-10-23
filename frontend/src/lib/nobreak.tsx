import { Fragment, type ReactNode } from 'react';

// Слово с дефисом — номер заявки или договора («2026-000009», «КД-2026-000002») и название продукта
// («Экспресс-оборот») — не переносится по дефису. Неразрывного дефиса U+2011 в Onest нет: браузер взял бы его
// из другого шрифта, поэтому слово целиком держит white-space: nowrap, а дефис остаётся обычным.
const HYPHENATED = /([\p{L}\d]+(?:-[\p{L}\d]+)+)/u;

export function nb(text: string | null | undefined): ReactNode {
  if (!text) return text;
  const parts = text.split(HYPHENATED);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="potok-nowrap">
        {part}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}
