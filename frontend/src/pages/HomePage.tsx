import { Anchor, Badge, Button, Group, Paper, SimpleGrid, Skeleton, Text, TextInput, Title } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { ApiError } from '../api/client';
import { useApplications, useCompanyLookup, useLinkCompany, useLoans } from '../api/hooks';
import type { Application, Loan } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { AppRow } from '../components/AppRow';
import { AppStatusCard } from '../components/AppStatusCard';
import { NewsFeed } from '../components/NewsFeed';
import { LoadError } from '../components/States';
import { CompanyCard, MoreMoney, RecentNotifications } from '../components/Side';
import { NBSP, dayMonth, greeting, money } from '../lib/format';
import { nb } from '../lib/nobreak';

/** Своя иллюстрация промоблока: серые столбики роста, графитовая база и одна красная волна «Потока». */
function GrowthArt() {
  return (
    <svg className="potok-promo-art" viewBox="0 0 280 180" fill="none" aria-hidden="true">
      <rect x="0" y="0" width="280" height="180" rx="24" fill="#f2f3f5" />
      <rect x="36" y="112" width="28" height="40" rx="6" fill="#d2d3d9" />
      <rect x="80" y="96" width="28" height="56" rx="6" fill="#d2d3d9" />
      <rect x="124" y="80" width="28" height="72" rx="6" fill="#babbc2" />
      <rect x="168" y="60" width="28" height="92" rx="6" fill="#babbc2" />
      <rect x="212" y="36" width="28" height="116" rx="6" fill="#898991" />
      <path d="M28 152h224" stroke="#212124" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M34 84c12 0 16-26 28-26s16 36 28 36 16-36 28-36 14 18 22 18"
        stroke="#ef3124"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="226" cy="22" r="7" fill="#fff" stroke="#212124" strokeWidth="2" />
    </svg>
  );
}

/** Промоблок — главный, когда активной заявки нет. */
function Promo() {
  return (
    <section className="potok-panel potok-promo">
      <div>
        <Title order={2}>Деньги на развитие бизнеса</Title>
        <Text className="potok-note" mt="sm">
          Подберём кредит под задачу и покажем платёж ещё до заявки. Данные компании уже у нас, заполнять почти
          ничего не нужно.
        </Text>
        <Button component={Link} to="/match" size="lg" mt="lg">
          Подобрать кредит
        </Button>
        <dl className="potok-promo-facts">
          <div>
            <dt>до{NBSP}50 млн{NBSP}₽</dt>
            <dd>на любые цели</dd>
          </div>
          <div>
            <dt>от{NBSP}15 минут</dt>
            <dd>до решения</dd>
          </div>
          <div>
            <dt>0 визитов</dt>
            <dd>в офис банка</dd>
          </div>
        </dl>
      </div>
      <GrowthArt />
    </section>
  );
}

