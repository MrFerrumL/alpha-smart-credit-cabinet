import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Grid,
  Group,
  Paper,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconArrowRight, IconBuildingStore, IconFileText, IconInfoCircle, IconSearch } from '@tabler/icons-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { ApiError } from '../api/client';
import { useApplications, useCompanyLookup, useLinkCompany, useLoans } from '../api/hooks';
import type { Company } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ApplicationCard } from '../components/ApplicationCard';
import { LoanCard } from '../components/LoanCard';
import { EmptyState, Section } from '../components/ui';
import { greeting, plural, yearsSince } from '../lib/format';

function HeroCard() {
  return (
    <Paper className="hero" p={{ base: 'lg', sm: 32 }} radius="xl">
      <Stack gap="md" style={{ position: 'relative', zIndex: 1 }} maw={560}>
        <Title order={2} c="white" lh={1.15}>
          Деньги на развитие бизнеса
        </Title>
        <Text c="rgba(255,255,255,0.92)" fz="lg">
          Подберём кредит под вашу задачу и покажем платёж ещё до подачи заявки. Данные компании уже у нас — заполнять
          почти ничего не нужно.
        </Text>
        <Group mt="xs">
          <Button component={Link} to="/match" variant="white" size="md" rightSection={<IconArrowRight size={18} />}>
            Подобрать кредит
          </Button>
        </Group>
        <SimpleGrid cols={3} mt="sm" spacing="lg" maw={460}>
          {[
            ['до 50 млн ₽', 'на любые цели'],
            ['от 15 минут', 'до решения'],
            ['0 визитов', 'в офис банка'],
          ].map(([value, label]) => (
            <div key={value}>
              <Text c="white" fw={800} fz="lg">
                {value}
              </Text>
              <Text c="rgba(255,255,255,0.8)" fz="xs">
                {label}
              </Text>
            </div>
          ))}
        </SimpleGrid>
      </Stack>
    </Paper>
  );
}

function CompanyCard({ company }: { company: Company }) {
  const years = company.registered_at ? yearsSince(company.registered_at) : null;
  const rows: [string, string | null][] = [
    ['ИНН', company.inn],
    ['ОГРН', company.ogrn],
    ['Вид деятельности', company.okved ? `${company.okved} — ${company.okved_name}` : null],
    ['Руководитель', company.director],
    ['Адрес', company.address],
  ];
  return (
    <Card>
      <Group gap="sm" wrap="nowrap">
        <ThemeIcon size={42} radius="md" variant="light">
          <IconBuildingStore size={22} />
        </ThemeIcon>
        <div style={{ minWidth: 0 }}>
          <Text fw={800} lh={1.3} lineClamp={2}>
            {company.short_name}
          </Text>
          {years !== null && (
            <Text fz="xs" c="dimmed">
              {years > 0 ? `${years} ${plural(years, ['год', 'года', 'лет'])} на рынке` : 'Меньше года на рынке'}
            </Text>
          )}
        </div>
      </Group>
      <Stack gap={10} mt="md">
        {rows
          .filter(([, v]) => v)
          .map(([label, value]) => (
            <div key={label}>
              <Text fz="xs" c="dimmed">
                {label}
              </Text>
              <Text fz="sm" fw={600}>
                {value}
              </Text>
            </div>
          ))}
      </Stack>
      <Text fz="xs" c="dimmed" mt="md">
        Данные из ЕГРЮЛ — подставляются в заявки автоматически.
      </Text>
    </Card>
  );
}

const STEPS = [
  'Выберите цель и сумму — мы подберём подходящий продукт',
  'Отправьте заявку — данные компании уже заполнены',
  'Следите за статусом — он обновляется сам',
  'Подпишите договор в кабинете — деньги придут на счёт',
];

function HowItWorks() {
  return (
    <Card>
      <Title order={5}>Как это работает</Title>
      <Stack gap="sm" mt="md">
        {STEPS.map((step, i) => (
          <Group key={step} wrap="nowrap" align="flex-start" gap="sm">
            <ThemeIcon size={26} radius="xl" variant="light" style={{ flex: '0 0 auto' }}>
              <Text fz="xs" fw={800}>
                {i + 1}
              </Text>
            </ThemeIcon>
            <Text fz="sm" lh={1.4}>
              {step}
            </Text>
          </Group>
        ))}
      </Stack>
    </Card>
  );
}

