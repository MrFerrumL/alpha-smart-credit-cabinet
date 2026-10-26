import { Alert, Anchor, Button, Collapse, Group, NumberInput, Radio, SegmentedControl, Skeleton, Stack, Table, Text, TextInput, Textarea, Title } from '@mantine/core';
import { IconCheck, IconInfoCircle, IconRepeat, IconX } from '@tabler/icons-react';
import { useEffect, useId, useLayoutEffect, useState, type ReactNode } from 'react';

import { ApiError } from '../api/client';
import { useAnalystDecision, useAssessment, useChecks, useProducts, useReplay } from '../api/hooks';
import type {
  Application,
  ApplicationEvent,
  Assessment,
  ClientTask,
  DecisionOutcome,
  Offer,
  Terms,
  TraceStep,
  UploadedDocument,
} from '../api/types';
import { monthlyPayment } from '../lib/finance';
import { NBSP, dateTime, dayMonth, decimal, duration, lowerFirst, money, months, percent, plural, rate, typo } from '../lib/format';
import { nb } from '../lib/nobreak';
import { COLLATERAL_TITLES } from './ApplicationBlocks';
import { OUTCOME, REASONS_TITLE } from './Decision';
import { History } from './History';
import { MoneyInput } from './Money';
import { RiskPanel } from './RiskPanel';
import { Chip, StatusBlock, StatusChip } from './Status';

const OUTCOMES: { value: DecisionOutcome; label: string }[] = [
  { value: 'approve', label: 'Одобрить' },
  { value: 'counter_offer', label: 'Контрпредложение' },
  { value: 'request_info', label: 'Запросить документы' },
  { value: 'reject', label: 'Отказать' },
  { value: 'retry_checks', label: 'Повторить проверки' },
];

/** Сколько действует предложение — как offer_valid_days в backend/app/config.py. */
const OFFER_VALID_DAYS = 7;

/** Сообщение клиенту, если поле пустое, — те же тексты, что DEFAULT_CLIENT_MESSAGE в backend/app/services/decisions.py. */
const DEFAULT_MESSAGE: Record<DecisionOutcome, string> = {
  approve: 'Кредитный специалист одобрил заявку на запрошенных условиях.',
  counter_offer: 'Кредитный специалист предлагает другие условия — сравните их с запрошенными.',
  request_info: 'Кредитному специалисту нужна дополнительная информация.',
  reject: 'Кредитный специалист рассмотрел заявку и не смог её одобрить.',
  retry_checks: 'Повторяем проверку данных компании.',
};

/** Виды документов — как DOCUMENT_KINDS в backend/app/services/tasks.py. */
const DOCUMENT_KINDS: Record<string, string> = {
  bank_statement: 'Выписка по расчётному счёту',
  financial_report: 'Бухгалтерская отчётность',
  collateral: 'Документы по залогу',
  other: 'Другой документ',
};

/** Версия правил по-человечески: в интерфейсе нет технических номеров. */
export function policyName(version: string | null | undefined): string {
  if (version === 'policy-1.1') return 'правила от 22 октября';
  if (version === 'policy-1.0') return 'прежние правила';
  return 'правила банка';
}

// --- Расчёты ------------------------------------------------------------------------------------

/** Сумма в тексте для клиента — как _money в backend/app/scoring/decision.py: «19,5 млн ₽». */
function moneyText(value: number): string {
  return value >= 1_000_000 ? `${decimal(value / 1_000_000, 2)}${NBSP}млн${NBSP}₽` : money(value);
}

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/**
 * Условия с нагрузкой и покрытием — как _terms на сервере. Посильность считается по аннуитету на тот же срок
 * (service_payment): у овердрафта иначе возврат всего лимита в конце срока не попал бы ни в нагрузку, ни в покрытие.
 */
function termsFor(a: Assessment, amount: number, term: number, ratePct: number, payment?: number): Terms {
  const service = term > 0 ? monthlyPayment(amount, ratePct, term, 'annuity') : 0;
  const revenue = a.revenue?.confirmed_monthly ?? null;
  return {
    amount,
    term_months: term,
    rate: ratePct,
    monthly_payment: payment ?? (term > 0 ? monthlyPayment(amount, ratePct, term, a.repayment) : 0),
    dsr: revenue ? ((a.existing_payments ?? 0) + service) / revenue : null,
    coverage: a.monthly_profit !== null && service > 0 ? a.monthly_profit / service : null,
  };
}

/** Что не проходит на запрошенных условиях: лимит по выручке, нагрузка, покрытие платежа прибылью. */
function requestedProblems(a: Assessment): string[] {
  const r = a.requested;
  const out: string[] = [];
  if (a.revenue_limit !== null && r.amount > a.revenue_limit) out.push(`сумма выше лимита по выручке ${money(a.revenue_limit)}`);
  if (r.dsr !== null && r.dsr > a.max_dsr) out.push(`нагрузка ${percent(r.dsr)} при лимите ${percent(a.max_dsr, 0)}`);
  if (r.coverage !== null && r.coverage < a.min_coverage) {
    out.push(`покрытие ×${decimal(r.coverage, 2)} при минимуме ×${decimal(a.min_coverage, 1)}`);
  }
  return out;
}

/** Расхождения анкеты с ФНС и БКИ: выручка со слов клиента и долговые платежи, о которых клиент не сказал. */
function discrepancies(a: Assessment): string[] {
  const out: string[] = [];
  const gap = a.revenue?.gap_pct ?? null;
  if (gap !== null && Math.abs(gap) > 10) {
    const where = a.revenue?.source === 'statement' ? 'чем по выписке' : 'чем в ФНС';
    out.push(`Выручка со слов клиента на ${decimal(Math.abs(gap), 0)}% ${gap > 0 ? 'выше' : 'ниже'}, ${where}`);
  }
  if (!a.declared_debt_payments && (a.existing_payments ?? 0) > 0) {
    out.push(`Платежи по кредитам не указаны, а в БКИ — ${money(a.existing_payments!)} в месяц`);
  }
  return out;
}

