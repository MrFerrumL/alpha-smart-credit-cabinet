import {
  Badge,
  Button,
  Card,
  Divider,
  Group,
  List,
  Modal,
  ScrollArea,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconArrowRight, IconCheck, IconInfoCircle, IconStarFilled, IconTarget } from '@tabler/icons-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { useCalculation, useCreateApplication, useMatch, useMeta } from '../api/hooks';
import type { ProductMatch, Purpose } from '../api/types';
import { ChoiceList } from '../components/Choice';
import { AmountControl, TermControl, amountTicks } from '../components/Money';
import { EmptyState, Stat } from '../components/ui';
import { money, moneyShort, months, rate } from '../lib/format';

const MIN_AMOUNT = 100_000;
const MAX_AMOUNT = 50_000_000;

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
        onSuccess: (app) => navigate(`/applications/${app.id}/edit`),
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
        <div style={{ marginTop: 16, maxWidth: 672 }}>
          {meta.data ? (
            <ChoiceList
              label="Для чего нужны деньги"
              value={purpose}
              onChange={setPurpose}
              options={meta.data.purposes.map((p) => ({ value: p.code, title: p.title, text: p.description }))}
            />
          ) : (
            <Skeleton h={320} radius="md" />
          )}
        </div>

        <Title order={4} mt={36}>
          2. Сколько и на какой срок
        </Title>
        <SimpleGrid cols={{ base: 1, md: 2 }} mt="md" spacing={40}>
          <AmountControl
            label="Сумма"
            sliderLabel="Ползунок суммы"
            value={amount}
            onChange={setAmount}
            min={MIN_AMOUNT}
            max={MAX_AMOUNT}
            step={100_000}
            ticks={amountTicks(MIN_AMOUNT, MAX_AMOUNT)}
          />
          {/* До выбора продукта — общий диапазон всех продуктов; подбор сам подгонит срок под продукт. */}
          <TermControl value={term} onChange={setTerm} min={3} max={60} step={3} />
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
