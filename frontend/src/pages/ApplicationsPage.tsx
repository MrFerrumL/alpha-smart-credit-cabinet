import { Button, Group, SegmentedControl, Skeleton, Stack, Text, Title } from '@mantine/core';
import { IconFileText, IconPlus } from '@tabler/icons-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { useApplications } from '../api/hooks';
import { ApplicationCard } from '../components/ApplicationCard';
import { EmptyState } from '../components/ui';

type Filter = 'active' | 'finished' | 'all';

export function ApplicationsPage() {
  const apps = useApplications();
  const [filter, setFilter] = useState<Filter>('active');
  const list = (apps.data ?? []).filter((a) =>
    filter === 'all' ? true : filter === 'active' ? !a.status.terminal : a.status.terminal,
  );

  return (
    <Stack gap="xl">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>Мои заявки</Title>
          <Text c="dimmed" mt={4}>
            Статус каждой заявки обновляется автоматически
          </Text>
        </div>
        <Button component={Link} to="/match" leftSection={<IconPlus size={18} />}>
          Новая заявка
        </Button>
      </Group>
      <SegmentedControl
        value={filter}
        onChange={(v) => setFilter(v as Filter)}
        data={[
          { value: 'active', label: 'В работе' },
          { value: 'finished', label: 'Завершённые' },
          { value: 'all', label: 'Все' },
        ]}
        w="fit-content"
        radius="md"
      />
      {apps.isLoading ? (
        <Skeleton h={128} radius="lg" />
      ) : list.length === 0 && (apps.data?.length ?? 0) > 0 ? (
        // Заявки есть, но в другом разделе: не предлагаем начинать с нуля.
        <EmptyState
          icon={IconFileText}
          title={filter === 'active' ? 'Заявок в работе нет' : 'Завершённых заявок нет'}
          text={filter === 'active' ? 'Выданные, отклонённые и закрытые заявки — в разделе «Завершённые».' : 'Текущие заявки — в разделе «В работе».'}
          action={
            <Button variant="light" onClick={() => setFilter(filter === 'active' ? 'finished' : 'active')}>
              {filter === 'active' ? 'Показать завершённые' : 'Показать заявки в работе'}
            </Button>
          }
        />
      ) : list.length === 0 ? (
        <EmptyState
          icon={IconFileText}
          title="Здесь пока пусто"
          text="Подберите продукт и оформите заявку — она появится в этом списке."
          action={
            <Button component={Link} to="/match">
              Подобрать кредит
            </Button>
          }
        />
      ) : (
        <Stack gap="md">
          {list.map((a) => (
            <ApplicationCard key={a.id} app={a} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
