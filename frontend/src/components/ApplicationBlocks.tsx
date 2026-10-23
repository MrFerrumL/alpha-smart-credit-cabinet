import {
  Button,
  FileButton,
  Group,
  Loader,
  NumberInput,
  Paper,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconClockHour4,
  IconFileUpload,
  IconPaperclip,
} from '@tabler/icons-react';
import { useState } from 'react';

import { useAnswerTask, useUploadDocument } from '../api/hooks';
import type { Application, ClientTask, Product, SourceCheck, UploadedDocument } from '../api/types';
import { money, months, rate } from '../lib/format';
import { Chip } from './Status';

// --- Решение банка -----------------------------------------------------------------------------

/**
 * Условия, которые показываем по заявке. Пока предложение не принято — то, что клиент просил; после принятия
 * (подписание, выдача) — условия договора, а запрошенные остаются только справкой «вы просили».
 */
export function shownTerms(app: Application, products?: Product[]) {
  const offer = app.offer;
  if (offer && (offer.status === 'accepted' || offer.status === 'signed')) {
    const sameProduct = offer.product_code === app.product.code;
    const asked = !sameProduct || offer.amount !== app.amount || offer.term_months !== app.term_months;
    const product = products?.find((p) => p.code === offer.product_code);
    return {
      agreed: true,
      product: product?.name ?? (sameProduct ? app.product.name : '…'),
      interestOnly: product?.repayment === 'interest_only',
      amount: offer.amount,
      term: offer.term_months,
      rate: rate(offer.rate),
      payment: money(offer.monthly_payment),
      asked: asked ? `${app.product.name}, ${money(app.amount)} на ${months(app.term_months)}` : null,
    };
  }
  return {
    agreed: false,
    product: app.product.name,
    interestOnly: products?.find((p) => p.code === app.product.code)?.repayment === 'interest_only',
    amount: app.amount,
    term: app.term_months,
    rate: `от ${rate(app.product.rate)}`,
    payment: `≈ ${money(app.monthly_payment)}`,
    asked: null,
  };
}
// --- Запросы банка -----------------------------------------------------------------------------

function TaskItem({ app, task, readOnly }: { app: Application; task: ClientTask; readOnly: boolean }) {
  const answer = useAnswerTask(app.id);
  const upload = useUploadDocument(app.id);
  const [value, setValue] = useState<string | number>('');
  const done = task.status === 'done';
  // Поручительство собственника (условие выдачи) подтверждает только руководитель — сервер даёт ему отдельное действие.
  const signerOnly = task.kind === 'question' && task.payload?.condition === 'before_issue';
  const canAnswer =
    task.status === 'open' && !readOnly && app.allowed_actions.includes(signerOnly ? 'confirm_guarantee' : 'answer_tasks');

  return (
    <Paper p="md" radius={16} className="potok-task" data-done={done}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Text fw={600}>{task.title}</Text>
          {task.description && (
            <Text fz="sm" c="dimmed" mt={2}>
              {task.description}
            </Text>
          )}
        </div>
        {done ? (
          <Chip tone="success">Готово</Chip>
        ) : task.status === 'expired' ? (
          <Chip tone="neutral">Запрос закрыт</Chip>
        ) : (
          <Chip tone="warning">Ждём ответа</Chip>
        )}
      </Group>
      {done && task.answer && (
        <Text fz="sm" mt="xs">
          {task.kind === 'document' ? 'Приложен файл' : readOnly ? 'Ответ клиента' : 'Ответ'}: <b>{task.answer}</b>
        </Text>
      )}
      {canAnswer && task.kind === 'document' && (
        <FileButton
          onChange={(file) =>
            file && upload.mutate({ file, kind: task.payload?.document_kind ?? 'other', taskId: task.id })
          }
          accept=".pdf,.png,.jpg,.jpeg,.xlsx,.xls,.csv,.doc,.docx,.txt"
        >
          {(props) => (
            <Button {...props} mt="md" variant="default" size="md" leftSection={<IconFileUpload size={18} />} loading={upload.isPending}>
              Загрузить файл
            </Button>
          )}
        </FileButton>
      )}
      {canAnswer && task.kind === 'field' && (
        <Group mt="md" align="flex-end">
          <NumberInput
            value={value}
            onChange={setValue}
            thousandSeparator=" "
            suffix=" ₽"
            min={0}
            allowNegative={false}
            allowDecimal={false}
            placeholder="Сумма"
            style={{ flex: 1, maxWidth: 280 }}
          />
          <Button
            loading={answer.isPending}
            disabled={!value}
            onClick={() => answer.mutate({ taskId: task.id, answer: String(value) })}
          >
            Отправить
          </Button>
        </Group>
      )}
      {canAnswer && task.kind === 'question' && (
        <Stack gap="xs" mt="md">
          <Textarea value={String(value)} onChange={(e) => setValue(e.currentTarget.value)} autosize minRows={2} />
          <Group>
            <Button
              loading={answer.isPending}
              disabled={!String(value).trim()}
              onClick={() => answer.mutate({ taskId: task.id, answer: String(value) })}
            >
              Ответить
            </Button>
          </Group>
        </Stack>
      )}
      {signerOnly && task.status === 'open' && !readOnly && !canAnswer && (
        <Text fz="sm" c="dimmed" mt="md">
          Поручительство подтверждает руководитель компании — пункт ждёт его в кабинете.
        </Text>
      )}
    </Paper>
  );
}

