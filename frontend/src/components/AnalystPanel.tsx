import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  NumberInput,
  SegmentedControl,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconArrowRight, IconCheck, IconGavel, IconInfoCircle, IconRepeat, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { ApiError } from '../api/client';
import { useAnalystDecision, useAssessment, useReplay } from '../api/hooks';
import type { Application, Assessment, DecisionOutcome, Terms, TraceStep } from '../api/types';
import { monthlyPayment } from '../lib/finance';
import { money, moneyShort, months, rate } from '../lib/format';
import { Stat } from './ui';

const GRADE_COLOR: Record<string, string> = { A: 'teal', B: 'green', C: 'yellow', D: 'orange', E: 'red' };

const REASON_COLOR: Record<NonNullable<Assessment['review_reason']>, string> = {
  manual_product: 'blue',
  grade: 'yellow',
  source_failure: 'orange',
  pipeline_failure: 'red',
  other: 'gray',
};

const OUTCOMES: { value: DecisionOutcome; label: string }[] = [
  { value: 'approve', label: 'Одобрить' },
  { value: 'counter_offer', label: 'Контрпредложение' },
  { value: 'request_info', label: 'Запросить' },
  { value: 'reject', label: 'Отказать' },
  { value: 'retry_checks', label: 'Повторить проверки' },
];

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function DsrBadge({ dsr, max }: { dsr: number | null; max: number }) {
  if (dsr === null) return <Text fz="sm">—</Text>;
  return (
    <Badge color={dsr > max ? 'red' : dsr > max * 0.7 ? 'yellow' : 'teal'} variant="light">
      {pct(dsr)} выручки
    </Badge>
  );
}

function CoverageBadge({ value, min }: { value: number | null; min: number }) {
  if (value === null) return <Text fz="sm">нет данных ФНС</Text>;
  return (
    <Badge color={value < min ? 'red' : value < min * 1.25 ? 'yellow' : 'teal'} variant="light">
      ×{value.toFixed(2).replace('.', ',')}
    </Badge>
  );
}

