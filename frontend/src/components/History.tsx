import { Collapse, Text, UnstyledButton } from '@mantine/core';
import { useState } from 'react';

import type { ApplicationEvent } from '../api/types';
import { dateTime } from '../lib/format';

const ACTOR_LABEL: Record<ApplicationEvent['actor_type'], string> = {
  client: 'Клиент',
  analyst: 'Банк',
  system: 'Банк, автоматически',
};

// Ключевые события: всё, что сделал человек, и переходы к решению, подписанию и выдаче. Остальное — проверки.
const KEY_STATUSES = new Set(['submitted', 'needs_info', 'manual_review', 'approved', 'counter_offer', 'rejected', 'signing', 'issued', 'cancelled', 'expired']);

function isKey(ev: ApplicationEvent): boolean {
  return ev.actor_type !== 'system' || (ev.to_status !== null && KEY_STATUSES.has(ev.to_status));
}

function EventItem({ ev, bank }: { ev: ApplicationEvent; bank: boolean }) {
  return (
    <li data-tone={ev.to_status === 'issued' || ev.to_status === 'approved' ? 'ok' : undefined}>
      <Text fz="sm" fw={500}>
        {ev.title}
      </Text>
      <Text fz="xs" c="dimmed" className="num">
        {dateTime(ev.created_at)}, {ev.actor_name ?? ACTOR_LABEL[ev.actor_type]}
      </Text>
      {ev.comment && (
        <Text fz="sm" mt={4}>
          «{ev.comment}»
        </Text>
      )}
      {bank && ev.internal_comment && (
        <Text fz="xs" mt={4} c="dimmed">
          Обоснование (видит только банк): {ev.internal_comment}
        </Text>
      )}
    </li>
  );
}

/** История: ключевые события, автоматические проверки свёрнуты в одну строку. Новые — сверху. */
export function History({ events, bank = false }: { events: ApplicationEvent[]; bank?: boolean }) {
  const [open, setOpen] = useState(false);
  const ordered = [...events].reverse();
  const auto = ordered.filter((e) => !isKey(e));
  const firstAuto = ordered.findIndex((e) => !isKey(e));
  return (
    <ul className="potok-timeline">
      {ordered.map((ev, i) =>
        isKey(ev) ? (
          <EventItem key={ev.id} ev={ev} bank={bank} />
        ) : i === firstAuto ? (
          <li key="auto" data-group="true">
            <UnstyledButton onClick={() => setOpen((o) => !o)} aria-expanded={open} className="potok-timeline-toggle">
              Автоматические проверки ({auto.length})
            </UnstyledButton>
            <Collapse in={open}>
              <ul className="potok-timeline potok-timeline-nested">
                {auto.map((a) => (
                  <EventItem key={a.id} ev={a} bank={bank} />
                ))}
              </ul>
            </Collapse>
          </li>
        ) : null,
      )}
    </ul>
  );
}