function LoansBrief({ loans }: { loans: Loan[] }) {
  return (
    <section className="potok-panel">
      <div className="potok-panel-head">
        <Title order={3}>Мои кредиты</Title>
        <Anchor component={Link} to="/loans" className="potok-link">
          Все кредиты
        </Anchor>
      </div>
      <ul className="potok-rows">
        {loans.slice(0, 2).map((loan) => (
          <li key={loan.id}>
            <Link to={`/loans/${loan.id}`} className="potok-row">
              <span className="potok-row-main">
                <span className="potok-row-title">{nb(loan.product_name)}</span>
                <span className="potok-row-sub">
                  Основной долг к погашению {money(loan.balance)}
                </span>
              </span>
              {loan.next_payment_amount && loan.next_payment_date && (
                <span className="potok-row-side num">
                  {money(loan.next_payment_amount)}
                  <span>{dayMonth(loan.next_payment_date)}</span>
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function OtherApps({ apps }: { apps: Application[] }) {
  return (
    <section className="potok-panel">
      <div className="potok-panel-head">
        <Title order={3}>Мои заявки</Title>
        <Anchor component={Link} to="/applications" className="potok-link">
          Все заявки
        </Anchor>
      </div>
      <ul className="potok-rows">
        {apps.map((a) => (
          <AppRow key={a.id} app={a} />
        ))}
      </ul>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className="potok-panel">
      <Title order={3}>Как это работает</Title>
      <ol className="potok-steps">
        <li>Выберите цель и сумму, а мы подберём продукт</li>
        <li>Отправьте заявку: данные компании уже заполнены</li>
        <li>Следите за статусом, он обновляется сам</li>
        <li>Подпишите договор в кабинете, и деньги придут на счёт</li>
      </ol>
    </section>
  );
}

function CompanyOnboarding() {
  const { refresh } = useAuth();
  const [inn, setInn] = useState('');
  const lookup = useCompanyLookup();
  const link = useLinkCompany();
  const found = lookup.data;
  const lookupError = lookup.error instanceof ApiError ? lookup.error : null;
  // Эмулятор ЕГРЮЛ знает только вымышленные компании: ИНН реальной организации в демо не найдётся.
  const lookupMessage = !lookupError
    ? undefined
    : lookupError.status === 404
      ? `${lookupError.message}. В демо все компании вымышлены — их ИНН начинаются с «00»`
      : (lookupError.errors?.[0]?.message ?? lookupError.message);
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
    <section className="potok-panel" style={{ maxWidth: 680 }}>
      <Title order={3}>Расскажите о компании</Title>
      <Text c="dimmed" mt={4}>
        Введите ИНН — мы сами подтянем данные из ЕГРЮЛ, и вручную ничего заполнять не придётся.
      </Text>
      <Group mt="lg" align="flex-start" wrap="nowrap">
        <TextInput
          style={{ flex: 1 }}
          label="ИНН компании или ИП"
          placeholder="10 или 12 цифр"
          inputMode="numeric"
          value={inn}
          onChange={(e) => {
            setInn(e.currentTarget.value.replace(/\D/g, '').slice(0, 12));
            lookup.reset();
          }}
          error={lookupMessage}
        />
        <Button size="lg" leftSection={<IconSearch size={18} />} loading={lookup.isPending} disabled={!ready} onClick={() => lookup.mutate(inn)}>
          Найти
        </Button>
      </Group>
      <Text fz="sm" c="dimmed" mt={6}>
        Для демо:{' '}
        <Anchor component="button" type="button" fz="sm" className="potok-link" onClick={() => setInn('0077070071')}>
          0077070071
        </Anchor>{' '}
        — ООО «Новые горизонты»
      </Text>

      {found && (
        <Paper withBorder p="lg" mt="lg" radius="lg" className="fade-in">
          <Group justify="space-between" align="flex-start">
            <div>
              <Text fw={600} fz="lg">
                {found.short_name}
              </Text>
              <Text fz="sm" c="dimmed">
                ИНН{NBSP}{found.inn}
                {found.ogrn ? `, ОГРН ${found.ogrn}` : ''}
              </Text>
            </div>
            <Badge color={found.status === 'active' ? 'teal' : 'orange'} variant="light">
              {found.status_title}
            </Badge>
          </Group>
          <SimpleGrid cols={{ base: 1, sm: 2 }} mt="md" spacing="sm">
            <div>
              <Text fz="sm" c="dimmed">
                Руководитель
              </Text>
              <Text fw={500}>{found.director}</Text>
            </div>
            <div>
              <Text fz="sm" c="dimmed">
                Вид деятельности
              </Text>
              <Text fw={500}>
                {found.okved} — {found.okved_name}
              </Text>
            </div>
            <div>
              <Text fz="sm" c="dimmed">
                Адрес
              </Text>
              <Text fw={500}>{found.address}</Text>
            </div>
          </SimpleGrid>
          <Button mt="lg" size="lg" onClick={confirm} loading={link.isPending}>
            Да, это моя компания
          </Button>
        </Paper>
      )}
    </section>
  );
}

/** Какую заявку показать первой: та, где ход за клиентом, иначе самая свежая из идущих. */
function mainApplication(list: Application[]): Application | undefined {
  const active = list.filter((a) => !a.status.terminal);
  return [...active].sort((a, b) => Number(b.status.action_required) - Number(a.status.action_required) || b.id - a.id)[0];
}

export function HomePage() {
  const { user } = useAuth();
  const apps = useApplications();
  const loans = useLoans(!!user?.company);
  if (!user) return null;
  const firstName = user.full_name.split(' ')[0];

  if (!user.company) {
    return (
      <div className="potok-col">
        <div>
          <Title order={1}>
            {greeting()}, {firstName}
          </Title>
          <Text c="dimmed" mt={4}>
            Осталось одно действие, чтобы открыть кредитный кабинет
          </Text>
        </div>
        <CompanyOnboarding />
      </div>
    );
  }

  const list = apps.data ?? [];
  const main = mainApplication(list);
  // Та же единственная заявка второй раз не показывается.
  const others = list.filter((a) => a.id !== main?.id).slice(0, 3);

  return (
    <div className="potok-col">
      <div>
        <Title order={1}>
          {greeting()}, {firstName}
        </Title>
        <Text c="dimmed" mt={4}>
          {user.company.short_name}
          {user.position ? `, ${user.position.toLowerCase()}` : ''}
        </Text>
      </div>
      {/* Слева — то, с чем работать: главная заявка, остальные заявки, лента; справа — уведомления, кредиты,
          короткий подбор и компания. */}
      <div className="potok-home">
        <div className="potok-col">
          {!user.can_sign && (
            <div className="potok-inline-note" style={{ marginTop: 0 }}>
              Вы можете готовить и отправлять заявки. Подписать договор сможет только руководитель компании.
            </div>
          )}
          {apps.isLoading ? (
            <Skeleton h={240} radius={24} />
          ) : apps.isError ? (
            <LoadError error={apps.error} what="заявки" />
          ) : main ? (
            <AppStatusCard app={main} />
          ) : (
            <Promo />
          )}
          {others.length > 0 && <OtherApps apps={others} />}
          <NewsFeed />
        </div>
        <div className="potok-col">
          <RecentNotifications exclude={main ? `/applications/${main.id}` : undefined} />
          {!!loans.data?.length && <LoansBrief loans={loans.data} />}
          {main && <MoreMoney />}
          <CompanyCard company={user.company} />
          {!main && <HowItWorks />}
        </div>
      </div>
    </div>
  );
}
