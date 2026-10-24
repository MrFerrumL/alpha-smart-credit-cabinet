import { Anchor, Button, Group, Skeleton, Stack, Table, Text, Title } from '@mantine/core';
import { IconArrowLeft, IconPrinter } from '@tabler/icons-react';
import { Link, useParams } from 'react-router';

import { useContract } from '../api/hooks';
import { Chip } from '../components/Status';
import { LoadError } from '../components/States';
import { date, dateTime, int, money, months, rate } from '../lib/format';
import { nb } from '../lib/nobreak';

/** Печатная форма кредитного договора: «Скачать PDF» — через печать браузера. */
export function ContractPage() {
  const { id } = useParams();
  const applicationId = Number(id);
  const contract = useContract(applicationId, true);
  const c = contract.data;

  return (
    <div className="potok-col">
      <Group justify="space-between" className="no-print">
        <Anchor component={Link} to={`/applications/${applicationId}`} fz="sm" c="dimmed">
          <Group gap={4}>
            <IconArrowLeft size={16} /> К заявке
          </Group>
        </Anchor>
        {c && (
          <Button variant="default" size="md" leftSection={<IconPrinter size={18} />} onClick={() => window.print()}>
            Скачать PDF
          </Button>
        )}
      </Group>

      {contract.isLoading && <Skeleton h={600} radius="lg" />}
      {contract.error && (
        <LoadError
          error={contract.error}
          what="договор"
          back={
            <Button component={Link} to={`/applications/${applicationId}`} size="lg" variant="default">
              К заявке
            </Button>
          }
        />
      )}

      {c && (
        <section className="potok-panel potok-contract print-sheet">
          <Group justify="space-between" align="flex-start">
            <div>
              <Text fz="sm" c="dimmed">
                {c.bank_name}
              </Text>
              <Title order={1} mt={6} className="potok-contract-h">
                {nb(`Кредитный договор № ${c.number}`)}
              </Title>
              <Text c="dimmed" mt={4}>
                г. Москва, {date(c.date)}
              </Text>
            </div>
            {c.signed ? <Chip tone="success">Подписан</Chip> : <Chip tone="warning">Ждёт подписи</Chip>}
          </Group>

          <Stack gap="lg" mt="xl">
            {c.sections.map((section) => (
              <div key={section.title}>
                <Text fw={600} mb={6}>
                  {section.title}
                </Text>
                {section.paragraphs.map((p) => (
                  <Text key={p} fz="sm" lh={1.6} mb={4}>
                    {p}
                  </Text>
                ))}
              </div>
            ))}
          </Stack>

          <Text fw={800} mt="xl" mb="xs">
            Приложение 1. График платежей
          </Text>
          <Text fz="xs" c="dimmed" mb="sm">
            {money(c.amount)} на {months(c.term_months)} под {rate(c.rate)} годовых. Суммы в рублях, даты платежей фиксируются в день
            выдачи.
          </Text>
          <div className="potok-contract-table">
            <Table fz="sm" withTableBorder withRowBorders verticalSpacing={8}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>№</Table.Th>
                  <Table.Th ta="right">Платёж</Table.Th>
                  <Table.Th ta="right">Основной долг</Table.Th>
                  <Table.Th ta="right">Проценты</Table.Th>
                  <Table.Th ta="right">Остаток</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {c.schedule.map((r) => (
                  <Table.Tr key={r.n}>
                    <Table.Td>{r.n}</Table.Td>
                    <Table.Td ta="right">{int(r.payment)}</Table.Td>
                    <Table.Td ta="right">{int(r.principal)}</Table.Td>
                    <Table.Td ta="right">{int(r.interest)}</Table.Td>
                    <Table.Td ta="right">{int(r.balance)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
              <Table.Tfoot>
                <Table.Tr>
                  <Table.Th>Итого</Table.Th>
                  <Table.Th ta="right">{int(c.total_payments)}</Table.Th>
                  <Table.Th ta="right">{int(c.amount)}</Table.Th>
                  <Table.Th ta="right">{int(c.total_payments - c.amount)}</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Tfoot>
            </Table>
          </div>

          <Group justify="space-between" mt={40} align="flex-end">
            <div>
              <Text fz="xs" c="dimmed">
                Кредитор
              </Text>
              <Text fw={700}>{c.bank_name}</Text>
            </div>
            <div style={{ textAlign: 'right' }}>
              <Text fz="xs" c="dimmed">
                Заёмщик
              </Text>
              <Text fw={700}>{c.company_name}</Text>
              <Text fz="xs" c={c.signed ? 'teal.7' : 'dimmed'}>
                {c.signed && c.signed_at
                  ? `Подписано ПЭП: ${c.signed_by ?? ''}, ${dateTime(c.signed_at)}`
                  : 'Подпись: ожидается'}
              </Text>
            </div>
          </Group>
        </section>
      )}
    </div>
  );
}
