import { Card, Group, Progress, Text } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { useNavigate } from 'react-router';

import type { Application } from '../api/types';
import { months, moneyShort } from '../lib/format';
import { StatusBadge, toneColor } from './ui';

const LAST_STAGE = 6;

export function ApplicationCard({ app }: { app: Application }) {
  const navigate = useNavigate();
  const progress = app.status.code === 'issued' ? 100 : (app.status.stage / LAST_STAGE) * 100;

  return (
    <Card
      className="clickable fade-in"
      onClick={() => navigate(app.status.code === 'draft' ? `/applications/${app.id}/edit` : `/applications/${app.id}`)}
    >
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Text fz="xs" c="dimmed">
            Заявка № {app.number}
          </Text>
          <Text fw={800} fz="lg">
            {app.product.name}
          </Text>
          <Text c="dimmed" fz="sm">
            {moneyShort(app.amount)} · {months(app.term_months)} · {app.purpose_title}
          </Text>
        </div>
        <StatusBadge status={app.status} />
      </Group>
      <Progress value={Math.max(progress, 4)} color={toneColor(app.status.tone)} size="sm" radius="xl" mt="md" />
      <Group justify="space-between" mt="sm" wrap="nowrap" gap="xs">
        <Text fz="sm" c="dimmed" lineClamp={2}>
          {app.status.hint}
        </Text>
        <IconChevronRight size={18} color="var(--mantine-color-gray-5)" style={{ flex: '0 0 auto' }} />
      </Group>
    </Card>
  );
}