function CompanyOnboarding() {
  const { refresh } = useAuth();
  const [inn, setInn] = useState('');
  const lookup = useCompanyLookup();
  const link = useLinkCompany();
  const found = lookup.data;
  const lookupError = lookup.error instanceof ApiError ? lookup.error : null;
  const ready = inn.length === 10 || inn.length === 12;

  const confirm = async () => {
    if (!found) return;
    try {
      await link.mutateAsync(found.inn);
      await refresh();
    } catch {
      /* ошибка уже показана уведомлением */
    }
  };

  return (
    <Card p="xl" maw={680}>
      <ThemeIcon size={52} radius="md" variant="light">
        <IconBuildingStore size={28} />
      </ThemeIcon>
      <Title order={3} mt="md">
        Расскажите о компании
      </Title>
      <Text c="dimmed" mt={4}>
        Введите ИНН — мы сами подтянем данные из ЕГРЮЛ, и вручную ничего заполнять не придётся.
      </Text>
      <Group mt="lg" align="flex-start" wrap="nowrap">
        <TextInput
          style={{ flex: 1 }}
          size="md"
          label="ИНН компании или ИП"
          placeholder="10 или 12 цифр"
          inputMode="numeric"
          value={inn}
          onChange={(e) => {
            setInn(e.currentTarget.value.replace(/\D/g, '').slice(0, 12));
            lookup.reset();
          }}
          error={lookupError ? (lookupError.errors?.[0]?.message ?? lookupError.message) : undefined}
        />
        <Button
          size="md"
          mt={25}
          leftSection={<IconSearch size={18} />}
          loading={lookup.isPending}
          disabled={!ready}
          onClick={() => lookup.mutate(inn)}
        >
          Найти
        </Button>
      </Group>
      <Text fz="xs" c="dimmed" mt={6}>
        Для демо:{' '}
        <Anchor fz="xs" onClick={() => setInn('0077070071')}>
          0077070071
        </Anchor>{' '}
        — ООО «Новые горизонты»
      </Text>

      {found && (
        <Paper withBorder p="lg" mt="lg" className="fade-in">
          <Group justify="space-between" align="flex-start">
            <div>
              <Text fw={800} fz="lg">
                {found.short_name}
              </Text>
              <Text fz="sm" c="dimmed">
                ИНН {found.inn}
                {found.ogrn ? ` · ОГРН ${found.ogrn}` : ''}
              </Text>
            </div>
            <Badge color={found.status === 'active' ? 'teal' : 'orange'} variant="light">
              {found.status_title}
            </Badge>
          </Group>
          <SimpleGrid cols={{ base: 1, sm: 2 }} mt="md" spacing="sm">
            <div>
              <Text fz="xs" c="dimmed">
                Руководитель
              </Text>
              <Text fz="sm" fw={600}>
                {found.director}
              </Text>
            </div>
            <div>
              <Text fz="xs" c="dimmed">
                Вид деятельности
              </Text>
              <Text fz="sm" fw={600}>
                {found.okved} — {found.okved_name}
              </Text>
            </div>
            <div>
              <Text fz="xs" c="dimmed">
                Адрес
              </Text>
              <Text fz="sm" fw={600}>
                {found.address}
              </Text>
            </div>
          </SimpleGrid>
          <Button mt="lg" onClick={confirm} loading={link.isPending}>
            Да, это моя компания
          </Button>
        </Paper>
      )}
    </Card>
  );
}

export function HomePage() {
  const { user } = useAuth();
  const apps = useApplications();
  const loans = useLoans(!!user?.company);
  if (!user) return null;
  const firstName = user.full_name.split(' ')[0];

  if (!user.company) {
    return (
      <Stack gap="xl">
        <div>
          <Title order={2}>
            {greeting()}, {firstName}
          </Title>
          <Text c="dimmed">Осталось одно действие, чтобы открыть кредитный кабинет</Text>
        </div>
        <CompanyOnboarding />
      </Stack>
    );
  }

  const list = apps.data ?? [];
  const attention = list.filter((a) => a.status.action_required);
  const rest = list.filter((a) => !a.status.action_required).slice(0, 3);

  return (
    <Stack gap="xl">
      <div>
        <Title order={2}>
          {greeting()}, {firstName}
        </Title>
        <Text c="dimmed">
          {user.company.short_name} · {user.position}
        </Text>
      </div>
      <Grid gutter="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="xl">
            <HeroCard />
            {!user.can_sign && (
              <Alert icon={<IconInfoCircle />} color="blue" variant="light" radius="lg">
                Вы можете готовить и отправлять заявки. Подписать договор сможет только руководитель компании.
              </Alert>
            )}
            {!!loans.data?.length && (
              <Section
                title="Мои кредиты"
                action={
                  <Anchor component={Link} to="/loans" fz="sm" fw={600}>
                    Все кредиты
                  </Anchor>
                }
              >
                {loans.data.slice(0, 2).map((loan) => (
                  <LoanCard key={loan.id} loan={loan} />
                ))}
              </Section>
            )}
            {attention.length > 0 && (
              <Section title="Нужно ваше действие">
                {attention.map((a) => (
                  <ApplicationCard key={a.id} app={a} />
                ))}
              </Section>
            )}
            <Section
              title="Мои заявки"
              action={
                list.length > 0 && (
                  <Anchor component={Link} to="/applications" fz="sm" fw={600}>
                    Все заявки
                  </Anchor>
                )
              }
            >
              {apps.isLoading ? (
                <Skeleton h={128} radius="lg" />
              ) : list.length === 0 ? (
                <EmptyState
                  icon={IconFileText}
                  title="Заявок пока нет"
                  text="Подберите продукт под задачу бизнеса — это займёт минуту, а платёж будет виден сразу."
                  action={
                    <Button component={Link} to="/match">
                      Подобрать кредит
                    </Button>
                  }
                />
              ) : rest.length === 0 ? (
                <Text c="dimmed" fz="sm">
                  Остальные заявки — выше, в блоке «Нужно ваше действие».
                </Text>
              ) : (
                rest.map((a) => <ApplicationCard key={a.id} app={a} />)
              )}
            </Section>
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Stack gap="lg">
            <CompanyCard company={user.company} />
            <HowItWorks />
          </Stack>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
