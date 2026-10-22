import {
  Alert,
  Anchor,
  Box,
  Button,
  Card,
  Grid,
  Group,
  Loader,
  Modal,
  Paper,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Textarea,
  Timeline,
  Title,
} from '@mantine/core';
import { IconArrowLeft, IconCircleCheck, IconPencil, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';

import {
  useApplication,
  useCancelApplication,
  useChecks,
  useDocuments,
  useEvents,
  useMeta,
  useTasks,
} from '../api/hooks';
import { useApplicationStream } from '../api/stream';
import type { Application, ApplicationAction, ApplicationEvent } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ChecksCard, DecisionCard, DocumentList, TasksCard } from '../components/ApplicationBlocks';
import { AnalystPanel } from '../components/AnalystPanel';
import { IssuedCard, SigningCard } from '../components/Signing';
import { StageProgress } from '../components/StageProgress';
import { Stat, StatusBadge, toneColor } from '../components/ui';
import { dateTime, money, moneyShort, months, rate } from '../lib/format';

const ACTOR_LABEL: Record<ApplicationEvent['actor_type'], string> = {
  client: 'Клиент',
  analyst: 'Банк',
  system: 'Банк, автоматически',
};

function LiveIndicator({ live }: { live: boolean }) {
  return (
    <Group gap={8} mt="sm">
      {live ? (
        <Box w={10} h={10} bg="teal.5" style={{ borderRadius: '50%' }} className="pulse-green" />
      ) : (
        <Loader size={14} />
      )}
      <Text fz="sm" c="dimmed">
        {live ? 'Статус обновляется в реальном времени' : 'Подключаемся к обновлениям…'}
      </Text>
    </Group>
  );
}

function StatusPanel({ app, live }: { app: Application; live: boolean }) {
  const { user } = useAuth();
  const bank = user?.role === 'analyst';
  const cancel = useCancelApplication();
  const [cancelOpened, setCancelOpened] = useState(false);
  const [comment, setComment] = useState('');
  const can = (action: ApplicationAction) => app.allowed_actions.includes(action);
  const moving = !app.status.terminal && !app.status.action_required && app.status.code !== 'draft';
  const color = toneColor(app.status.tone);

  return (
    <Paper
      p={{ base: 'lg', sm: 'xl' }}
      radius="lg"
      shadow="xs"
      style={{ borderLeft: `6px solid var(--mantine-color-${color}-6)`, background: '#fff' }}
    >
      <Group justify="space-between" align="flex-start" gap="lg">
        <div style={{ flex: 1, minWidth: 260 }}>
          <Title order={3}>{bank && app.allowed_actions.includes('decide') ? 'Ждёт вашего решения' : app.status.title}</Title>
          <Text mt={6} c="dimmed" maw={620}>
            {bank ? `Клиент видит: «${app.status.hint}»` : app.status.hint}
          </Text>
          {moving && <LiveIndicator live={live} />}
        </div>
        <Group gap="sm">
          {can('edit') && (
            <Button size="md" component={Link} to={`/applications/${app.id}/edit`} leftSection={<IconPencil size={18} />}>
              Продолжить оформление
            </Button>
          )}
          {can('cancel') && !can('decline_offer') && (
            <Button size="md" variant="default" leftSection={<IconX size={18} />} onClick={() => setCancelOpened(true)}>
              {app.status.code === 'draft' ? 'Закрыть черновик' : 'Отозвать заявку'}
            </Button>
          )}
        </Group>
      </Group>

      <Modal opened={cancelOpened} onClose={() => setCancelOpened(false)} title={<Text fw={800}>Отозвать заявку?</Text>} centered>
        <Stack>
          <Text fz="sm" c="dimmed">
            Заявка будет закрыта. Новую можно подать в любой момент — данные компании подставятся автоматически.
          </Text>
          <Textarea
            label="Почему отзываете? (необязательно)"
            placeholder="Например: нашли другое финансирование"
            value={comment}
            onChange={(e) => setComment(e.currentTarget.value)}
            autosize
            minRows={2}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setCancelOpened(false)}>
              Не отзывать
            </Button>
            <Button
              color="red"
              loading={cancel.isPending}
              onClick={() =>
                cancel.mutate({ id: app.id, comment: comment || undefined }, { onSuccess: () => setCancelOpened(false) })
              }
            >
              Отозвать
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  );
}

