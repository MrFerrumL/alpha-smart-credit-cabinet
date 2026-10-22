import {
  Badge,
  Button,
  Card,
  Divider,
  Group,
  List,
  Modal,
  NumberInput,
  Paper,
  ScrollArea,
  SimpleGrid,
  Skeleton,
  Slider,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconArrowRight, IconCheck, IconInfoCircle, IconStarFilled, IconTarget } from '@tabler/icons-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { useCalculation, useCreateApplication, useMatch, useMeta } from '../api/hooks';
import type { ProductMatch, Purpose } from '../api/types';
import { EmptyState, PurposeIcon, Stat } from '../components/ui';
import { money, moneyShort, months, rate } from '../lib/format';

const AMOUNTS = [
  100_000, 300_000, 500_000, 1_000_000, 1_500_000, 2_000_000, 3_000_000, 5_000_000, 7_000_000, 10_000_000,
  15_000_000, 20_000_000, 30_000_000, 50_000_000,
];

function nearestIndex(value: number): number {
  return AMOUNTS.reduce((best, a, i) => (Math.abs(a - value) < Math.abs(AMOUNTS[best] - value) ? i : best), 0);
}

function ScheduleModal({ match, onClose }: { match: ProductMatch | null; onClose: () => void }) {
  const calc = useCalculation(match?.product.code ?? null, match?.amount ?? 0, match?.term_months ?? 0);
  return (
    <Modal opened={match !== null} onClose={onClose} title={<Text fw={800}>График платежей</Text>} size="lg" centered>
      {calc.isLoading || !calc.data ? (
        <Skeleton h={300} />
      ) : (
        <Stack>
          <SimpleGrid cols={3}>
            <Stat label="Платёж" value={money(calc.data.monthly_payment)} />
            <Stat label="Переплата" value={money(calc.data.overpayment)} />
            <Stat label="Всего" value={money(calc.data.total)} />
          </SimpleGrid>
          <ScrollArea h={360}>
            <Table striped stickyHeader fz="sm">
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
                {calc.data.schedule.map((r) => (
                  <Table.Tr key={r.n}>
                    <Table.Td>{r.n}</Table.Td>
                    <Table.Td ta="right">{money(r.payment)}</Table.Td>
                    <Table.Td ta="right">{money(r.principal)}</Table.Td>
                    <Table.Td ta="right">{money(r.interest)}</Table.Td>
                    <Table.Td ta="right">{money(r.balance)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
          <Text fz="xs" c="dimmed">
            Расчёт предварительный, по минимальной ставке продукта. Точные условия банк покажет после рассмотрения заявки.
          </Text>
        </Stack>
      )}
    </Modal>
  );
}

function OfferCard({
  match,
  best,
  loading,
  onApply,
  onSchedule,
}: {
  match: ProductMatch;
  best: boolean;
  loading: boolean;
  onApply: () => void;
  onSchedule: () => void;
}) {
  const p = match.product;
  return (
    <Card className={best ? 'best-offer fade-in' : 'fade-in'} p={{ base: 'lg', sm: 'xl' }} shadow={best ? 'md' : 'xs'}>
      <Group gap="xs" mb="xs">
        {best && (
          <Badge leftSection={<IconStarFilled size={11} />} variant="filled">
            Лучше всего подходит
          </Badge>
        )}
        {match.fit === 'partial' && (
          <Badge color="orange" variant="light">
            Подходит с оговорками
          </Badge>
        )}
        <Badge color="gray" variant="light">
          {p.decision === 'auto' ? 'Автоматическое решение' : 'Рассматривает специалист'}
        </Badge>
      </Group>
      <Title order={3}>{p.name}</Title>
      <Text c="dimmed">{p.tagline}</Text>

      <SimpleGrid cols={{ base: 2, sm: 4 }} mt="lg" spacing="lg">
        <Stat
          label={p.repayment === 'interest_only' ? 'Проценты в месяц' : 'Платёж в месяц'}
          value={`≈ ${money(match.monthly_payment)}`}
          accent
        />
        <Stat label="Сумма" value={moneyShort(match.amount)} />
        <Stat label="Срок" value={months(match.term_months)} />
        <Stat label="Ставка" value={`от ${rate(p.rate)}`} />
      </SimpleGrid>

      <Divider my="lg" />

      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg">
        <List
          spacing={8}
          fz="sm"
          icon={
            <ThemeIcon color="teal" size={20} radius="xl">
              <IconCheck size={12} stroke={3} />
            </ThemeIcon>
          }
        >
          {match.reasons.map((r) => (
            <List.Item key={r}>{r}</List.Item>
          ))}
        </List>
        <Stack gap={8}>
          {match.caveats.map((c) => (
            <Group key={c} gap={8} wrap="nowrap" align="flex-start">
              <IconInfoCircle size={20} color="var(--mantine-color-orange-6)" style={{ flex: '0 0 auto' }} />
              <Text fz="sm">{c}</Text>
            </Group>
          ))}
          <Text fz="sm" c="dimmed">
            Понадобится: {p.documents.join(', ').toLowerCase()}
          </Text>
        </Stack>
      </SimpleGrid>

      <Group mt="xl">
        <Button size="md" onClick={onApply} loading={loading} rightSection={<IconArrowRight size={18} />}>
          Оформить заявку
        </Button>
        <Button size="md" variant="subtle" onClick={onSchedule}>
          График платежей
        </Button>
      </Group>
    </Card>
  );
}

export function MatchPage() {
  const meta = useMeta();
  const navigate = useNavigate();
  const [purpose, setPurpose] = useState<Purpose | null>(null);
  const [amount, setAmount] = useState(3_000_000);
  const [term, setTerm] = useState(12);
  const [debouncedAmount] = useDebouncedValue(amount, 300);
  const [debouncedTerm] = useDebouncedValue(term, 300);
  const match = useMatch({ purpose, amount: debouncedAmount, term_months: debouncedTerm });
  const create = useCreateApplication();
  const [applying, setApplying] = useState<string | null>(null);
  const [scheduleFor, setScheduleFor] = useState<ProductMatch | null>(null);

  const apply = (m: ProductMatch) => {
    if (!purpose) return;
    setApplying(m.product.code);
    create.mutate(
      { product_code: m.product.code, purpose, amount: m.amount, term_months: m.term_months },
      {
        onSuccess: (app) => navigate(`/applications/${app.id}`),
        onSettled: () => setApplying(null),
      },
    );
  };

  return (
    <Stack gap="xl">
      <div>
        <Title order={2}>Подберём кредит под вашу задачу</Title>
        <Text c="dimmed" mt={4}>
          Три вопроса — и вы увидите подходящие продукты с платежом. Ни к чему не обязывает.
        </Text>
      </div>

      <Card p={{ base: 'lg', sm: 'xl' }}>
        <Title order={4}>1. Для чего нужны деньги?</Title>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} mt="md" spacing="sm">
          {meta.data?.purposes.map((p) => (
            <UnstyledButton key={p.code} onClick={() => setPurpose(p.code)}>
              <Paper
                className="selectable clickable"
                data-selected={purpose === p.code}
                p="md"
                h="100%"
                bg={purpose === p.code ? undefined : 'gray.0'}
              >
                <Group wrap="nowrap" align="flex-start" gap="sm">
                  <ThemeIcon size={40} radius="md" variant={purpose === p.code ? 'filled' : 'light'}>
                    <PurposeIcon name={p.icon} />
                  </ThemeIcon>
                  <div>
                    <Text fw={700} lh={1.3}>
                      {p.title}
                    </Text>
                    <Text fz="xs" c="dimmed" mt={2}>
                      {p.description}
                    </Text>
                  </div>
                </Group>
              </Paper>
            </UnstyledButton>
          )) ?? <Skeleton h={80} />}
        </SimpleGrid>

        <Title order={4} mt={36}>
          2. Сколько и на какой срок
        </Title>
        <SimpleGrid cols={{ base: 1, md: 2 }} mt="md" spacing={40}>
          <Stack gap="md">
            <NumberInput
              label="Сумма"
              size="md"
              value={amount}
              onChange={(v) => setAmount(typeof v === 'number' ? v : Number(v) || 0)}
              min={100_000}
              max={50_000_000}
              step={100_000}
              thousandSeparator=" "
              suffix=" ₽"
              allowNegative={false}
              allowDecimal={false}
            />
            <Slider
              min={0}
              max={AMOUNTS.length - 1}
              step={1}
              value={nearestIndex(amount)}
              onChange={(i) => setAmount(AMOUNTS[i])}
              label={(i) => moneyShort(AMOUNTS[i])}
              marks={[
                { value: 0, label: '100 тыс.' },
                { value: 6, label: '3 млн' },
                { value: 9, label: '10 млн' },
                { value: 13, label: '50 млн' },
              ]}
              mb="lg"
            />
          </Stack>
          <Stack gap="md">
            <div>
              <Text fz="sm" fw={500}>
                Срок
              </Text>
              <Text fz={28} fw={800} lh={1.2} mt={4}>
                {months(term)}
              </Text>
            </div>
            <Slider
              min={3}
              max={60}
              step={3}
              value={term}
              onChange={setTerm}
              label={(v) => months(v)}
              marks={[
                { value: 6, label: '6 мес' },
                { value: 12, label: '1 год' },
                { value: 24, label: '2 года' },
                { value: 36, label: '3 года' },
                { value: 60, label: '5 лет' },
              ]}
              mb="lg"
            />
          </Stack>
        </SimpleGrid>
      </Card>

      <Stack gap="md">
        <Title order={4}>3. Подходящие варианты</Title>
        {!purpose ? (
          <EmptyState
            icon={IconTarget}
            title="Выберите цель кредита"
            text="Мы покажем продукты, которые подходят именно под вашу задачу, и сразу посчитаем платёж."
          />
        ) : match.isLoading ? (
          <Skeleton h={320} radius="lg" />
        ) : (
          match.data?.map((m, i) => (
            <OfferCard
              key={m.product.code}
              match={m}
              best={i === 0 && m.fit === 'best'}
              loading={applying === m.product.code}
              onApply={() => apply(m)}
              onSchedule={() => setScheduleFor(m)}
            />
          ))
        )}
      </Stack>

      <ScheduleModal match={scheduleFor} onClose={() => setScheduleFor(null)} />
    </Stack>
  );
}