/**
 * Сообщение клиенту по условиям решения — в духе пояснений конвейера (fit_terms в scoring/decision.py): что
 * изменилось и почему. Для одобрения — сильные стороны заявки, как у автоматического одобрения.
 */
function autoMessage(outcome: DecisionOutcome, app: Application, a: Assessment, amount: number, term: number, ratePct: number): string {
  const parts: string[] = [];
  if (outcome === 'approve') {
    parts.push(
      ...[...a.factors]
        .filter((f) => f.points > 0)
        .sort((x, y) => y.points - x.points)
        .slice(0, 3)
        .map((f) => f.client_text),
    );
    if (!parts.length) return DEFAULT_MESSAGE.approve;
  } else if (outcome === 'counter_offer') {
    const req = a.requested;
    const revenue = a.revenue?.confirmed_monthly;
    if (amount > 0 && amount < app.amount) {
      if (a.revenue_limit !== null && revenue && app.amount > a.revenue_limit && amount <= a.revenue_limit) {
        parts.push(
          `Сумма уменьшена до ${moneyText(amount)}: при выручке ${moneyText(revenue)} в месяц по этому продукту доступно до ${moneyText(a.revenue_limit)}`,
        );
      } else {
        const why: string[] = [];
        if (req.dsr !== null && req.dsr > a.max_dsr) why.push(`платежи по кредитам не превышали ${percent(a.max_dsr, 0)} выручки`);
        if (req.coverage !== null && req.coverage < a.min_coverage) why.push('прибыль покрывала платёж с запасом');
        parts.push(`Сумма уменьшена до ${moneyText(amount)}${why.length ? `, чтобы ${why.join(', а ')}` : ''}`);
      }
    }
    if (term > app.term_months) parts.push(`Срок увеличен до ${term}${NBSP}мес., чтобы ежемесячный платёж был посильным`);
    else if (term > 0 && term < app.term_months) parts.push(`Срок сокращён до ${term}${NBSP}мес., чтобы переплата была меньше`);
    if (!parts.length) return DEFAULT_MESSAGE.counter_offer;
  } else {
    return DEFAULT_MESSAGE[outcome];
  }
  if (ratePct > app.product.rate) parts.push(`Ставка ${rate(ratePct)} учитывает оценку заявки`);
  return parts.map(sentence).join(' ');
}

const OFFER_STATUSES = ['approved', 'counter_offer'];

/**
 * Событие, которым принято текущее решение: переход в одобрение или контрпредложение, отказ, запрос информации.
 * undefined — история ещё от прежнего статуса (перечитывается после решения), null — такого перехода нет.
 */
function decisionEvent(app: Application, events?: ApplicationEvent[]): ApplicationEvent | null | undefined {
  if (!events) return undefined;
  const moves = events.filter((e) => e.to_status);
  if (moves.at(-1)?.to_status !== app.status.code) return undefined;
  const targets = app.offer ? OFFER_STATUSES : [app.status.code];
  return moves.findLast((e) => targets.includes(e.to_status!)) ?? null;
}

/**
 * Боковая панель выше экрана прилипает нижним краем: при прокрутке страницы она доезжает до конца, и кнопка
 * «Сохранить решение» остаётся на экране. Панель ниже экрана прилипает к верху, как раньше.
 */