export function TasksCard({ app, tasks, readOnly = false }: { app: Application; tasks: ClientTask[]; readOnly?: boolean }) {
  if (tasks.length === 0) return null;
  const open = tasks.filter((t) => t.status === 'open').length;
  const signing = app.status.code === 'signing';
  return (
    <section className="potok-panel fade-in">
      <Title order={3}>{signing ? 'Условия выдачи' : open ? 'Банк просит уточнить' : 'Запросы банка'}</Title>
      <Text fz="sm" c="dimmed" mt={4}>
        {signing
          ? open
            ? readOnly
              ? 'Клиент закрывает условия выдачи — после этого деньги будут переведены автоматически.'
              : 'Закройте условия — как только последнее будет выполнено, деньги поступят на счёт автоматически.'
            : 'Все условия выполнены.'
          : open
            ? 'Как только вы ответите на все запросы, проверка продолжится автоматически.'
            : 'Все запросы закрыты — спасибо!'}
      </Text>
      <Stack gap="sm" mt="md">
        {tasks.map((task) => (
          <TaskItem key={task.id} app={app} task={task} readOnly={readOnly} />
        ))}
      </Stack>
    </section>
  );
}

// --- Проверки во внешних источниках ------------------------------------------------------------

/** Проверки во внешних источниках — список с линейной отметкой; пока идёт проверка, рядом счётчик ожидания. */
export function ChecksCard({ checks, active }: { checks: SourceCheck[]; active: boolean }) {
  return (
    <section className="potok-panel">
      <Title order={3}>Проверка компании</Title>
      <Text fz="sm" c="dimmed" mt={4}>
        Банк сам запрашивает данные — вам ничего не нужно присылать.
      </Text>
      <ul className="potok-checks potok-checks-wide">
        {checks.map((check) => (
          <li key={check.source} data-ok={check.status === 'ok'} data-state={check.status}>
            {check.status === 'ok' ? (
              <IconCheck size={16} />
            ) : check.status === 'failed' ? (
              <IconAlertTriangle size={16} />
            ) : active ? (
              <Loader size={14} color="gray" />
            ) : (
              <IconClockHour4 size={16} />
            )}
            <span className="potok-checks-name">{check.title}</span>
            <span className="potok-checks-state">
              {check.status === 'ok'
                ? 'данные получены'
                : check.status === 'failed'
                  ? active
                    ? 'не отвечает — повторяем'
                    : 'не ответил'
                  : active
                    ? 'запрашиваем…'
                    : 'в очереди'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- Документы ---------------------------------------------------------------------------------

export function DocumentList({ documents }: { documents: UploadedDocument[] }) {
  if (documents.length === 0) return null;
  return (
    <Stack gap={6}>
      {documents.map((doc) => (
        <Group key={doc.id} gap="xs" wrap="nowrap">
          <IconPaperclip size={16} color="var(--mantine-color-gray-6)" />
          <Text fz="sm" truncate>
            {doc.filename}
          </Text>
          <Text fz="xs" c="dimmed" style={{ flex: '0 0 auto' }}>
            {Math.max(1, Math.round(doc.size_bytes / 1024))} КБ
          </Text>
        </Group>
      ))}
    </Stack>
  );
}
