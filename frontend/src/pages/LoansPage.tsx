import { Anchor, Button, Card, Group, SimpleGrid, Skeleton, Stack, Table, Text, Title } from '@mantine/core';
import { IconArrowLeft, IconCalendarDue, IconCreditCard, IconPrinter } from '@tabler/icons-react';
import { Link, useParams } from 'react-router';

import { useLoan, useLoans } from '../api/hooks';
import { LoanCard } from '../components/LoanCard';
import { EmptyState, Stat } from '../components/ui';
import { date, money, months, rate } from '../lib/format';

export function LoansPage() {
  const loans = useLoans();
  return (
    <Stack gap="xl">
      <div>
        <Title order={2}>Мои кредиты</Title>
        <Text c="dimmed" mt={4}>
          Действующие кредиты компании, ближайшие платежи и графики погашения
        </Text>
      </div>
      {loans.isLoading ? (
        <Skeleton h={180} radius="lg" />
      ) : !loans.data?.length ? (
        <EmptyState
          icon={IconCreditCard}
          title="Действующих кредитов нет"
          text="Когда банк выдаст кредит по вашей заявке, он появится здесь вместе с графиком платежей."
          action={
            <Button component={Link} to="/match">
              Подобрать кредит
            </Button>
          }
        />
      ) : (
        <Stack gap="md">
          {loans.data.map((loan) => (
            <LoanCard key={loan.id} loan={loan} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

export function LoanPage() {
  const { id } = useParams();
  const loan = useLoan(Number(id));
  const l = loan.data;

  if (loan.isLoading) return <Skeleton h={480} radius="lg" />;
  if (!l) {
    return (
      <EmptyState
        icon={IconCreditCard}
        title="Кредит не найден"
        text="Возможно, ссылка устарела."
        action={
          <Button component={Link} to="/loans">
            Мои кредиты
          </Button>
        }
      />
    );
  }

  const overpayment = l.total_payments - l.amount;
  return (
    <Stack gap="xl">
      <div className="no-print">
        <Anchor component={Link} to="/loans" fz="sm" c="dimmed">
          <Group gap={4}>
            <IconArrowLeft size={16} /> Мои кредиты
          </Group>
        </Anchor>
      </div>
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>{l.product_name}</Title>
          <Text c="dimmed" mt={4}>
            Договор № {l.contract_number} · выдан {date(l.issued_at)}
          </Text>
        </div>
        <Group className="no-print">
          <Button component={Link} to={`/applications/${l.application_id}/contract`} variant="default">
            Договор
          </Button>
          <Button variant="light" leftSection={<IconPrinter size={18} />} onClick={() => window.print()}>
            Скачать график
          </Button>
        </Group>
      </Group>

      <Card p={{ base: 'lg', sm: 'xl' }}>
        <SimpleGrid cols={{ base: 2, md: 4 }} spacing="lg" verticalSpacing="lg">
          <Stat label="Сумма кредита" value={money(l.amount)} />
          <Stat label="Ставка" value={rate(l.rate)} />
          <Stat label="Срок" value={months(l.term_months)} />
          <Stat label="Остаток долга" value={money(l.balance)} />
          <Stat label="Ежемесячный платёж" value={money(l.monthly_payment)} accent />
          <Stat label="Переплата" value={money(overpayment)} />
          <Stat label="Всего к выплате" value={money(l.total_payments)} />
          <Stat label="Оплачено" value={`${l.paid_payments} из ${l.term_months}`} />
        </SimpleGrid>
        {l.next_payment_date && l.next_payment_amount && (
          <Group
            mt="xl"
            p="md"
            gap="sm"
            wrap="nowrap"
            style={{ background: 'var(--mantine-color-brand-0)', borderRadius: 12 }}
          >
            <IconCalendarDue size={22} color="var(--mantine-color-brand-6)" />
            <Text fz="sm">
              Ближайший платёж <b>{money(l.next_payment_amount)}</b> — {date(l.next_payment_date)}. Списывается с
              расчётного счёта автоматически.
            </Text>
          </Group>
        )}
      </Card>

      <Card p={0}>
        <Text fw={800} p="lg" pb="sm">
          График платежей
        </Text>
        <Table.ScrollContainer minWidth={560}>
          <Table striped highlightOnHover verticalSpacing="sm" horizontalSpacing="lg" fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>№</Table.Th>
                <Table.Th>Дата</Table.Th>
                <Table.Th ta="right">Платёж</Table.Th>
                <Table.Th ta="right">Основной долг</Table.Th>
                <Table.Th ta="right">Проценты</Table.Th>
                <Table.Th ta="right">Остаток</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {l.schedule.map((r) => (
                <Table.Tr key={r.n} fw={r.date === l.next_payment_date ? 700 : undefined}>
                  <Table.Td>{r.n}</Table.Td>
                  <Table.Td>{date(r.date)}</Table.Td>
                  <Table.Td ta="right">{money(r.payment)}</Table.Td>
                  <Table.Td ta="right">{money(r.principal)}</Table.Td>
                  <Table.Td ta="right">{money(r.interest)}</Table.Td>
                  <Table.Td ta="right">{money(r.balance)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
    </Stack>
  );
}
