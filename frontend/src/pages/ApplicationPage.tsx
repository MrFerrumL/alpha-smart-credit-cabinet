import {
  Alert,
  Anchor,
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
import { IconArrowLeft, IconCircleCheck, IconRefresh, IconSend, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';

import { useApplication, useCancelApplication, useEvents, useMeta, useSubmitApplication } from '../api/hooks';
import type { Application, ApplicationAction, ApplicationEvent } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { StageProgress } from '../components/StageProgress';
import { Stat, StatusBadge, toneColor } from '../components/ui';
import { dateTime, money, moneyShort, months, rate } from '../lib/format';

const ACTOR_LABEL: Record<ApplicationEvent['actor_type'], string> = {
  client: 'Клиент',
  analyst: 'Банк',
  system: 'Система',
};

function StatusPanel({ app }: { app: Application }) {
  const submit = useSubmitApplication();
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
          <Title order={3}>{app.status.title}</Title>
          <Text mt={6} c="dimmed" maw={620}>
            {app.status.hint}
          </Text>
          {app.status.code === 'draft' && (
            <Text mt={6} fz="sm">
              Проверьте параметры ниже — после отправки изменить их будет нельзя.
            </Text>
          )}
          {moving && (
            <Group gap={8} mt="sm">
              <Loader size={14} />
              <Text fz="sm" c="dimmed">
                Статус обновляется автоматически
              </Text>
            </Group>
          )}
        </div>
        <Group gap="sm">
          {can('submit') && (
            <Button
              size="md"
              leftSection={<IconSend size={18} />}
              loading={submit.isPending}
              onClick={() => submit.mutate({ id: app.id })}
            >
              Отправить в банк
            </Button>
          )}
          {can('cancel') && (
            <Button size="md" variant="default" leftSection={<IconX size={18} />} onClick={() => setCancelOpened(true)}>
              {app.status.code === 'draft' ? 'Удалить черновик' : 'Отозвать заявку'}
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
        <Timeline.Item key={ev.id} bullet={<IconCircleCheck size={13} />} title={<Text fw={700} fz="sm">{ev.title}</Text>}>
          <Text fz="xs" c="dimmed">
            {dateTime(ev.created_at)} · {ev.actor_name ?? ACTOR_LABEL[ev.actor_type]}
          </Text>
          {ev.comment && (
            <Text fz="sm" mt={4} fs="italic">
              «{ev.comment}»
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
  const events = useEvents(applicationId, query.data);
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

  if (!query.data) {
    return (
      <Alert color="red" title="Заявка не найдена" radius="lg">
        Возможно, ссылка устарела.{' '}
        <Anchor component={Link} to={backTo}>
          Вернуться к списку
        </Anchor>
      </Alert>
    );
  }

  const app = query.data;

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

      <StatusPanel app={app} />

      {meta.data && (
        <Card p={{ base: 'lg', sm: 'xl' }}>
          <StageProgress stages={meta.data.stages} status={app.status} />
        </Card>
      )}

      <Grid gutter="lg">
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Card p={{ base: 'lg', sm: 'xl' }} h="100%">
            <Title order={4}>Параметры заявки</Title>
            <SimpleGrid cols={{ base: 2, sm: 3 }} mt="lg" spacing="lg" verticalSpacing="lg">
              <Stat label="Продукт" value={app.product.name} />
              <Stat label="Сумма" value={moneyShort(app.amount)} />
              <Stat label="Срок" value={months(app.term_months)} />
              <Stat label="Ставка" value={`от ${rate(app.product.rate)}`} />
              <Stat label="Платёж" value={`≈ ${money(app.monthly_payment)}`} accent />
              <Stat label="Цель" value={<Text fw={700}>{app.purpose_title}</Text>} />
            </SimpleGrid>
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Card p={{ base: 'lg', sm: 'xl' }} h="100%">
            <Group justify="space-between">
              <Title order={4}>История</Title>
              {events.isFetching && <IconRefresh size={16} color="var(--mantine-color-gray-5)" />}
            </Group>
            <div style={{ marginTop: 20 }}>
              {events.data ? <History events={events.data} /> : <Skeleton h={120} />}
            </div>
          </Card>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
