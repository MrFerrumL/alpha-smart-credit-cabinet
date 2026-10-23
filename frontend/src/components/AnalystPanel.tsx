import { Alert, Button, Collapse, Group, NumberInput, Radio, SegmentedControl, Skeleton, Stack, Table, Text, TextInput, Textarea, Title } from '@mantine/core';
import { IconCheck, IconInfoCircle, IconRepeat, IconX } from '@tabler/icons-react';
import { useEffect, useState, type ReactNode } from 'react';

import { ApiError } from '../api/client';
import { useAnalystDecision, useAssessment, useChecks, useReplay } from '../api/hooks';
import type { Application, ApplicationEvent, Assessment, DecisionOutcome, Terms, TraceStep } from '../api/types';
import { monthlyPayment } from '../lib/finance';
import { NBSP, decimal, duration, money, months, percent, rate } from '../lib/format';
import { nb } from '../lib/nobreak';
import { History } from './History';
import { MoneyInput } from './Money';
import { Chip, StatusBlock, StatusChip } from './Status';

const OUTCOMES: { value: DecisionOutcome; label: string }[] = [
  { value: 'approve', label: 'Одобрить' },
  { value: 'counter_offer', label: 'Контрпредложение' },
  { value: 'request_info', label: 'Запросить документы' },
  { value: 'reject', label: 'Отказать' },
  { value: 'retry_checks', label: 'Повторить проверки' },
];

/** Версия правил по-человечески: в интерфейсе нет технических номеров. */
export function policyName(version: string | null | undefined): string {
  if (version === 'policy-1.1') return 'правила от 22 октября';
  if (version === 'policy-1.0') return 'прежние правила';
  return 'правила банка';
}

function Load({ value, max }: { value: number | null; max: number }) {
  if (value === null) return <span className="potok-muted-text">—</span>;
  return <span className={value > max ? 'potok-bad' : undefined}>{percent(value)}</span>;
}

function Coverage({ value, min }: { value: number | null; min: number }) {
  if (value === null) return <span className="potok-muted-text">нет данных ФНС</span>;
  return <span className={value < min ? 'potok-bad' : undefined}>×{decimal(value, 2)}</span>;
}

