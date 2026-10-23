import { Alert, Anchor, Badge, Button, Card, Group, Skeleton, Stack, Table, Text, Title } from '@mantine/core';
import { IconArrowLeft, IconPrinter, IconSignature } from '@tabler/icons-react';
import { Link, useParams } from 'react-router';

import { useContract } from '../api/hooks';
import { date, dateTime, money, months, rate } from '../lib/format';

/** Печатная форма кредитного договора: «Скачать PDF» — через печать браузера. */
export function ContractPage() {
  const { id } = useParams();
  const applicationId = Number(id);
  const contract = useContract(applicationId, true);
  const c = contract.data;

  return (
    <Stack gap="lg">
      <Group justify="space-between" className="no-print">
        <Anchor component={Link} to={`/applications/${applicationId}`} fz="sm" c="dimmed">
          <Group gap={4}>
            <IconArrowLeft size={16} /> К заявке
          </Group>
        </Anchor>
        {c && (
          <Button variant="light" leftSection={<IconPrinter size={18} />} onClick={() => window.print()}>
            Скачать PDF
          </Button>
        )}
      </Group>

      {contract.isLoading && <Skeleton h={600} radius="lg" />}
      {contract.error && (
        <Alert color="orange" radius="lg" title="Договор недоступен">
          {contract.error.message}
        </Alert>
      )}

      {c && (
        <Card p={{ base: 'lg', sm: 48 }} className="print-sheet">
          <Group justify="space-between" align="flex-start">
            <div>
              <Text fz="xs" c="dimmed" tt="uppercase" fw={700} lts={0.5}>
                {c.bank_name}
              </Text>
              <Title order={2} mt={6}>
                Кредитный договор № {c.number}
              </Title>
              <Text c="dimmed" mt={4}>
                г. Москва, {date(c.date)}
              </Text>
            </div>
            {c.signed ? (
              <Badge color="teal" size="lg" variant="light" leftSection={<IconSignature size={14} />}>
                Подписан
              </Badge>
            ) : (
              <Badge color="orange" size="lg" variant="light">
                Ждёт подписи
              </Badge>
            )}
          </Group>

          <Stack gap="lg" mt="xl">
            {c.sections.map((section) => (
              <div key={section.title}>
                <Text fw={800} mb={6}>
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
            {money(c.amount)} · {months(c.term_months)} · {rate(c.rate)} годовых. Даты платежей фиксируются в день выдачи.
          </Text>
          <Table fz="sm" striped withTableBorder verticalSpacing={6}>
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
                  <Table.Td ta="right">{money(r.payment)}</Table.Td>
                  <Table.Td ta="right">{money(r.principal)}</Table.Td>
                  <Table.Td ta="right">{money(r.interest)}</Table.Td>
                  <Table.Td ta="right">{money(r.balance)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
            <Table.Tfoot>
              <Table.Tr>
                <Table.Th>Итого</Table.Th>
                <Table.Th ta="right">{money(c.total_payments)}</Table.Th>
                <Table.Th ta="right">{money(c.amount)}</Table.Th>
                <Table.Th ta="right">{money(c.total_payments - c.amount)}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Tfoot>
          </Table>

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
        </Card>
      )}
    </Stack>
  );
}
