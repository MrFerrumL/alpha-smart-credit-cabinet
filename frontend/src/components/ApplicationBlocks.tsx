import {
  Badge,
  Button,
  Card,
  FileButton,
  Group,
  Loader,
  NumberInput,
  Paper,
  Stack,
  Text,
  Textarea,
  ThemeIcon,
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
    <Paper withBorder p="md" radius="md" bg={done ? 'gray.0' : 'white'}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Text fw={700}>{task.title}</Text>
          {task.description && (
            <Text fz="sm" c="dimmed" mt={2}>
              {task.description}
            </Text>
          )}
        </div>
        {done ? (
          <Badge color="teal" variant="light" leftSection={<IconCheck size={12} />} style={{ flex: '0 0 auto' }}>
            Готово
          </Badge>
        ) : task.status === 'expired' ? (
          <Badge color="gray" variant="light" style={{ flex: '0 0 auto' }}>
            Запрос закрыт
          </Badge>
        ) : (
          <Badge color="orange" variant="light" style={{ flex: '0 0 auto' }}>
            Ждём ответа
          </Badge>
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
            <Button {...props} mt="md" leftSection={<IconFileUpload size={18} />} loading={upload.isPending}>
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
    <Card p={{ base: 'lg', sm: 'xl' }} className="fade-in" style={open ? { border: '2px solid var(--mantine-color-orange-5)' } : undefined}>
      <Title order={4}>{signing ? 'Условия выдачи' : open ? 'Банк просит уточнить' : 'Запросы банка'}</Title>
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
    </Card>
  );
}

// --- Проверки во внешних источниках ------------------------------------------------------------

export function ChecksCard({ checks, active }: { checks: SourceCheck[]; active: boolean }) {
  return (
    <Card p={{ base: 'lg', sm: 'xl' }}>
      <Title order={4}>Проверка компании</Title>
      <Text fz="sm" c="dimmed" mt={4}>
        Банк сам запрашивает данные — вам ничего не нужно присылать.
      </Text>
      <Stack gap="sm" mt="md">
        {checks.map((check) => (
          <Group key={check.source} justify="space-between" wrap="nowrap">
            <Group gap="sm" wrap="nowrap">
              {check.status === 'ok' ? (
                <ThemeIcon color="teal" size={28} radius="xl">
                  <IconCheck size={16} stroke={3} />
                </ThemeIcon>
              ) : check.status === 'failed' ? (
                <ThemeIcon color="orange" size={28} radius="xl" variant="light">
                  <IconAlertTriangle size={16} />
                </ThemeIcon>
              ) : (
                <ThemeIcon color="gray" size={28} radius="xl" variant="light">
                  {active ? <Loader size={14} color="gray" /> : <IconClockHour4 size={16} />}
                </ThemeIcon>
              )}
              <Text fz="sm" fw={600}>
                {check.title}
              </Text>
            </Group>
            <Text fz="xs" c={check.status === 'failed' ? 'orange.7' : 'dimmed'} ta="right">
              {check.status === 'ok'
                ? 'Данные получены'
                : check.status === 'failed'
                  ? active
                    ? 'Не отвечает — повторяем'
                    : 'Не ответил'
                  : active
                    ? 'Запрашиваем…'
                    : 'В очереди'}
            </Text>
          </Group>
        ))}
      </Stack>
    </Card>
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