/** Условия: что просит клиент и что предложил бы конвейер. Нагрузка — одна величина из оценки банка. */
function TermsTable({ a }: { a: Assessment }) {
  const rec = a.recommendation;
  const rows: [string, (t: Terms) => ReactNode][] = [
    ['Сумма', (t) => money(t.amount)],
    ['Срок', (t) => months(t.term_months)],
    ['Ставка', (t) => rate(t.rate)],
    ['Платёж в месяц', (t) => money(t.monthly_payment)],
    [`Нагрузка на выручку, лимит ${percent(a.max_dsr, 0)}`, (t) => <Load value={t.dsr} max={a.max_dsr} />],
    [`Покрытие платежа прибылью, минимум ×${decimal(a.min_coverage, 1)}`, (t) => <Coverage value={t.coverage} min={a.min_coverage} />],
  ];
  return (
    <Table withRowBorders verticalSpacing={10} aria-label="Условия">
      <Table.Thead>
        <Table.Tr>
          <Table.Th />
          <Table.Th ta="right">Клиент просит</Table.Th>
          {rec && <Table.Th ta="right">Конвейер предлагает</Table.Th>}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map(([label, render]) => (
          <Table.Tr key={label}>
            <Table.Td c="dimmed">{label}</Table.Td>
            <Table.Td ta="right">{render(a.requested)}</Table.Td>
            {rec && <Table.Td ta="right">{render(rec)}</Table.Td>}
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function Facts({ app, a }: { app: Application; a: Assessment | undefined }) {
  const collateral = app.form?.collateral;
  const items: [string, ReactNode][] = [
    ['Сумма', money(app.amount)],
    ['Срок', months(app.term_months)],
    ['Цель', app.purpose_title],
  ];
  if (collateral?.kind) items.push(['Залог', `${collateral.description ?? 'указан'}${collateral.value ? `, ${money(collateral.value)}` : ''}`]);
  if (a?.revenue) {
    items.push([`Выручка в месяц ${a.revenue.source === 'fns' ? 'по ФНС' : 'по выписке'}`, a.revenue.confirmed_monthly ? money(a.revenue.confirmed_monthly) : '—']);
    items.push(['Выручка в месяц со слов клиента', a.revenue.declared_monthly ? money(a.revenue.declared_monthly) : 'не указана']);
  }
  if (a) {
    if (a.monthly_profit !== null) items.push(['Прибыль в месяц по ФНС', money(a.monthly_profit)]);
    items.push(['Платежи по кредитам в месяц: БКИ и наш банк', a.existing_payments !== null ? money(a.existing_payments) : '—']);
    items.push(['Платежи по кредитам в месяц со слов клиента', a.declared_debt_payments ? money(a.declared_debt_payments) : 'не указаны']);
    if (a.revenue_limit !== null) items.push(['Лимит по выручке', money(a.revenue_limit)]);
  }
  return (
    <section className="potok-panel">
      <Title order={3}>Заявка и компания</Title>
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
        {a.probability_default !== null && <span className="potok-muted-text">вероятность дефолта {percent(a.probability_default, 0)}</span>}
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

/** Как конвейер принял решение: правила по порядку (стоп-факторы — уже в оценке) и воспроизведение. */
function TracePanel({ app, a }: { app: Application; a: Assessment }) {
  const replay = useReplay(app.id);
  const [open, setOpen] = useState(false);
  if (!a.scored) return null;
  const steps = a.trace.filter((s) => !s.title.startsWith('Стоп-фактор'));
  return (
    <section className="potok-panel">
      <Group justify="space-between" align="center" gap="sm">
        <Title order={3}>Как принималось решение</Title>
        <Button variant="default" size="md" leftSection={<IconRepeat size={16} />} loading={replay.isPending} onClick={() => replay.mutate()}>
          Воспроизвести решение
        </Button>
      </Group>
      <Text fz="sm" c="dimmed" mt={4}>
        {steps.length} правил, {policyName(a.policy_version)} — ровно те проверки, что прошла заявка.
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
                <Text fz="sm" fw={500}>
                  {s.title}
                </Text>
                <Text fz="xs" c="dimmed">
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

function DecisionForm({ app, a }: { app: Application; a: Assessment }) {
  const decide = useAnalystDecision(app.id);
  const rec = a.recommendation ?? a.requested;
  const sameAsRequest = rec.amount === a.requested.amount && rec.term_months === a.requested.term_months;
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
  const [clientMessage, setClientMessage] = useState('');
  const [reason, setReason] = useState('');
  const [tip, setTip] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setError(null), [outcome]);

  const offerAmount = outcome === 'approve' ? app.amount : amount;
  const offerTerm = outcome === 'approve' ? app.term_months : term;
  const payment = monthlyPayment(offerAmount, rateValue, offerTerm, a.repayment);
  const revenue = a.revenue?.confirmed_monthly ?? null;
  const dsr = revenue ? ((a.existing_payments ?? 0) + payment) / revenue : null;
  const cover = a.monthly_profit !== null && payment > 0 ? a.monthly_profit / payment : null;
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
        client_message: clientMessage || undefined,
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
                Платёж <b>{money(Math.round(payment))}</b>
              </span>
              <span>
                Нагрузка <b><Load value={dsr} max={a.max_dsr} /></b>
              </span>
              <span>
                Покрытие <b><Coverage value={cover} min={a.min_coverage} /></b>
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
          label="Сообщение клиенту, необязательно"
          value={clientMessage}
          onChange={(e) => setClientMessage(e.currentTarget.value)}
          maxLength={1000}
          autosize
          minRows={1}
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

/** Решение уже принято — коротко, кто и что решил. */
function DecidedPanel({ app }: { app: Application }) {
  const d = app.decision;
  if (!d) return null;
  return (
    <section className="potok-panel">
      <Title order={3}>Решение</Title>
      <Group mt="sm" gap="sm">
        <StatusChip app={app} />
      </Group>
      {d.reasons.length > 0 && (
        <ul className="potok-list">
          {d.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Карточка аналитика: слева факты, оценка, условия и трасса; справа — решение (липкое, в первом экране) и
 * история. Клиентских текстов здесь нет.
 */
export function AnalystCard({ app, back, events }: { app: Application; back: ReactNode; events?: ApplicationEvent[] }) {
  const assessment = useAssessment(app.id, app.status.code !== 'draft');
  const a = assessment.data;
  const waiting = app.allowed_actions.includes('decide') && app.submitted_at;
  return (
    <Stack gap="lg">
      <div>
        {back}
        <Group mt="sm" gap="sm" align="center">
          <Title order={1}>{app.company.name}</Title>
          <StatusChip app={app} />
          {waiting && <Chip tone="neutral" dot={false}>В очереди {duration(Date.now() - new Date(app.submitted_at!).getTime())}</Chip>}
        </Group>
        <Text c="dimmed" mt={4} fz="sm">
          Заявка {nb(app.number)}, {nb(app.product.name.toLowerCase())}, ИНН{NBSP}{app.company.inn}
        </Text>
      </div>
      <div className="potok-analyst">
        <Stack gap="lg">
          <section className="potok-panel">
            {/* Действие аналитика — панель решения рядом (на телефоне — кнопка-якорь внизу), здесь без кнопки. */}
            <StatusBlock app={app} action={false} />
          </section>
          <Facts app={app} a={a} />
          {assessment.isLoading ? (
            <Skeleton h={240} radius="lg" />
          ) : (
            a && (
              <>
                <AssessmentPanel a={a} />
                {a.scored && (
                  <section className="potok-panel">
                    <Title order={3}>Условия</Title>
                    <TermsTable a={a} />
                    <Text fz="sm" c="dimmed" mt="sm">
                      Ставка для грейда — от {a.min_rate !== null ? rate(a.min_rate) : '—'}, полномочия аналитика — до {money(a.authority_limit)}.
                    </Text>
                  </section>
                )}
                <TracePanel app={app} a={a} />
              </>
            )
          )}
          <SourcesPanel app={app} />
        </Stack>
        <Stack gap="lg" className="potok-analyst-side">
          {a?.can_decide ? <DecisionForm key={app.status.code} app={app} a={a} /> : <DecidedPanel app={app} />}
          <section className="potok-panel">
            <Title order={3}>История</Title>
            {events && <History events={events} bank />}
          </section>
        </Stack>
      </div>
      {a?.can_decide && (
        <div className="potok-bottombar potok-phone-only">
          <Button component="a" href="#decision" size="lg" fullWidth>
            Принять решение
          </Button>
        </div>
      )}
    </Stack>
  );
}
