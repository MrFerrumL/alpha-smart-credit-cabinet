import { Card, Group, SegmentedControl, SimpleGrid, Skeleton, Stack, Table, Text, Title } from '@mantine/core';
import { IconInbox } from '@tabler/icons-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { useApplications } from '../api/hooks';
import { EmptyState, Stat, StatusBadge } from '../components/ui';
import { dateTime, moneyShort, months } from '../lib/format';

const FILTERS = [
  { value: 'all', label: 'Все' },
  { value: 'manual_review', label: 'Ждут решения' },
  { value: 'approved', label: 'Одобрены' },
  { value: 'counter_offer', label: 'Контрпредложения' },
  { value: 'rejected', label: 'Отказы' },
];

export function QueuePage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('all');
  const all = useApplications();
  const list = (all.data ?? []).filter((a) => filter === 'all' || a.status.code === filter);
  const count = (code: string) => (all.data ?? []).filter((a) => a.status.code === code).length;
  const inPipeline = (all.data ?? []).filter((a) => !a.status.terminal && !a.status.action_required).length;

  return (
    <Stack gap="xl">
      <div>
        <Title order={2}>Очередь заявок</Title>
        <Text c="dimmed" mt={4}>
          Все отправленные клиентами заявки. Статусы обновляются автоматически.
        </Text>
      </div>

      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Card>
          <Stat label="Всего" value={all.data?.length ?? '—'} />
        </Card>
        <Card>
          <Stat label="В конвейере" value={inPipeline} />
        </Card>
        <Card>
          <Stat label="Ждут решения" value={count('manual_review')} accent />
        </Card>
        <Card>
          <Stat label="Одобрено" value={count('approved') + count('counter_offer')} />
        </Card>
      </SimpleGrid>

      <SegmentedControl value={filter} onChange={setFilter} data={FILTERS} w="fit-content" radius="md" />

      {all.isLoading ? (
        <Skeleton h={240} radius="lg" />
      ) : list.length === 0 ? (
        <EmptyState icon={IconInbox} title="Заявок нет" text="Когда клиенты отправят заявки, они появятся здесь." />
      ) : (
        <Card p={0}>
          <Table.ScrollContainer minWidth={760}>
            <Table highlightOnHover verticalSpacing="md" horizontalSpacing="lg">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Заявка</Table.Th>
                  <Table.Th>Компания</Table.Th>
                  <Table.Th>Продукт</Table.Th>
                  <Table.Th ta="right">Сумма</Table.Th>
                  <Table.Th>Статус</Table.Th>
                  <Table.Th>Отправлена</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {list.map((a) => (
                  <Table.Tr key={a.id} onClick={() => navigate(`/applications/${a.id}`)} style={{ cursor: 'pointer' }}>
                    <Table.Td>
                      <Text fw={700} fz="sm">
                        № {a.number}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text fz="sm">{a.company.name}</Text>
                      <Text fz="xs" c="dimmed">
                        ИНН {a.company.inn}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text fz="sm">{a.product.name}</Text>
                      <Text fz="xs" c="dimmed">
                        {months(a.term_months)}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text fz="sm" fw={700}>
                        {moneyShort(a.amount)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={6}>
                        <StatusBadge status={a.status} size="sm" />
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text fz="sm" c="dimmed">
                        {a.submitted_at ? dateTime(a.submitted_at) : '—'}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      )}
    </Stack>
  );
}
