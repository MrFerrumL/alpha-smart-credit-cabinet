import { Button } from '@mantine/core';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { useEvents, useMeta } from '../api/hooks';
import type { Application, StatusInfo, Tone } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { typo } from '../lib/format';

const CHIP_TONE: Record<Tone, string> = { neutral: 'plain', info: 'info', warning: 'warn', success: 'ok', danger: 'err' };

/** Подпись статуса на чипе. Контрпредложение называем по сути: другие условия или другой продукт. */
export function statusLabel(app: Pick<Application, 'status' | 'offer' | 'product'>): string {
  if (app.status.code === 'counter_offer' && app.offer) {
    return app.offer.product_code !== app.product.code ? 'Другой продукт' : 'Другие условия';
  }
  return app.status.title;
}

/**
 * Чип статуса: приглушённый фон, тёмный текст того же тона и точка. Текст не обрезается; длинный (wrap) переносится
 * на следующую строку, а не выходит за край узкой колонки.
 */
export function Chip({ tone, children, dot = true, wrap = false }: { tone: Tone; children: ReactNode; dot?: boolean; wrap?: boolean }) {
  return (
    <span className="potok-chip" data-tone={CHIP_TONE[tone]} data-dot={dot} data-wrap={wrap || undefined}>
      {children}
    </span>
  );
}

export function StatusChip({ app }: { app: Pick<Application, 'status' | 'offer' | 'product'> }) {
  return <Chip tone={app.status.tone}>{statusLabel(app)}</Chip>;
}

type Segment = 'done' | 'now' | 'stop' | 'closed' | 'next';

/** Степпер из сегментов для шагов анкеты и этапов заявки; у закрытой заявки будущих сегментов нет. */
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
    <ol className="potok-stepper" data-labels={showLabels} style={{ gridTemplateColumns: `repeat(${shown.length}, 1fr)` }}>
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

interface Next {
  label: string;
  to: string;
  /** Спокойная кнопка: ход не за этим человеком, он только открывает заявку. */
  quiet?: boolean;
}

/** Следующий шаг клиента или аналитика: подпись кнопки и куда она ведёт. */
function nextAction(app: Application, role: string | undefined, onPage: boolean): Next | null {
  const page = `/applications/${app.id}`;
  if (role === 'analyst') {
    return app.allowed_actions.includes('decide') ? { label: 'Принять решение', to: onPage ? '#decision' : page } : null;
  }
  switch (app.status.code) {
    case 'draft':
      return { label: 'Продолжить оформление', to: `${page}/edit` };
    case 'needs_info':
      // На странице заявки запрос банка — в том же блоке статуса, со своей кнопкой.
      return onPage ? null : { label: 'Ответить на запрос', to: page };
    case 'approved':
    case 'counter_offer':
      // На странице заявки главное действие — в блоке решения; здесь кнопку не дублируем.
      return onPage ? null : { label: 'Открыть предложение', to: page };
    case 'signing':
      // Кнопка по тому, что этот человек может сделать: подписать договор, закрыть условия выдачи или только открыть заявку.
      if (app.allowed_actions.includes('sign')) return { label: 'Подписать договор', to: onPage ? '#signing' : page };
      if (app.allowed_actions.includes('answer_tasks')) return { label: 'Закрыть условия выдачи', to: onPage ? '#tasks' : page };
      return onPage ? null : { label: 'Открыть заявку', to: page, quiet: true };
    case 'issued':
      // На странице заявки ссылка на кредит — в карточке выдачи; здесь не дублируем.
      return app.loan_id && !onPage ? { label: 'Кредит и график платежей', to: `/loans/${app.loan_id}` } : null;
    case 'rejected':
    case 'expired':
    case 'cancelled':
      return onPage ? null : { label: 'Подобрать другой вариант', to: '/match' };
    default:
      return null;
  }
}

