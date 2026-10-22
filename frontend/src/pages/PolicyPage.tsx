import { Alert, Badge, Button, Card, Group, SimpleGrid, Slider, Stack, Table, Text, Title } from '@mantine/core';
import { IconAdjustments } from '@tabler/icons-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { ApiError } from '../api/client';
import { usePolicySimulation } from '../api/hooks';
import type { PolicySummary } from '../api/types';
import { Stat } from '../components/ui';
import { moneyShort } from '../lib/format';

const OUTCOME: Record<string, { title: string; color: string }> = {
  approved: { title: 'Одобрение', color: 'teal' },
  counter_offer: { title: 'Контрпредложение', color: 'orange' },
  manual_review: { title: 'Специалист', color: 'blue' },
  rejected: { title: 'Отказ', color: 'red' },
  needs_info: { title: 'Запрос информации', color: 'yellow' },
};

const STATUS_TITLE: Record<string, string> = {
  submitted: 'Отправлена', validation: 'Проверка данных', needs_info: 'Нужна информация', enrichment: 'Проверка компании',
  scoring: 'Оценка', manual_review: 'У специалиста', approved: 'Одобрено', counter_offer: 'Контрпредложение',
  rejected: 'Отказ', signing: 'Подписание', issued: 'Выдан', cancelled: 'Отозвана', expired: 'Срок истёк',
};

function Outcome({ code }: { code: string }) {
  const o = OUTCOME[code] ?? { title: code, color: 'gray' };
  return (
    <Badge variant="light" color={o.color}>
      {o.title}
    </Badge>
  );
}

function SummaryCard({ title, s }: { title: string; s: PolicySummary }) {
  return (
    <Card p="lg">
      <Text fw={700}>{title}</Text>
      <Text fz="xs" c="dimmed">
        нагрузка ≤ {Math.round(s.max_dsr * 100)}% выручки, покрытие ≥ ×{s.min_coverage.toFixed(1).replace('.', ',')}
      </Text>
      <SimpleGrid cols={2} mt="md">
        <Stat label="Положительные решения" value={`${Math.round(s.approval_share * 100)}%`} accent />
        <Stat label="Объём предложений и рекомендаций" value={moneyShort(s.offered_total)} />
      </SimpleGrid>
      <Group gap={6} mt="md">
        {Object.entries(s.counts).map(([code, n]) => (
          <Badge key={code} variant="light" color={OUTCOME[code]?.color ?? 'gray'}>
            {OUTCOME[code]?.title ?? code}: {n}
          </Badge>
        ))}
      </Group>
    </Card>
  );
}

/** Симулятор политики: как изменились бы решения по сохранённым заявкам при других порогах. */
export function PolicyPage() {
  const [maxDsr, setMaxDsr] = useState(50);
  const [coverage, setCoverage] = useState(1.2);
  const sim = usePolicySimulation();
  const run = () => sim.mutate({ max_dsr: maxDsr / 100, min_coverage: coverage });

  return (
    <Stack gap="xl">
      <div>
        <Title order={2}>Кредитная политика</Title>
        <Text c="dimmed" mt={4}>
          Что будет, если изменить пороги: все заявки с сохранённой оценкой (в любом статусе) пересчитываются теми же
          правилами, что и в конвейере, — по текущим порогам и по новым. Для заявок у специалиста сравнивается
          рекомендация конвейера. Заявки и решения не меняются.
        </Text>
      </div>

      <Card p="xl">
        <Group gap="xs">
          <IconAdjustments size={20} />
          <Title order={4}>Пороги</Title>
        </Group>
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xl" mt="lg">
          <div>
            <Text fz="sm" fw={600}>
              Максимальная нагрузка: {maxDsr}% выручки на все кредитные платежи
            </Text>
            <Slider mt="sm" min={20} max={70} step={5} value={maxDsr} onChange={setMaxDsr} label={(v) => `${v}%`} />
          </div>
          <div>
            <Text fz="sm" fw={600}>
              Минимальное покрытие нового платежа прибылью: ×{coverage.toFixed(1).replace('.', ',')}
            </Text>
            <Slider mt="sm" min={0.8} max={2.5} step={0.1} value={coverage} onChange={setCoverage}
              label={(v) => `×${v.toFixed(1).replace('.', ',')}`} />
          </div>
        </SimpleGrid>
        <Button mt="xl" onClick={run} loading={sim.isPending}>
          Рассчитать
        </Button>
        {sim.error && (
          <Alert mt="md" color="red" variant="light">
            {sim.error instanceof ApiError ? sim.error.message : 'Не удалось рассчитать'}
          </Alert>
        )}
      </Card>

      {sim.data && (
        <>
          <SimpleGrid cols={{ base: 1, md: 2 }}>
            <SummaryCard title="По текущей политике (пересчёт)" s={sim.data.current} />
            <SummaryCard title="С новыми порогами" s={sim.data.simulated} />
          </SimpleGrid>
          <Card p={0}>
            <Text fw={700} p="lg" pb={0}>
              Изменится решение: {sim.data.changed.length} из {sim.data.applications}
            </Text>
            {sim.data.changed.length === 0 ? (
              <Text c="dimmed" fz="sm" p="lg">
                При этих порогах ни одно решение не меняется.
              </Text>
            ) : (
              <Table.ScrollContainer minWidth={720}>
                <Table verticalSpacing="sm" horizontalSpacing="lg" mt="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Заявка</Table.Th>
                      <Table.Th>Компания</Table.Th>
                      <Table.Th ta="right">Запрошено</Table.Th>
                      <Table.Th>Статус заявки</Table.Th>
                      <Table.Th>По текущей политике</Table.Th>
                      <Table.Th>С новыми порогами</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {sim.data.changed.map((r) => (
                      <Table.Tr key={r.id}>
                        <Table.Td>
                          <Link to={`/applications/${r.id}`}>№ {r.number}</Link>
                        </Table.Td>
                        <Table.Td>
                          <Text fz="sm">{r.company}</Text>
                          <Text fz="xs" c="dimmed">
                            {r.product}
                          </Text>
                        </Table.Td>
                        <Table.Td ta="right">{moneyShort(r.requested)}</Table.Td>
                        <Table.Td>
                          <Text fz="xs" c="dimmed">
                            {STATUS_TITLE[r.status] ?? r.status}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Outcome code={r.outcome_now} />
                          {r.offered_now > 0 && <Text fz="xs">{moneyShort(r.offered_now)}</Text>}
                        </Table.Td>
                        <Table.Td>
                          <Outcome code={r.outcome_then} />
                          {r.offered_then > 0 && <Text fz="xs">{moneyShort(r.offered_then)}</Text>}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Card>
        </>
      )}
    </Stack>
  );
}
