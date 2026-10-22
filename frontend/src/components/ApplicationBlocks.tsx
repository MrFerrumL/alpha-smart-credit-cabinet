import {
  Badge,
  Button,
  Card,
  FileButton,
  Group,
  List,
  Loader,
  NumberInput,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Textarea,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconCircleCheck,
  IconClockHour4,
  IconFileUpload,
  IconInfoCircle,
  IconPaperclip,
  IconSparkles,
  IconX,
} from '@tabler/icons-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { useAnswerTask, useUploadDocument } from '../api/hooks';
import type { Application, ClientTask, SourceCheck, UploadedDocument } from '../api/types';
import { date, money, moneyShort, months, rate } from '../lib/format';
import { Stat } from './ui';

// --- Решение банка -----------------------------------------------------------------------------

function OfferGrid({ app }: { app: Application }) {
  const offer = app.offer!;
  return (
    <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="lg" mt="lg">
      <Stat label="Сумма" value={moneyShort(offer.amount)} />
      <Stat label="Срок" value={months(offer.term_months)} />
      <Stat label="Ставка" value={rate(offer.rate)} />
      <Stat label="Платёж в месяц" value={money(offer.monthly_payment)} accent />
    </SimpleGrid>
  );
}

function CompareTable({ app }: { app: Application }) {
  const offer = app.offer!;
  const rows: [string, string, string, boolean][] = [
    ['Сумма', moneyShort(app.amount), moneyShort(offer.amount), app.amount !== offer.amount],
    ['Срок', months(app.term_months), months(offer.term_months), app.term_months !== offer.term_months],
    ['Ставка', `от ${rate(app.product.rate)}`, rate(offer.rate), app.product.rate !== offer.rate],
    ['Платёж в месяц', `≈ ${money(app.monthly_payment)}`, money(offer.monthly_payment), app.monthly_payment !== offer.monthly_payment],
  ];
  return (
    <Table mt="lg" verticalSpacing="sm" withRowBorders>
      <Table.Thead>
        <Table.Tr>
          <Table.Th />
          <Table.Th>Вы просили</Table.Th>
          <Table.Th>Банк предлагает</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map(([label, asked, offered, changed]) => (
          <Table.Tr key={label}>
            <Table.Td>
              <Text fz="sm" c="dimmed">
                {label}
              </Text>
            </Table.Td>
            <Table.Td>
              <Text fz="sm" td={changed ? 'line-through' : undefined} c={changed ? 'dimmed' : undefined}>
                {asked}
              </Text>
            </Table.Td>
            <Table.Td>
              <Text fz="sm" fw={800} c={changed ? 'brand.6' : undefined}>
                {offered}
              </Text>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function ReasonList({ items, tone }: { items: string[]; tone: 'good' | 'bad' | 'info' }) {
  const icon =
    tone === 'good' ? (
      <ThemeIcon color="teal" size={22} radius="xl">
        <IconCheck size={13} stroke={3} />
      </ThemeIcon>
    ) : tone === 'bad' ? (
      <ThemeIcon color="red" size={22} radius="xl" variant="light">
        <IconX size={13} stroke={3} />
      </ThemeIcon>
    ) : (
      <ThemeIcon color="orange" size={22} radius="xl" variant="light">
        <IconInfoCircle size={14} />
      </ThemeIcon>
    );
  return (
    <List spacing={8} fz="sm" icon={icon} mt="sm">
      {items.map((item) => (
        <List.Item key={item}>{item}</List.Item>
      ))}
    </List>
  );
}

export function DecisionCard({ app }: { app: Application }) {
  const { decision, offer } = app;
  if (!decision) return null;
  const code = app.status.code;

  if (code === 'approved' && offer) {
    return (
      <Card p={{ base: 'lg', sm: 'xl' }} className="fade-in" style={{ border: '2px solid var(--mantine-color-teal-5)' }}>
        <Group gap="sm">
          <ThemeIcon color="teal" size={40} radius="md">
            <IconCircleCheck size={24} />
          </ThemeIcon>
          <div>
            <Title order={3}>Банк готов выдать кредит</Title>
            <Text c="dimmed" fz="sm">
              {offer.valid_until ? `Предложение действует до ${date(offer.valid_until)}` : 'Условия по вашей заявке'}
            </Text>
          </div>
        </Group>
        <OfferGrid app={app} />
        {decision.reasons.length > 0 && (
          <>
            <Text fw={700} mt="xl">
              Почему одобрено
            </Text>
            <ReasonList items={decision.reasons} tone="good" />
          </>
        )}
      </Card>
    );
  }

  if (code === 'counter_offer' && offer) {
    return (
      <Card p={{ base: 'lg', sm: 'xl' }} className="fade-in" style={{ border: '2px solid var(--mantine-color-orange-5)' }}>
        <Group gap="sm">
          <ThemeIcon color="orange" size={40} radius="md">
            <IconSparkles size={22} />
          </ThemeIcon>
          <div>
            <Title order={3}>Можем выдать на других условиях</Title>
            <Text c="dimmed" fz="sm">
              {offer.valid_until ? `Предложение действует до ${date(offer.valid_until)}` : 'Сравните с тем, что вы просили'}
            </Text>
          </div>
        </Group>
        <CompareTable app={app} />
        <Text fw={700} mt="xl">
          Почему условия другие
        </Text>
        <ReasonList items={decision.reasons} tone="info" />
      </Card>
    );
  }

  if (code === 'rejected') {
    return (
      <Card p={{ base: 'lg', sm: 'xl' }} className="fade-in">
        <Title order={3}>Почему банк отказал</Title>
        <ReasonList items={decision.reasons} tone="bad" />
        {decision.tips.length > 0 && (
          <Paper bg="gray.0" p="md" mt="lg" radius="md">
            <Text fw={700}>Что можно сделать</Text>
            <List spacing={6} fz="sm" mt="xs">
              {decision.tips.map((tip) => (
                <List.Item key={tip}>{tip}</List.Item>
              ))}
            </List>
          </Paper>
        )}
        <Group mt="lg">
          <Button component={Link} to="/match" variant="light">
            Подобрать другой вариант
          </Button>
        </Group>
      </Card>
    );
  }

  if (code === 'manual_review') {
    return (
      <Card p={{ base: 'lg', sm: 'xl' }} className="fade-in">
        <Title order={4}>Почему заявку смотрит специалист</Title>
        <ReasonList items={decision.reasons} tone="info" />
      </Card>
    );
  }
  return null;
}

// --- Запросы банка -----------------------------------------------------------------------------

function TaskItem({ app, task, readOnly }: { app: Application; task: ClientTask; readOnly: boolean }) {
  const answer = useAnswerTask(app.id);
  const upload = useUploadDocument(app.id);
  const [value, setValue] = useState<string | number>('');
  const done = task.status === 'done';
  const canAnswer = !done && !readOnly;

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
        ) : (
          <Badge color="orange" variant="light" style={{ flex: '0 0 auto' }}>
            Ждём ответа
          </Badge>
        )}
      </Group>
      {done && task.answer && (
        <Text fz="sm" mt="xs">
          Ваш ответ: <b>{task.answer}</b>
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
    </Paper>
  );
}

export function TasksCard({ app, tasks, readOnly = false }: { app: Application; tasks: ClientTask[]; readOnly?: boolean }) {
  if (tasks.length === 0) return null;
  const open = tasks.filter((t) => t.status === 'open').length;
  return (
    <Card p={{ base: 'lg', sm: 'xl' }} className="fade-in" style={open ? { border: '2px solid var(--mantine-color-orange-5)' } : undefined}>
      <Title order={4}>{open ? 'Банк просит уточнить' : 'Запросы банка'}</Title>
      <Text fz="sm" c="dimmed" mt={4}>
        {open
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
