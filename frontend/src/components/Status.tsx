import { Button } from '@mantine/core';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { useMeta } from '../api/hooks';
import type { Application, StatusInfo, Tone } from '../api/types';
import { useAuth } from '../auth/AuthContext';

const CHIP_TONE: Record<Tone, string> = { neutral: 'plain', info: 'info', warning: 'warn', success: 'ok', danger: 'err' };

/** Подпись статуса на чипе. Контрпредложение называем по сути: другие условия или другой продукт. */
export function statusLabel(app: Pick<Application, 'status' | 'offer' | 'product'>): string {
  if (app.status.code === 'counter_offer' && app.offer) {
    return app.offer.product_code !== app.product.code ? 'Другой продукт' : 'Другие условия';
  }
  return app.status.title;
}

/** Чип статуса: приглушённый фон, тёмный текст того же тона и точка. Текст не обрезается. */
export function Chip({ tone, children, dot = true }: { tone: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className="potok-chip" data-tone={CHIP_TONE[tone]} data-dot={dot}>
      {children}
    </span>
  );
}

export function StatusChip({ app }: { app: Pick<Application, 'status' | 'offer' | 'product'> }) {
  return <Chip tone={app.status.tone}>{statusLabel(app)}</Chip>;
}

type Segment = 'done' | 'now' | 'stop' | 'closed' | 'next';

/**
 * Степпер из сегментов — один на 5 шагов анкеты и 7 этапов заявки. Пройденные — графит, текущий — красный
 * (у отказа — тон ошибки), будущие — светлые. У закрытой заявки будущих сегментов нет.
 */
export function Stepper({
  labels,
  current,
  state = 'active',
  showLabels = true,
}: {
  labels: string[];
  current: number;
  state?: 'active' | 'done' | 'rejected' | 'closed';
  showLabels?: boolean;
}) {
  const shown = state === 'rejected' || state === 'closed' ? labels.slice(0, current + 1) : labels;
  const segment = (i: number): Segment => {
    if (state === 'done' || i < current) return 'done';
    if (i > current) return 'next';
    return state === 'rejected' ? 'stop' : state === 'closed' ? 'closed' : 'now';
  };
  return (
    <ol className="potok-stepper" data-labels={showLabels} style={{ gridTemplateColumns: `repeat(${labels.length}, 1fr)` }}>
      {shown.map((label, i) => (
        <li key={label} data-seg={segment(i)} aria-current={segment(i) === 'now' ? 'step' : undefined}>
          <span className="potok-stepper-label">{label}</span>
        </li>
      ))}
    </ol>
  );
}

function stepperState(status: StatusInfo): 'active' | 'done' | 'rejected' | 'closed' {
  if (status.code === 'issued') return 'done';
  if (status.code === 'rejected') return 'rejected';
  if (status.terminal) return 'closed';
  return 'active';
}

/** Следующий шаг клиента или аналитика: подпись кнопки и куда она ведёт. */
function nextAction(app: Application, role: string | undefined, onPage: boolean): { label: string; to: string } | null {
  const page = `/applications/${app.id}`;
  if (role === 'analyst') {
    return app.allowed_actions.includes('decide') ? { label: 'Принять решение', to: onPage ? '#decision' : page } : null;
  }
  switch (app.status.code) {
    case 'draft':
      return { label: 'Продолжить оформление', to: `${page}/edit` };
    case 'needs_info':
      return { label: 'Ответить на запрос', to: onPage ? '#tasks' : page };
    case 'approved':
    case 'counter_offer':
      // На странице заявки главное действие — в блоке решения; здесь кнопку не дублируем.
      return onPage ? null : { label: 'Открыть предложение', to: page };
    case 'signing':
      return { label: 'Подписать договор', to: onPage ? '#signing' : page };
    case 'issued':
      return app.loan_id ? { label: 'Кредит и график платежей', to: `/loans/${app.loan_id}` } : null;
    case 'rejected':
    case 'expired':
    case 'cancelled':
      return onPage ? null : { label: 'Подобрать другой вариант', to: '/match' };
    default:
      return null;
  }
}

/**
 * Компонент статуса заявки — один на главной, в списке, на странице заявки и у аналитика: степпер, «Шаг N из 7:
 * этап», что будет дальше и кнопка следующего шага.
 */
export function StatusBlock({
  app,
  onPage = false,
  showLabels = false,
  note,
  action = true,
}: {
  app: Application;
  onPage?: boolean;
  showLabels?: boolean;
  note?: ReactNode;
  action?: boolean;
}) {
  const meta = useMeta();
  const { user } = useAuth();
  const stages = meta.data?.stages ?? [];
  const state = stepperState(app.status);
  const stage = stages[app.status.stage] ?? '';
  const next = action ? nextAction(app, user?.role, onPage) : null;
  // Красная кнопка — только когда ход за человеком; иначе спокойная вторичная.
  const variant = app.status.action_required || user?.role === 'analyst' ? 'filled' : 'default';
  const where =
    state === 'rejected' || state === 'closed'
      ? 'Заявка закрыта'
      : `Шаг ${app.status.stage + 1} из ${stages.length || 7}: ${stage}`;
  return (
    <div className="potok-status">
      {stages.length > 0 && <Stepper labels={stages} current={app.status.stage} state={state} showLabels={showLabels} />}
      <div className="potok-status-row">
        <div>
          <div className="potok-status-where">
            {where}
            {note && <span className="potok-status-note"> — {note}</span>}
          </div>
          <div className="potok-status-next">{app.status.hint}</div>
        </div>
        {next &&
          (next.to.startsWith('#') ? (
            <Button component="a" href={next.to} size="md" variant={variant} className="potok-status-action">
              {next.label}
            </Button>
          ) : (
            <Button component={Link} to={next.to} size="md" variant={variant} className="potok-status-action">
              {next.label}
            </Button>
          ))}
      </div>
    </div>
  );
}