function TermsTable({ a }: { a: Assessment }) {
  const rows: [string, (t: Terms) => React.ReactNode][] = [
    ['Сумма', (t) => moneyShort(t.amount)],
    ['Срок', (t) => months(t.term_months)],
    ['Ставка', (t) => rate(t.rate)],
    ['Платёж в месяц', (t) => money(t.monthly_payment)],
    ['Нагрузка', (t) => <DsrBadge dsr={t.dsr} max={a.max_dsr} />],
    ['Покрытие платежа прибылью', (t) => <CoverageBadge value={t.coverage} min={a.min_coverage} />],
  ];
  return (
    <Table verticalSpacing="xs" withRowBorders={false}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th />
          <Table.Th>Клиент просит</Table.Th>
          <Table.Th>Конвейер предлагает</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map(([label, render]) => (
          <Table.Tr key={label}>
            <Table.Td>
              <Text fz="sm" c="dimmed">
                {label}
              </Text>
            </Table.Td>
            <Table.Td>{render(a.requested)}</Table.Td>
            <Table.Td>{a.recommendation ? render(a.recommendation) : <Text fz="sm">нет рекомендации</Text>}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function AssessmentCard({ a }: { a: Assessment }) {
  const factors = [...a.factors].sort((x, y) => x.points - y.points);
  return (
    <Card p={{ base: 'lg', sm: 'xl' }}>
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={4}>Оценка заявки</Title>
          <Text fz="sm" c="dimmed">
            {a.scored ? `Скоринг ${a.model_version} · правила решения ${a.policy_version}` : 'Оценки ещё нет'}
          </Text>
        </div>
        {a.grade && (
          <Group gap="lg">
            <Stat label="Балл" value={a.score ?? '—'} />
            <Stat label="Вероятность дефолта" value={a.probability_default !== null ? pct(a.probability_default) : '—'} />
            <Badge size="xl" radius="md" color={GRADE_COLOR[a.grade] ?? 'gray'}>
              Грейд {a.grade}
            </Badge>
          </Group>
        )}
      </Group>

      {a.review_reason && (
        <Alert mt="lg" color={REASON_COLOR[a.review_reason]} variant="light" radius="md" icon={<IconAlertTriangle />}>
          <Text fw={700} fz="sm">
            Почему заявка у специалиста
          </Text>
          <Text fz="sm">{a.review_reason_title}</Text>
          {a.failed_sources.length > 0 && (
            <Text fz="sm" mt={4}>
              Не ответили: {a.failed_sources.join(', ')}
            </Text>
          )}
        </Alert>
      )}

      {a.scored && (
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xl" mt="xl">
          <div>
            <Text fw={700} mb="xs">
              Факторы оценки
            </Text>
            <Stack gap={6}>
              {factors.map((f) => (
                <Group key={f.code} justify="space-between" wrap="nowrap" gap="sm">
                  <div>
                    <Text fz="sm">{f.title}</Text>
                    <Text fz="xs" c="dimmed">
                      {f.value}
                    </Text>
                  </div>
                  <Badge variant="light" color={f.points > 0 ? 'teal' : f.points < 0 ? 'red' : 'gray'}>
                    {f.points > 0 ? `+${f.points}` : f.points}
                  </Badge>
                </Group>
              ))}
            </Stack>
          </div>
          <div>
            <Text fw={700} mb="xs">
              Стоп-факторы
            </Text>
            <Stack gap={6}>
              {a.stop_checks.map((c) => (
                <Group key={c.title} gap="xs" wrap="nowrap">
                  <ThemeIcon size={20} radius="xl" color={c.passed ? 'teal' : 'red'} variant="light">
                    {c.passed ? <IconCheck size={14} /> : <IconX size={14} />}
                  </ThemeIcon>
                  <Text fz="sm">{c.title}</Text>
                </Group>
              ))}
            </Stack>
            {a.revenue && (
              <>
                <Text fw={700} mt="lg" mb="xs">
                  Выручка и нагрузка
                </Text>
                <SimpleGrid cols={2} spacing="sm">
                  <Stat label="Заявлено в месяц" value={a.revenue.declared_monthly ? moneyShort(a.revenue.declared_monthly) : '—'} />
                  <Stat
                    label={a.revenue.source === 'fns' ? 'Принято по ФНС' : 'Принято по выписке'}
                    value={a.revenue.confirmed_monthly ? moneyShort(a.revenue.confirmed_monthly) : '—'}
                  />
                  <Stat label="Учтённые платежи по кредитам" value={a.existing_payments !== null ? money(a.existing_payments) : '—'} />
                  <Stat label="Заявлено в анкете" value={a.declared_debt_payments ? money(a.declared_debt_payments) : '—'} />
                  <Stat
                    label="Расхождение с заявленным"
                    value={a.revenue.gap_pct !== null ? `${a.revenue.gap_pct > 0 ? '+' : ''}${a.revenue.gap_pct}%` : '—'}
                  />
                </SimpleGrid>
              </>
            )}
          </div>
        </SimpleGrid>
      )}

      {a.scored && (
        <>
          <Divider my="lg" />
          <TermsTable a={a} />
          <Text fz="xs" c="dimmed" mt="xs">
            Политика: нагрузка не выше {pct(a.max_dsr)} выручки, прибыль покрывает платёж не меньше чем в{' '}
            {a.min_coverage.toFixed(1).replace('.', ',')} раза, ставка для грейда — от{' '}
            {a.min_rate !== null ? rate(a.min_rate) : '—'}, лимит по выручке —{' '}
            {a.revenue_limit !== null ? `до ${moneyShort(a.revenue_limit)}` : 'не рассчитан'}, полномочия аналитика — до{' '}
            {moneyShort(a.authority_limit)}.
          </Text>
        </>
      )}
    </Card>
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

  const repayment = a.repayment;
  const offerAmount = outcome === 'approve' ? app.amount : amount;
  const offerTerm = outcome === 'approve' ? app.term_months : term;
  const payment = monthlyPayment(offerAmount, rateValue, offerTerm, repayment);
  const revenue = a.revenue?.confirmed_monthly ?? null;
  const dsr = revenue ? ((a.existing_payments ?? 0) + payment) / revenue : null;
  const cover = a.monthly_profit !== null && payment > 0 ? a.monthly_profit / payment : null;
  const deviates =
    !a.recommendation ||
    offerAmount > a.recommendation.amount ||
    offerTerm !== a.recommendation.term_months ||
    rateValue !== a.recommendation.rate;
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
          setError(
            e instanceof ApiError
              ? e.errors?.length
                ? e.errors.map((x) => x.message).join('. ')
                : e.message
              : 'Не удалось сохранить решение',
          ),
      },
    );
  };

  return (
    <Card p={{ base: 'lg', sm: 'xl' }} style={{ border: '2px solid var(--mantine-color-brand-5)' }}>
      <Group gap="sm">
        <ThemeIcon size={40} radius="md">
          <IconGavel size={22} />
        </ThemeIcon>
        <div>
          <Title order={4}>Решение по заявке</Title>
          <Text fz="sm" c="dimmed">
            Клиент увидит решение сразу — статус обновится у него в кабинете.
          </Text>
        </div>
      </Group>

      <SegmentedControl mt="lg" fullWidth value={outcome} onChange={(v) => setOutcome(v as DecisionOutcome)} data={options} />

      <Stack mt="lg" gap="md">
        {(outcome === 'approve' || outcome === 'counter_offer') && (
          <>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <NumberInput
                label="Сумма, ₽"
                value={offerAmount}
                onChange={(v) => setAmount(Number(v) || 0)}
                disabled={outcome === 'approve'}
                thousandSeparator=" "
                step={50_000}
                min={a.product_limits.min_amount}
                max={a.product_limits.max_amount}
                allowNegative={false}
                allowDecimal={false}
              />
              <NumberInput
                label="Срок, мес."
                value={offerTerm}
                onChange={(v) => setTerm(Number(v) || 0)}
                disabled={outcome === 'approve'}
                min={a.product_limits.min_term}
                max={a.product_limits.max_term}
                allowNegative={false}
                allowDecimal={false}
              />
              <NumberInput
                label="Ставка, %"
                value={rateValue}
                onChange={(v) => setRateValue(Number(v) || 0)}
                decimalScale={2}
                step={0.5}
                min={a.min_rate ?? 0.01}
                max={99.99}
              />
            </SimpleGrid>
            <Group gap="lg">
              <Stat label="Платёж в месяц" value={money(Math.round(payment))} accent />
              <div>
                <Text fz="xs" c="dimmed">
                  Нагрузка при этих условиях
                </Text>
                <DsrBadge dsr={dsr} max={a.max_dsr} />
              </div>
              <div>
                <Text fz="xs" c="dimmed">
                  Покрытие прибылью
                </Text>
                <CoverageBadge value={cover} min={a.min_coverage} />
              </div>
              {deviates && (
                <Badge color="orange" variant="light" size="lg">
                  {a.recommendation ? 'Отклонение от рекомендации' : 'Конвейер не предложил условий'} — будет отмечено в журнале
                </Badge>
              )}
            </Group>
          </>
        )}
        {outcome === 'request_info' && (
          <SegmentedControl
            value={taskKind}
            onChange={(v) => setTaskKind(v as 'document' | 'question')}
            data={[
              { value: 'document', label: 'Загрузить документ' },
              { value: 'question', label: 'Ответить на вопрос' },
            ]}
            w="fit-content"
          />
        )}
        {outcome === 'request_info' && (
          <TextInput
            label="Что нужно от клиента"
            placeholder="Например: договор поставки оборудования"
            value={taskTitle}
            onChange={(e) => setTaskTitle(e.currentTarget.value)}
            maxLength={255}
          />
        )}
        {outcome === 'reject' && (
          <>
            <TextInput label="Причина отказа для клиента" value={reason} onChange={(e) => setReason(e.currentTarget.value)} maxLength={300} />
            <TextInput label="Что можно улучшить (необязательно)" value={tip} onChange={(e) => setTip(e.currentTarget.value)} maxLength={300} />
          </>
        )}
        <Textarea
          label="Обоснование для журнала аудита"
          description="Обязательно. Клиент его не видит."
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
          maxLength={2000}
          autosize
          minRows={2}
        />
        <Textarea
          label="Сообщение клиенту (необязательно)"
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
        <Group>
          <Button size="md" onClick={submit} loading={decide.isPending} disabled={comment.trim().length < 10}>
            Сохранить решение
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

const TRACE_ICON: Record<TraceStep['result'], { color: string; icon: React.ReactNode }> = {
  pass: { color: 'teal', icon: <IconCheck size={14} /> },
  fail: { color: 'red', icon: <IconX size={14} /> },
  info: { color: 'gray', icon: <IconInfoCircle size={14} /> },
  triggered: { color: 'orange', icon: <IconArrowRight size={14} /> },
};

/** Как конвейер принял решение: правила по порядку и проверка воспроизводимости на сохранённых признаках. */
function TraceCard({ app, a }: { app: Application; a: Assessment }) {
  const replay = useReplay(app.id);
  if (!a.scored) return null;
  return (
    <Card p={{ base: 'lg', sm: 'xl' }}>
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={4}>Как принималось решение</Title>
          <Text fz="sm" c="dimmed">
            Правила {a.policy_version} по порядку — ровно те проверки, что прошла заявка в конвейере.
          </Text>
        </div>
        <Button variant="light" leftSection={<IconRepeat size={16} />} loading={replay.isPending} onClick={() => replay.mutate()}>
          Воспроизвести решение
        </Button>
      </Group>
      {replay.error && (
        <Alert mt="md" radius="md" variant="light" color="red">
          {replay.error instanceof ApiError ? replay.error.message : 'Не удалось воспроизвести решение'}
        </Alert>
      )}
      {!a.trace.length && (
        <Text fz="sm" c="dimmed" mt="md">
          Трасса не сохранена: решение принималось до версии с трассой. Воспроизведение всё равно доступно.
        </Text>
      )}
      {replay.data && (
        <Alert mt="md" radius="md" variant="light" color={replay.data.matches ? 'teal' : 'orange'}>
          {replay.data.matches
            ? `Совпадает: на сохранённых признаках правила ${replay.data.policy_version_current} дают тот же исход, грейд и условия.`
            : `Расхождение с сохранённым решением (${replay.data.policy_version_stored ?? 'версия неизвестна'} → ${replay.data.policy_version_current}): ${replay.data.differences.join('; ')}.`}
        </Alert>
      )}
      <Stack gap={8} mt="lg">
        {a.trace.map((s, i) => (
          <Group key={i} gap="sm" wrap="nowrap" align="flex-start">
            <ThemeIcon size={22} radius="xl" variant="light" color={TRACE_ICON[s.result].color}>
              {TRACE_ICON[s.result].icon}
            </ThemeIcon>
            <div>
              <Text fz="sm" fw={600}>
                {s.title}
              </Text>
              <Text fz="xs" c="dimmed">
                {s.detail}
              </Text>
            </div>
          </Group>
        ))}
      </Stack>
    </Card>
  );
}

/** Рабочее место аналитика на странице заявки: оценка и, если заявка у специалиста, — решение. */
export function AnalystPanel({ app }: { app: Application }) {
  const assessment = useAssessment(app.id, app.status.code !== 'draft');
  if (assessment.isLoading) return <Skeleton h={240} radius="lg" />;
  const a = assessment.data;
  if (!a) return null;
  return (
    <Stack gap="lg">
      {a.can_decide && <DecisionForm key={app.status.code} app={app} a={a} />}
      <AssessmentCard a={a} />
      <TraceCard app={app} a={a} />
    </Stack>
  );
}