function useStickyTop(gap = 16) {
  // Ref-колбэк: панель появляется не сразу (после загрузки оценки или смены статуса), наблюдение начинается с ней.
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [top, setTop] = useState(gap);
  useLayoutEffect(() => {
    if (!el) return;
    const update = () => setTop(Math.min(gap, window.innerHeight - el.offsetHeight - gap));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [el, gap]);
  return [setEl, top] as const;
}

// --- Сводка -------------------------------------------------------------------------------------

function Load({ value, max }: { value: number | null; max: number }) {
  if (value === null) return <span className="potok-muted-text">—</span>;
  return <span className={value > max ? 'potok-bad' : undefined}>{percent(value)}</span>;
}

function Coverage({ value, min }: { value: number | null; min: number }) {
  if (value === null) return <span className="potok-muted-text">нет данных ФНС</span>;
  return <span className={value < min ? 'potok-bad' : undefined}>×{decimal(value, 2)}</span>;
}

/**
 * Что советует конвейер — одной фразой с цифрами и тем, что не проходит на запрошенных условиях. byPipeline — решение
 * принял сам конвейер: у автоматического одобрения и отказа рекомендации нет, вместо неё — его предложение или причина;
 * unknown — история ещё догружается.
 */
function recommendation(
  app: Application,
  a: Assessment,
  { byPipeline, unknown, productName }: { byPipeline: boolean; unknown: boolean; productName?: string },
): ReactNode {
  const auto = byPipeline ? app.offer : null;
  if (!a.scored) {
    return a.failed_sources.length
      ? `сначала повторить проверки — не ответили ${a.failed_sources.join(', ')}`
      : 'оценки нет — разберите заявку вручную';
  }
  const stop = a.stop_checks.find((c) => !c.passed);
  if (stop) return `отказать — не пройден стоп-фактор «${stop.title}»`;
  if (a.grade === 'E') return 'отказать — грейд E за пределами кредитной политики';
  const problems = requestedProblems(a);
  const tail = problems.length ? `; на запрошенных условиях ${problems.join(', ')}` : '';
  const t = a.recommendation ?? (auto ? termsFor(a, auto.amount, auto.term_months, auto.rate, auto.monthly_payment) : null);
  if (!t) {
    // Предложение сделано, а история ещё догружается: кто его сделал, пока неизвестно — не утверждаем лишнего.
    if (unknown && app.offer) return '…';
    const why = byPipeline && app.status.code === 'rejected' ? app.decision?.reasons[0] : undefined;
    // «По данным…» → «по данным…»; аббревиатура в начале («ЕГРЮЛ…») остаётся как есть.
    if (why) return `отказать — ${/^.\p{Ll}/u.test(why) ? why.charAt(0).toLowerCase() + why.slice(1) : why}`;
    return `отказать — условия не проходят политику даже на минимальную сумму${tail}`;
  }
  const terms = (
    <>
      <b>{money(t.amount)}</b> на {t.term_months}
      {NBSP}мес. под {rate(t.rate)}
    </>
  );
  if (auto && auto.product_code !== app.product.code) {
    return (
      <>
        другой продукт{productName ? <> — {nb(`«${productName}»`)}</> : null}: {terms}
        {tail}
      </>
    );
  }
  if (t.amount === a.requested.amount && t.term_months === a.requested.term_months) {
    return <>одобрить на запрошенных условиях: {terms}</>;
  }
  return (
    <>
      контрпредложение {terms}
      {tail}
    </>
  );
}

/** Сводка — первые строки карточки: почему заявка у специалиста, что советует конвейер и что не сходится. */
function Summary({ app, a, events }: { app: Application; a: Assessment; events?: ApplicationEvent[] }) {
  const id = useId();
  const products = useProducts();
  const decided = decisionEvent(app, events);
  const byPipeline = !!decided && decided.event !== 'analyst_decision';
  const productName = byPipeline ? products.data?.find((p) => p.code === app.offer?.product_code)?.name : undefined;
  const flags = discrepancies(a);
  const noFlags = !a.revenue
    ? 'сверять пока не с чем — оценки ещё нет'
    : a.revenue.confirmed_monthly === null
      ? 'выручку не с чем сверить — в ФНС нет данных, выписки нет'
      : `нет — выручка и платежи по кредитам сходятся с ${a.revenue.source === 'statement' ? 'выпиской' : 'ФНС'} и БКИ`;
  return (
    <section className="potok-panel" aria-labelledby={id}>
      <Title order={3} id={id}>
        Сводка
      </Title>
      <div className="potok-summary">
        {a.review_reason_title && (
          <p>
            <span className="potok-summary-k">Почему у вас:</span> {typo(lowerFirst(a.review_reason_title))}
          </p>
        )}
        <p>
          <span className="potok-summary-k">{a.can_decide ? 'Конвейер рекомендует:' : 'Конвейер рекомендовал:'}</span>{' '}
          {recommendation(app, a, { byPipeline, unknown: !a.can_decide && decided === undefined, productName })}
        </p>
        <div className="potok-summary-flags">
          <span className="potok-summary-k">Расхождения:</span>
          {flags.length
            ? flags.map((f) => (
                <Chip key={f} tone="warning" wrap>
                  {f}
                </Chip>
              ))
            : <span>{noFlags}</span>}
        </div>
      </div>
    </section>
  );
}

// --- Факты, запросы и документы -----------------------------------------------------------------

function Facts({ app, a, empty }: { app: Application; a: Assessment | undefined; empty: boolean }) {
  const collateral = app.form?.collateral;
  const items: [string, ReactNode][] = [
    ['Сумма', money(app.amount)],
    ['Срок', months(app.term_months)],
    ['Цель', app.purpose_title],
  ];
  if (collateral?.kind) items.push(['Залог', `${collateral.description ?? COLLATERAL_TITLES[collateral.kind] ?? 'указан'}${collateral.value ? `, ${money(collateral.value)}` : ''}`]);
  // Источник — после запятой, «в месяц» — один раз в подзаголовке: подписи в узкой сетке не растягиваются на 3 строки.
  if (a?.revenue) {
    const confirmed = a.revenue.confirmed_monthly;
    items.push(
      confirmed !== null && a.revenue.source
        ? [`Выручка, ${a.revenue.source === 'fns' ? 'ФНС' : 'выписка'}`, money(confirmed)]
        : ['Выручка, ФНС', <span className="potok-muted-text">нет данных</span>],
    );
    items.push(['Выручка, со слов клиента', a.revenue.declared_monthly ? money(a.revenue.declared_monthly) : 'не указана']);
  }
  if (a) {
    if (a.monthly_profit !== null) items.push(['Прибыль, ФНС', money(a.monthly_profit)]);
    items.push(['Платежи по кредитам, БКИ', a.existing_payments !== null ? money(a.existing_payments) : '—']);
    items.push(['Платежи по кредитам, со слов клиента', a.declared_debt_payments ? money(a.declared_debt_payments) : 'не указаны']);
    if (a.revenue_limit !== null) items.push(['Лимит по выручке', money(a.revenue_limit)]);
  }
  if (empty) items.push(['Документы и запросы банка', 'нет']);
  return (
    <section className="potok-panel">
      <Title order={3}>Заявка и компания</Title>
      {a && (
        <Text fz="sm" c="dimmed" mt={4}>
          Выручка, прибыль и платежи — в месяц; платежи по данным БКИ — вместе с кредитами в нашем банке.
        </Text>
      )}
      <dl className="potok-facts">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const TASK_KIND: Record<ClientTask['kind'], string> = { document: 'Документ', field: 'Уточнение', question: 'Вопрос' };

function TaskStatus({ task }: { task: ClientTask }) {
  if (task.status === 'done') return <Chip tone="success">Выполнено{task.resolved_at ? ` ${dayMonth(task.resolved_at)}` : ''}</Chip>;
  if (task.status === 'expired') return <Chip tone="neutral">Запрос закрыт</Chip>;
  return <Chip tone="warning">Ждём ответа</Chip>;
}

function fileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${decimal(bytes / 1024 / 1024, 1)}${NBSP}МБ` : `${Math.max(1, Math.round(bytes / 1024))}${NBSP}КБ`;
}

/** Запросы банка с их статусом и ответами клиента, загруженные документы — отдельной панелью под фактами. */
function RequestsPanel({ tasks, documents }: { tasks: ClientTask[]; documents: UploadedDocument[] }) {
  const id = useId();
  if (!tasks.length && !documents.length) return null;
  return (
    <section className="potok-panel" aria-labelledby={id}>
      <Title order={3} id={id}>
        Запросы и документы
      </Title>
      {tasks.length > 0 && (
        <>
          <div className="potok-sub-h">Запросы клиенту</div>
          <ul className="potok-reqs" aria-label="Запросы клиенту">
            {tasks.map((t) => {
              const money_ = t.payload?.input === 'money' && t.answer && /^\d+$/.test(t.answer);
              const answer = money_ ? money(Number(t.answer)) : t.answer;
              return (
                <li key={t.id}>
                  <div>
                    <div className="potok-reqs-title">{t.title}</div>
                    <div className="potok-reqs-meta">
                      {t.payload?.condition === 'before_issue' ? 'Условие выдачи' : TASK_KIND[t.kind]}, отправлен {dateTime(t.created_at)}
                    </div>
                    {t.status === 'done' && answer && (
                      <div className="potok-reqs-answer">
                        {t.kind === 'document' ? 'Приложен файл' : 'Ответ клиента'}: <b>{answer}</b>
                      </div>
                    )}
                  </div>
                  <TaskStatus task={t} />
                </li>
              );
            })}
          </ul>
        </>
      )}
      {documents.length > 0 && (
        <>
          <div className="potok-sub-h">Документы</div>
          <ul className="potok-reqs" aria-label="Документы">
            {documents.map((d) => (
              <li key={d.id}>
                <div className="potok-reqs-title potok-reqs-file">{d.filename}</div>
                <div className="potok-reqs-meta potok-reqs-side">
                  {DOCUMENT_KINDS[d.kind] ?? 'Документ'}, {fileSize(d.size_bytes)}, {dateTime(d.created_at)}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// --- Оценка, условия, трасса --------------------------------------------------------------------

/**
 * Условия: что просит клиент, что предложил бы конвейер и что в итоге предложено клиенту. Нагрузка — одна величина
 * из оценки банка.
 */
function TermsTable({ app, a }: { app: Application; a: Assessment }) {
  const offer = app.offer;
  const columns: { title: string; terms: Terms }[] = [{ title: 'Клиент просит', terms: a.requested }];
  if (a.recommendation) columns.push({ title: 'Конвейер предлагает', terms: a.recommendation });
  if (offer) columns.push({ title: 'Предложено', terms: termsFor(a, offer.amount, offer.term_months, offer.rate, offer.monthly_payment) });
  // Порог — отдельной строкой под названием, чтобы подпись не растягивалась на 4–5 строк в узкой колонке.
  const rows: { label: string; hint?: string; render: (t: Terms) => ReactNode }[] = [
    { label: 'Сумма', render: (t) => money(t.amount) },
    { label: 'Срок', render: (t) => months(t.term_months) },
    { label: 'Ставка', render: (t) => rate(t.rate) },
    { label: 'Платёж в месяц', render: (t) => money(t.monthly_payment) },
    { label: 'Нагрузка на выручку', hint: `лимит${NBSP}${percent(a.max_dsr, 0)}`, render: (t) => <Load value={t.dsr} max={a.max_dsr} /> },
    {
      label: 'Покрытие платежа прибылью',
      hint: `минимум${NBSP}×${decimal(a.min_coverage, 1)}`,
      render: (t) => <Coverage value={t.coverage} min={a.min_coverage} />,
    },
  ];
  return (
    <div className="potok-terms-wrap">
      <Table className="potok-terms" withRowBorders verticalSpacing={10} aria-label="Условия">
        <Table.Thead>
          <Table.Tr>
            <Table.Th />
            {columns.map((c) => (
              <Table.Th key={c.title} ta="right">
                {c.title}
              </Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map(({ label, hint, render }) => (
            <Table.Tr key={label}>
              <Table.Td c="dimmed">
                {label}
                {hint && <span className="potok-terms-hint">{hint}</span>}
              </Table.Td>
              {columns.map((c) => (
                <Table.Td key={c.title} ta="right">
                  {render(c.terms)}
                </Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

function AssessmentPanel({ a }: { a: Assessment }) {
  const [stopsOpen, setStopsOpen] = useState(false);
  const factors = [...a.factors].sort((x, y) => y.points - x.points);
  const maxPoints = Math.max(1, ...factors.map((f) => Math.abs(f.points)));
  const failed = a.stop_checks.filter((c) => !c.passed);
  if (!a.scored) {
    return (
      <section className="potok-panel">
        <Title order={3}>Оценка</Title>
        <Text c="dimmed" mt="sm">
          Оценки ещё нет{a.failed_sources.length ? `: не ответили ${a.failed_sources.join(', ')}` : ''}.
        </Text>
      </section>
    );
  }
  return (
    <section className="potok-panel">
      <Title order={3}>Оценка</Title>
      <div className="potok-grade">
        <span className="potok-grade-g">Грейд {a.grade}</span>
        <span>
          балл <b>{a.score}</b> из{NBSP}100
        </span>
        {/* Вероятность дефолта не считается по заявке — это справочное значение, закреплённое за грейдом. */}
        {a.probability_default !== null && (
          <span className="potok-muted-text">
            ориентир для грейда — вероятность дефолта около {percent(a.probability_default, 0)}
          </span>
        )}
      </div>
      <div className="potok-factors">
        {factors.map((f) => (
          <div key={f.code} className="potok-factor">
            <div>
              {f.title}
              {/* Нагрузку показываем одной величиной — в таблице условий; здесь только вклад фактора. */}
              {f.code !== 'debt_load' && <span>{f.value}</span>}
            </div>
            <div className="potok-factor-bar">
              <i
                data-sign={f.points >= 0 ? 'plus' : 'minus'}
                style={{ width: `${(Math.abs(f.points) / maxPoints) * 50}%` }}
              />
            </div>
            <div className="potok-factor-p num">{f.points > 0 ? `+${f.points}` : f.points < 0 ? `−${-f.points}` : '0'}</div>
          </div>
        ))}
      </div>
      <div className="potok-stops">
        <Group gap="sm">
          <Chip tone={failed.length ? 'danger' : 'success'}>
            {failed.length ? `Стоп-факторы: не пройдено ${failed.length}` : `Стоп-факторы пройдены: ${a.stop_checks.length} из ${a.stop_checks.length}`}
          </Chip>
          <Button variant="subtle" size="compact-sm" px={0} onClick={() => setStopsOpen((o) => !o)} aria-expanded={stopsOpen}>
            {stopsOpen ? 'Скрыть' : 'Показать'}
          </Button>
        </Group>
        <Collapse in={stopsOpen || failed.length > 0}>
          <ul className="potok-checks">
            {a.stop_checks.map((c) => (
              <li key={c.title} data-ok={c.passed}>
                {c.passed ? <IconCheck size={14} /> : <IconX size={14} />}
                {c.title}
              </li>
            ))}
          </ul>
        </Collapse>
      </div>
    </section>
  );
}

const TRACE_ICON: Record<TraceStep['result'], ReactNode> = {
  pass: <IconCheck size={14} />,
  fail: <IconX size={14} />,
  info: <IconInfoCircle size={14} />,
  triggered: <IconInfoCircle size={14} />,
};

/**
 * Как конвейер принял решение: правила по порядку (стоп-факторы — уже в оценке) и воспроизведение. Пока решение не
 * принято, правила раскрыты, а непройденное правило выделено.
 */
function TracePanel({ app, a }: { app: Application; a: Assessment }) {
  const replay = useReplay(app.id);
  const [open, setOpen] = useState(a.can_decide);
  if (!a.scored) return null;
  const steps = a.trace.filter((s) => !s.title.startsWith('Стоп-фактор'));
  const failed = steps.filter((s) => s.result === 'fail' && s.title !== 'Итог').length;
  return (
    <section className="potok-panel">
      <Group justify="space-between" align="center" gap="sm">
        <Title order={3}>Как принималось решение</Title>
        <Button variant="default" size="md" leftSection={<IconRepeat size={16} />} loading={replay.isPending} onClick={() => replay.mutate()}>
          Воспроизвести решение
        </Button>
      </Group>
      <Text fz="sm" c="dimmed" mt={4}>
        {steps.length} {plural(steps.length, ['правило', 'правила', 'правил'])}, {policyName(a.policy_version)} — ровно те проверки, что
        прошла заявка{failed ? `; не пройдено: ${failed}` : ''}.
      </Text>
      {replay.error && (
        <Alert mt="md" radius="md" variant="light" color="red">
          {replay.error instanceof ApiError ? replay.error.message : 'Не удалось воспроизвести решение'}
        </Alert>
      )}
      {replay.data && (
        <div className="potok-inline-note" data-tone={replay.data.matches ? 'ok' : 'warn'}>
          {replay.data.matches
            ? `Совпадает: на сохранённых признаках ${policyName(replay.data.policy_version_current)} дают тот же исход, грейд и условия.`
            : `Расхождение с сохранённым решением (${policyName(replay.data.policy_version_stored)} и ${policyName(replay.data.policy_version_current)}): ${replay.data.differences.join('; ')}.`}
        </div>
      )}
      <Button variant="subtle" px={0} mt="xs" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? 'Скрыть правила' : 'Показать правила'}
      </Button>
      <Collapse in={open}>
        <ul className="potok-trace">
          {steps.map((s, i) => (
            <li key={i} data-result={s.result}>
              {TRACE_ICON[s.result]}
              <div>
                <Text fz="sm" fw={s.result === 'fail' ? 600 : 500}>
                  {s.title}
                </Text>
                <Text fz="xs" c={s.result === 'fail' ? undefined : 'dimmed'}>
                  {s.detail}
                </Text>
              </div>
            </li>
          ))}
        </ul>
      </Collapse>
    </section>
  );
}

function SourcesPanel({ app }: { app: Application }) {
  const checks = useChecks(app.id, app);
  if (!checks.data?.length) return null;
  return (
    <section className="potok-panel">
      <Title order={3}>Ответы источников</Title>
      <ul className="potok-checks">
        {checks.data.map((c) => (
          <li key={c.source} data-ok={c.status === 'ok'}>
            {c.status === 'ok' ? <IconCheck size={14} /> : <IconX size={14} />}
            {c.title}: {c.status === 'ok' ? 'данные получены' : c.status === 'failed' ? 'не ответил' : 'в очереди'}
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- Решение ------------------------------------------------------------------------------------

interface PreviewProps {
  app: Application;
  a: Assessment;
  outcome: DecisionOutcome;
  amount: number;
  term: number;
  ratePct: number;
  payment: number;
  message: string;
  secured: boolean;
  taskKind: 'document' | 'question';
  taskTitle: string;
  reason: string;
  tip: string;
}

/** «Клиент увидит» — те же заголовок, цифры и причины, что появятся у клиента после сохранения решения. */
function ClientPreview({ app, a, outcome, amount, term, ratePct, payment, message, secured, taskKind, taskTitle, reason, tip }: PreviewProps) {
  const id = useId();
  const text = message.trim() || DEFAULT_MESSAGE[outcome];
  const validUntil = new Date(Date.now() + OFFER_VALID_DAYS * 86_400_000).toISOString();
  let body: ReactNode;
  if (outcome === 'approve' || outcome === 'counter_offer') {
    const interestOnly = a.repayment === 'interest_only';
    body = (
      <>
        <div className="potok-preview-say">{outcome === 'approve' ? OUTCOME.approved : OUTCOME.counter_offer}</div>
        <div className="potok-preview-big">{money(amount)}</div>
        <div className="potok-preview-terms">
          {interestOnly ? 'лимит ' : ''}на {months(term)} под {rate(ratePct)} годовых, {interestOnly ? 'проценты' : 'платёж'} {money(payment)} в{NBSP}месяц
        </div>
        {outcome === 'counter_offer' && (
          <div className="potok-preview-terms">
            Просил {money(app.amount)} на {months(app.term_months)}
          </div>
        )}
        <div className="potok-preview-block">
          <b>{outcome === 'approve' ? REASONS_TITLE.approved : REASONS_TITLE.counter_offer}</b>
          {typo(text)}
        </div>
        <ul className="potok-preview-notes">
          <li>
            Предложение действует {OFFER_VALID_DAYS}
            {NBSP}
            {plural(OFFER_VALID_DAYS, ['день', 'дня', 'дней'])}, до {dayMonth(validUntil)}
          </li>
          {secured && <li>После принятия: документы по залогу и поручительство собственника</li>}
        </ul>
      </>
    );
  } else if (outcome === 'request_info') {
    body = (
      <>
        <div className="potok-preview-say">Банк просит уточнить</div>
        <div className="potok-preview-block">
          <b>{taskKind === 'document' ? 'Загрузить документ' : 'Ответить на вопрос'}</b>
          {taskTitle.trim() || <span className="potok-muted-text">Опишите выше, что нужно от клиента</span>}
        </div>
        <div className="potok-preview-block">
          <b>Сообщение в истории заявки</b>
          {typo(text)}
        </div>
        <ul className="potok-preview-notes">
          <li>Как только клиент ответит, проверка продолжится автоматически</li>
        </ul>
      </>
    );
  } else if (outcome === 'reject') {
    // Отказ специалиста — не стоп-фактор: без подсказки у клиента просто нет раздела «Что можно сделать».
    body = (
      <>
        <div className="potok-preview-say">Банк не может выдать этот кредит сейчас</div>
        <div className="potok-preview-block">
          <b>{REASONS_TITLE.rejected}</b>
          {reason.trim() ? typo(reason) : <span className="potok-muted-text">Укажите причину выше</span>}
        </div>
        {tip.trim() && (
          <div className="potok-preview-block">
            <b>Что можно сделать</b>
            {typo(tip)}
          </div>
        )}
      </>
    );
  } else {
    body = (
      <>
        <div className="potok-preview-say">Проверка компании</div>
        <div className="potok-preview-block">
          Банк повторно запрашивает {a.failed_sources.join(', ') || 'данные'} — статус обновится сам.
        </div>
      </>
    );
  }
  return (
    <section className="potok-preview" aria-labelledby={id}>
      <div className="potok-preview-label" id={id}>
        Клиент увидит
      </div>
      <div className="potok-preview-card">{body}</div>
    </section>
  );
}

function DecisionForm({ app, a }: { app: Application; a: Assessment }) {
  const decide = useAnalystDecision(app.id);
  const products = useProducts();
  const secured = !!products.data?.find((p) => p.code === app.product.code)?.collateral;
  const rec = a.recommendation ?? a.requested;
  const sameAsRequest = rec.amount === a.requested.amount && rec.term_months === a.requested.term_months;
  const negatives = [...a.factors].filter((f) => f.points < 0).sort((x, y) => x.points - y.points);
  // По умолчанию — то, что предложил бы конвейер: одобрение, если рекомендация совпадает с запросом, иначе контрпредложение.
  const [outcome, setOutcome] = useState<DecisionOutcome>(
    !a.scored ? 'retry_checks' : !a.recommendation ? 'reject' : !sameAsRequest ? 'counter_offer' : 'approve',
  );
  // Для контрпредложения по умолчанию — рекомендация конвейера, а если она совпадает с запросом — меньшая сумма.
  const [amount, setAmount] = useState<number>(
    sameAsRequest ? Math.max(a.product_limits.min_amount, Math.floor((rec.amount * 0.8) / 50_000) * 50_000) : rec.amount,
  );
  const [term, setTerm] = useState<number>(rec.term_months);
  const [taskKind, setTaskKind] = useState<'document' | 'question'>('document');
  const [rateValue, setRateValue] = useState<number>(a.min_rate ?? rec.rate);
  const [comment, setComment] = useState('');
  // Сообщение клиенту составляется по условиям и пересчитывается вместе с ними, пока аналитик не изменит его сам.
  const [ownMessage, setOwnMessage] = useState<string | null>(null);
  // Причина отказа и подсказка — как у отказа конвейера: самый сильный минус оценки и что с ним сделать.
  const [reason, setReason] = useState(negatives[0]?.client_text ?? '');
  const [tip, setTip] = useState(negatives.find((f) => f.tip)?.tip ?? '');
  const [taskTitle, setTaskTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setError(null), [outcome]);

  const offerAmount = outcome === 'approve' ? app.amount : amount;
  const offerTerm = outcome === 'approve' ? app.term_months : term;
  const calc = termsFor(a, offerAmount, offerTerm, rateValue);
  const message = ownMessage ?? autoMessage(outcome, app, a, offerAmount, offerTerm, rateValue);
  const deviates =
    !a.recommendation || offerAmount > a.recommendation.amount || offerTerm !== a.recommendation.term_months || rateValue !== a.recommendation.rate;
  const options = OUTCOMES.filter((o) =>
    o.value === 'retry_checks' ? a.failed_sources.length > 0 : a.scored || ['request_info', 'reject'].includes(o.value),
  );

  const submit = () => {
    setError(null);
    decide.mutate(
      {
        outcome,
        comment,
        client_message: message.trim() || undefined,
        ...(outcome === 'approve' || outcome === 'counter_offer' ? { rate: rateValue } : {}),
        ...(outcome === 'counter_offer' ? { amount, term_months: term } : {}),
        ...(outcome === 'reject' ? { reasons: reason ? [reason] : [], tips: tip ? [tip] : [] } : {}),
        ...(outcome === 'request_info' ? { task_kind: taskKind, task_title: taskTitle } : {}),
      },
      {
        // В errors[] сказано, какое поле неверно, — это точнее общего detail.
        onError: (e) =>
          setError(e instanceof ApiError ? (e.errors?.length ? e.errors.map((x) => x.message).join('. ') : e.message) : 'Не удалось сохранить решение'),
      },
    );
  };

  return (
    <section className="potok-panel" id="decision">
      <Title order={3}>Решение по заявке</Title>
      {/* Исходы — сеткой в две колонки: в узкой панели сегменты в одну строку не помещаются. */}
      <Radio.Group value={outcome} onChange={(v) => setOutcome(v as DecisionOutcome)} aria-label="Исход">
        <div className="potok-outcomes">
          {options.map((o) => (
            <Radio.Card key={o.value} value={o.value} className="potok-outcome">
              {o.label}
            </Radio.Card>
          ))}
        </div>
      </Radio.Group>
      <Stack mt="md" gap="md">
        {(outcome === 'approve' || outcome === 'counter_offer') && (
          <>
            <div className="potok-decide-terms">
              <MoneyInput
                label="Сумма"
                value={offerAmount}
                onChange={(v) => setAmount(Number(v) || 0)}
                disabled={outcome === 'approve'}
                step={50_000}
                min={a.product_limits.min_amount}
                max={a.product_limits.max_amount}
              />
              <MoneyInput
                label="Срок"
                unit="мес."
                thousandSeparator={undefined}
                value={offerTerm}
                onChange={(v) => setTerm(Number(v) || 0)}
                disabled={outcome === 'approve'}
                min={a.product_limits.min_term}
                max={a.product_limits.max_term}
              />
              <NumberInput
                label="Ставка"
                value={rateValue}
                onChange={(v) => setRateValue(Number(v) || 0)}
                decimalScale={2}
                decimalSeparator=","
                step={0.5}
                min={a.min_rate ?? 0.01}
                max={99.99}
                rightSection={<span className="potok-unit">%</span>}
                rightSectionPointerEvents="none"
              />
            </div>
            <div className="potok-calc">
              <span>
                Платёж <b>{money(calc.monthly_payment)}</b>
              </span>
              <span>
                Нагрузка <b><Load value={calc.dsr} max={a.max_dsr} /></b>
              </span>
              <span>
                Покрытие <b><Coverage value={calc.coverage} min={a.min_coverage} /></b>
              </span>
            </div>
            {deviates && (
              <Text fz="sm" c="dimmed">
                {a.recommendation ? 'Отклонение от рекомендации конвейера' : 'Конвейер не предложил условий'} — будет отмечено в журнале.
              </Text>
            )}
          </>
        )}
        {outcome === 'request_info' && (
          <>
            <SegmentedControl
              value={taskKind}
              onChange={(v) => setTaskKind(v as 'document' | 'question')}
              data={[
                { value: 'document', label: 'Загрузить документ' },
                { value: 'question', label: 'Ответить на вопрос' },
              ]}
            />
            <TextInput
              label="Что нужно от клиента"
              placeholder="Например: договор поставки оборудования"
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.currentTarget.value)}
              maxLength={255}
            />
          </>
        )}
        {outcome === 'reject' && (
          <>
            <TextInput label="Причина отказа для клиента" value={reason} onChange={(e) => setReason(e.currentTarget.value)} maxLength={300} />
            <TextInput label="Что можно улучшить, необязательно" value={tip} onChange={(e) => setTip(e.currentTarget.value)} maxLength={300} />
          </>
        )}
        <Textarea
          label="Обоснование для журнала аудита"
          description="Обязательно, не меньше 10 знаков. Клиент его не видит."
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
          maxLength={2000}
          autosize
          minRows={2}
        />
        <Textarea
          label="Сообщение клиенту"
          description={
            ownMessage === null ? (
              'Составлено по условиям решения и меняется вместе с ними, пока вы не измените текст.'
            ) : (
              <>
                Текст изменён вручную.{' '}
                <Anchor component="button" type="button" fz="inherit" onClick={() => setOwnMessage(null)}>
                  Вернуть текст по условиям
                </Anchor>
              </>
            )
          }
          value={message}
          onChange={(e) => setOwnMessage(e.currentTarget.value)}
          maxLength={1000}
          autosize
          minRows={2}
        />
        <ClientPreview
          app={app}
          a={a}
          outcome={outcome}
          amount={offerAmount}
          term={offerTerm}
          ratePct={rateValue}
          payment={calc.monthly_payment}
          message={message}
          secured={secured}
          taskKind={taskKind}
          taskTitle={taskTitle}
          reason={reason}
          tip={tip}
        />
        {error && (
          <Alert color="red" variant="light" radius="md">
            {error}
          </Alert>
        )}
        <Button size="lg" fullWidth onClick={submit} loading={decide.isPending} disabled={comment.trim().length < 10}>
          Сохранить решение
        </Button>
      </Stack>
    </section>
  );
}

/** Состояние предложения у клиента: ждём ответа, принято, подписано, отказ, истекло. */
function OfferState({ offer }: { offer: Offer }) {
  switch (offer.status) {
    case 'active':
      return <Chip tone="info" wrap>{offer.valid_until ? `Ждём ответа клиента до ${dayMonth(offer.valid_until)}` : 'Ждём ответа клиента'}</Chip>;
    case 'accepted':
      return <Chip tone="info">Принято</Chip>;
    case 'signed':
      return (
        <Chip tone="success" wrap>
          {offer.contract_number ? <>Подписано, договор №{NBSP}{nb(offer.contract_number)}</> : 'Подписано'}
        </Chip>
      );
    case 'declined':
      return <Chip tone="neutral">Клиент отказался</Chip>;
    case 'expired':
      return <Chip tone="neutral">Истекло</Chip>;
  }
}

/** Решение принято — вместо формы: что предложено и в каком оно состоянии, кто и когда решил, обоснование. */
function DecidedPanel({ app, events }: { app: Application; events?: ApplicationEvent[] }) {
  const id = useId();
  const products = useProducts();
  const offer = app.offer;
  const code = app.status.code;
  if (!offer && code !== 'rejected' && code !== 'needs_info') return null;
  const ev = decisionEvent(app, events);
  const byAnalyst = ev?.event === 'analyst_decision';
  const otherProduct = offer && offer.product_code !== app.product.code ? products.data?.find((p) => p.code === offer.product_code)?.name : null;
  return (
    <section className="potok-panel" aria-labelledby={id}>
      <Group justify="space-between" align="center" gap="sm">
        <Title order={3} id={id}>
          Решение
        </Title>
        <StatusChip app={app} />
      </Group>
      {offer ? (
        <>
          <Text mt="md" fw={500}>
            Предложено: {otherProduct ? <>{nb(`«${otherProduct}»`)}, </> : null}
            {money(offer.amount)} на {months(offer.term_months)} под {rate(offer.rate)}, платёж {money(offer.monthly_payment)} в{NBSP}месяц
          </Text>
          <div className="potok-decided-state">
            <OfferState offer={offer} />
          </div>
        </>
      ) : code === 'needs_info' ? (
        <>
          <Text mt="md" fw={500}>
            Запрошено у клиента: {typo((app.decision?.reasons ?? []).join('; ') || 'дополнительная информация')}
          </Text>
          <div className="potok-decided-state">
            <Chip tone="warning">Ждём ответа клиента</Chip>
          </div>
        </>
      ) : (
        <>
          <Text mt="md" fw={500}>
            Отказано
          </Text>
          {app.decision && app.decision.reasons.length > 0 && (
            <ul className="potok-list">
              {app.decision.reasons.map((r) => (
                <li key={r}>{typo(r)}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {ev && (
        <Text fz="sm" mt="md">
          Решение: {byAnalyst ? (ev.actor_name ?? 'специалист банка') : 'конвейер автоматически'}, {dateTime(ev.created_at)}
        </Text>
      )}
      {byAnalyst && ev.internal_comment && (
        <Text fz="sm" c="dimmed" mt={4}>
          Обоснование: {ev.internal_comment}
        </Text>
      )}
      {byAnalyst && ev.comment && (
        <Text fz="sm" c="dimmed" mt={4}>
          Сообщение клиенту: «{typo(ev.comment)}»
        </Text>
      )}
    </section>
  );
}

/**
 * Карточка аналитика. Слева сверху — сводка (почему заявка у специалиста, рекомендация, расхождения), затем статус,
 * факты, запросы и документы, оценка и условия. Пока заявка ждёт решения, справа — липкая панель решения
 * с предпросмотром для клиента, а трасса, источники и история — слева; после решения справа — итог решения,
 * трасса, источники и история.
 */
export function AnalystCard({
  app,
  back,
  events,
  tasks,
  documents,
}: {
  app: Application;
  back: ReactNode;
  events?: ApplicationEvent[];
  tasks?: ClientTask[];
  documents?: UploadedDocument[];
}) {
  const assessment = useAssessment(app.id, app.status.code !== 'draft');
  const a = assessment.data;
  const [sideRef, sideTop] = useStickyTop();
  const waiting = app.allowed_actions.includes('decide') && app.submitted_at;
  // Раскладка известна до загрузки оценки — по разрешённым действиям; после — по праву решать эту заявку.
  const deciding = a ? a.can_decide : app.allowed_actions.includes('decide');
  const nothingAttached = !!tasks && !!documents && tasks.length === 0 && documents.length === 0;
  const trace = a && <TracePanel app={app} a={a} />;
  const history = (
    <section className="potok-panel">
      <Title order={3}>История</Title>
      {events && <History events={events} bank />}
    </section>
  );
  return (
    <div className="potok-col">
      <div>
        {back}
        <Group mt="sm" gap="sm" align="center">
          <Title order={1}>{app.company.name}</Title>
          <StatusChip app={app} />
          {waiting && <Chip tone="neutral" dot={false}>В очереди {duration(Date.now() - new Date(app.submitted_at!).getTime())}</Chip>}
        </Group>
        <Text c="dimmed" mt={4} fz="sm">
          Заявка {nb(app.number)}, {nb(app.product.name)}, ИНН{NBSP}{app.company.inn}
        </Text>
      </div>
      <div className="potok-analyst">
        <div className="potok-col">
          {assessment.isLoading ? <Skeleton h={132} radius="lg" /> : a && <Summary app={app} a={a} events={events} />}
          <section className="potok-panel">
            {/* Действие аналитика — панель решения рядом (на телефоне — кнопка-якорь внизу), здесь без кнопки. */}
            <StatusBlock app={app} action={false} />
          </section>
          <Facts app={app} a={a} empty={nothingAttached} />
          <RequestsPanel tasks={tasks ?? []} documents={documents ?? []} />
          {assessment.isLoading ? (
            <Skeleton h={240} radius="lg" />
          ) : (
            a && (
              <>
                <AssessmentPanel a={a} />
                {a.scored && <RiskPanel id={app.id} />}
                {a.scored && (
                  <section className="potok-panel">
                    <Title order={3}>Условия</Title>
                    <TermsTable app={app} a={a} />
                    <Text fz="sm" c="dimmed" mt="sm">
                      Ставка для грейда — от {a.min_rate !== null ? rate(a.min_rate) : '—'}, полномочия аналитика — до {money(a.authority_limit)}.
                    </Text>
                  </section>
                )}
              </>
            )
          )}
          {deciding && (
            <>
              {trace}
              <SourcesPanel app={app} />
              {history}
            </>
          )}
        </div>
        {deciding ? (
          <div className="potok-analyst-side" ref={sideRef} style={{ top: sideTop }}>
            {a ? <DecisionForm key={app.status.code} app={app} a={a} /> : <Skeleton h={480} radius={24} />}
          </div>
        ) : (
          <div className="potok-col">
            <DecidedPanel app={app} events={events} />
            {trace}
            <SourcesPanel app={app} />
            {history}
          </div>
        )}
      </div>
      {a?.can_decide && (
        <div className="potok-bottombar potok-phone-only">
          <Button component="a" href="#decision" size="lg" fullWidth>
            Принять решение
          </Button>
        </div>
      )}
    </div>
  );
}
