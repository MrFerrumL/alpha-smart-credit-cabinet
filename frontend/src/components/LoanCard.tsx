import { Card, Group, Progress, SimpleGrid, Text, ThemeIcon } from '@mantine/core';
import { IconCreditCard } from '@tabler/icons-react';
import { useNavigate } from 'react-router';

import type { Loan } from '../api/types';
import { date, money, moneyShort, rate } from '../lib/format';
import { Stat } from './ui';

export function LoanCard({ loan }: { loan: Loan }) {
  const navigate = useNavigate();
  const paidShare = (loan.paid_payments / loan.term_months) * 100;
  return (
    <Card className="clickable fade-in" onClick={() => navigate(`/loans/${loan.id}`)}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon size={44} radius="md" variant="light">
            <IconCreditCard size={24} />
          </ThemeIcon>
          <div>
            <Text fw={800} fz="lg">
              {loan.product_name}
            </Text>
            <Text c="dimmed" fz="sm">
              Договор № {loan.contract_number} · {moneyShort(loan.amount)} под {rate(loan.rate)}
            </Text>
          </div>
        </Group>
      </Group>
      <SimpleGrid cols={{ base: 2, sm: 3 }} mt="lg">
        <Stat label="Остаток долга" value={money(loan.balance)} />
        <Stat
          label="Ближайший платёж"
          value={loan.next_payment_amount ? money(loan.next_payment_amount) : '—'}
          accent
        />
        <Stat label="Дата платежа" value={loan.next_payment_date ? date(loan.next_payment_date) : '—'} />
      </SimpleGrid>
      <Progress value={Math.max(paidShare, 2)} mt="md" radius="xl" size="sm" />
      <Text fz="xs" c="dimmed" mt={6}>
        Оплачено {loan.paid_payments} из {loan.term_months} платежей
      </Text>
    </Card>
  );
}