/** Что происходит с заявкой — словами банка: аналитику не нужны клиентские «обычно это занимает 1–2 дня». */
const BANK_HINT: Record<string, string> = {
  draft: 'Клиент ещё заполняет анкету',
  submitted: 'Заявка в очереди конвейера',
  validation: 'Конвейер проверяет анкету',
  enrichment: 'Конвейер запрашивает ЕГРЮЛ, ФНС и БКИ',
  scoring: 'Конвейер считает оценку и условия',
  needs_info: 'Ждём ответа клиента на запрос банка',
  manual_review: 'Ждёт решения специалиста: проверьте оценку и условия и сохраните решение',
  approved: 'Решение принято, ждём ответа клиента на предложение',
  counter_offer: 'Сделано предложение на других условиях, ждём ответа клиента',
  rejected: 'Заявка закрыта отказом',
  signing: 'Клиент подписывает договор',
  issued: 'Кредит выдан',
  cancelled: 'Клиент отозвал заявку',
  expired: 'Предложение истекло без ответа клиента',
};

// Что клиенту сделать сначала: подписать договор, ответить на предложение, на запрос банка, дозаполнить черновик.
const ACTION_RANK: Record<string, number> = { signing: 0, approved: 1, counter_offer: 1, needs_info: 2, draft: 3 };

const actionRank = (app: Application) => (app.status.action_required ? (ACTION_RANK[app.status.code] ?? 4) : 5);

/** Порядок заявок: сначала та, где ход за клиентом и он важнее, затем свежие. */
export function byAction(a: Application, b: Application): number {
  return actionRank(a) - actionRank(b) || b.id - a.id;
}

/**
 * Этап, на котором банк запросил информацию: запрос после оценки не откатывает степпер к «Проверке данных».
 * Берётся из события перехода в needs_info (откуда пришла заявка).
 */
function useShownStage(app: Application): number {
  const meta = useMeta();
  const asks = app.status.code === 'needs_info';
  const events = useEvents(app.id, app, asks);
  if (!asks || !events.data) return app.status.stage;
  const ev = events.data.findLast((e) => e.to_status === 'needs_info');
  const from = meta.data?.statuses.find((s) => s.code === ev?.from_status);
  return Math.max(app.status.stage, from?.stage ?? 0);
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
  hint = true,
  primary,
  hintTail,
  aside,
  children,
}: {
  app: Application;
  onPage?: boolean;
  showLabels?: boolean;
  note?: ReactNode;
  action?: boolean;
  /** Подсказка статуса; в блоке решения её заменяет фраза исхода. */
  hint?: boolean;
  /** Красная ли кнопка шага; по умолчанию — когда ход за человеком. В списке заявок красная только у первой. */
  primary?: boolean;
  /** Продолжение строки подсказки — например, «статус обновляется сам». */
  hintTail?: ReactNode;
  /** Второстепенное действие справа в строке статуса. */
  aside?: ReactNode;
  /** Строки под подсказкой. */
  children?: ReactNode;
}) {
  const meta = useMeta();
  const { user } = useAuth();
  const stages = meta.data?.stages ?? [];
  const state = stepperState(app.status);
  const current = useShownStage(app);
  const stage = stages[current] ?? '';
  const next = action ? nextAction(app, user?.role, onPage) : null;
  // Красная кнопка — только когда ход за человеком; иначе спокойная вторичная.
  const variant = !next?.quiet && (primary ?? (app.status.action_required || user?.role === 'analyst')) ? 'filled' : 'default';
  const where =
    state === 'rejected' || state === 'closed' ? 'Заявка закрыта' : `Шаг ${current + 1} из ${stages.length || 7}: ${stage}`;
  return (
    <div className="potok-status">
      {stages.length > 0 && <Stepper labels={stages} current={current} state={state} showLabels={showLabels} />}
      <div className="potok-status-row">
        <div>
          <div className="potok-status-where">
            {where}
            {note && <span className="potok-status-note"> — {note}</span>}
          </div>
          {hint && (
            <div className="potok-status-next">
              {typo(user?.role === 'analyst' ? (BANK_HINT[app.status.code] ?? app.status.title) : app.status.hint)}
              {hintTail}
            </div>
          )}
          {children}
        </div>
        {(next || aside) && (
          <div className="potok-status-actions">
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
            {aside}
          </div>
        )}
      </div>
    </div>
  );
}