function History({ events }: { events: ApplicationEvent[] }) {
  return (
    <Timeline active={events.length - 1} bulletSize={22} lineWidth={2}>
      {events.map((ev) => (
        <Timeline.Item
          key={ev.id}
          bullet={<IconCircleCheck size={13} />}
          title={
            <Text fw={700} fz="sm">
              {ev.title}
            </Text>
          }
        >
          <Text fz="xs" c="dimmed">
            {dateTime(ev.created_at)} · {ev.actor_name ?? ACTOR_LABEL[ev.actor_type]}
          </Text>
          {ev.comment && (
            <Text fz="sm" mt={4} fs="italic">
              «{ev.comment}»
            </Text>
          )}
          {ev.internal_comment && (
            <Text fz="xs" mt={4} c="orange.8">
              Обоснование (видит только банк): {ev.internal_comment}
            </Text>
          )}
        </Timeline.Item>
      ))}
    </Timeline>
  );
}

export function ApplicationPage() {
  const { id } = useParams();
  const applicationId = Number(id);
  const { user } = useAuth();
  const meta = useMeta();
  const query = useApplication(applicationId);
  const app = query.data;
  const live = useApplicationStream(applicationId, !!app && !app.status.terminal && app.status.code !== 'draft');
  const events = useEvents(applicationId, app);
  const tasks = useTasks(applicationId, app);
  const checks = useChecks(applicationId, app);
  const documents = useDocuments(applicationId, !!app);
  const backTo = user?.role === 'analyst' ? '/queue' : '/applications';

  if (query.isLoading) {
    return (
      <Stack>
        <Skeleton h={40} w={320} />
        <Skeleton h={160} radius="lg" />
        <Skeleton h={120} radius="lg" />
      </Stack>
    );
  }

  if (!app) {
    return (
      <Alert color="red" title="Заявка не найдена" radius="lg">
        Возможно, ссылка устарела.{' '}
        <Anchor component={Link} to={backTo}>
          Вернуться к списку
        </Anchor>
      </Alert>
    );
  }

  const checking = app.status.code === 'enrichment';
  const hasOpenTasks = app.open_tasks > 0;
  const readOnly = user?.role !== 'client';

  return (
    <Stack gap="xl">
      <div>
        <Anchor component={Link} to={backTo} fz="sm" c="dimmed">
          <Group gap={4}>
            <IconArrowLeft size={16} /> {user?.role === 'analyst' ? 'К очереди заявок' : 'Все заявки'}
          </Group>
        </Anchor>
        <Group mt="sm" gap="md" align="center">
          <Title order={2}>Заявка № {app.number}</Title>
          <StatusBadge status={app.status} size="lg" />
        </Group>
        <Text c="dimmed" mt={4}>
          {app.company.name} · создана {dateTime(app.created_at)}
        </Text>
      </div>

      <StatusPanel app={app} live={live} />

      {user?.role === 'analyst' && <AnalystPanel app={app} />}

      {hasOpenTasks && <TasksCard app={app} tasks={tasks.data ?? []} readOnly={readOnly} />}
      {app.status.code === 'issued' && <IssuedCard app={app} />}
      {app.status.code === 'signing' && <SigningCard app={app} />}
      <DecisionCard app={app} />
      {!hasOpenTasks && tasks.data && <TasksCard app={app} tasks={tasks.data} readOnly={readOnly} />}

      {meta.data && (
        <Card p={{ base: 'lg', sm: 'xl' }}>
          <StageProgress stages={meta.data.stages} status={app.status} />
        </Card>
      )}

      <Grid gutter="lg">
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Stack gap="lg">
            <Card p={{ base: 'lg', sm: 'xl' }}>
              <Title order={4}>Параметры заявки</Title>
              <SimpleGrid cols={{ base: 2, sm: 3 }} mt="lg" spacing="lg" verticalSpacing="lg">
                <Stat label="Продукт" value={app.product.name} />
                <Stat label="Сумма" value={moneyShort(app.amount)} />
                <Stat label="Срок" value={months(app.term_months)} />
                <Stat label="Ставка" value={`от ${rate(app.product.rate)}`} />
                <Stat label="Платёж" value={`≈ ${money(app.monthly_payment)}`} accent />
                <Stat label="Цель" value={<Text fw={700}>{app.purpose_title}</Text>} />
              </SimpleGrid>
              {documents.data && documents.data.length > 0 && (
                <>
                  <Text fw={700} mt="xl" mb="xs">
                    Документы
                  </Text>
                  <DocumentList documents={documents.data} />
                </>
              )}
            </Card>
            {checks.data && <ChecksCard checks={checks.data} active={checking} />}
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Card p={{ base: 'lg', sm: 'xl' }} h="100%">
            <Title order={4}>История</Title>
            <div style={{ marginTop: 20 }}>
              {events.data ? <History events={events.data} /> : <Skeleton h={120} />}
            </div>
          </Card>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
