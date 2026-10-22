import {
  Avatar,
  Box,
  Button,
  Collapse,
  Divider,
  Group,
  Loader,
  PasswordInput,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconArrowRight, IconBolt, IconListDetails, IconShieldCheck, IconSparkles } from '@tabler/icons-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';

import { api } from '../api/client';
import { notifyError, useDemoAccounts } from '../api/hooks';
import type { DemoAccount, TokenResponse } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Logo, toneColor } from '../components/ui';
import { initials } from '../lib/format';

const FEATURES = [
  { icon: IconSparkles, text: 'Подберём продукт под задачу бизнеса и покажем платёж до подачи заявки' },
  { icon: IconListDetails, text: 'Данные компании подтянутся из ЕГРЮЛ — заполнять почти ничего не нужно' },
  { icon: IconBolt, text: 'Статус заявки обновляется в реальном времени: видно, что происходит и что делать' },
  { icon: IconShieldCheck, text: 'Решение, подписание и выдача — в одном кабинете, без визита в банк' },
];

function AccountButton({ account, pending, onClick }: { account: DemoAccount; pending: boolean; onClick: () => void }) {
  return (
    <UnstyledButton onClick={onClick} disabled={pending}>
      <Box
        className="clickable"
        p="md"
        style={{ background: '#fff', borderRadius: 16, border: '1px solid var(--app-line)' }}
      >
        <Group wrap="nowrap" gap="md">
          <Avatar color={toneColor(account.scenario_tone)} radius="xl" size={44}>
            {initials(account.full_name)}
          </Avatar>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text fw={700} truncate>
              {account.full_name}
            </Text>
            <Text fz="xs" c="dimmed" truncate>
              {account.position}
              {account.company_name ? ` · ${account.company_name}` : ''}
            </Text>
            <Text fz="sm" mt={4} lh={1.35}>
              {account.scenario}
            </Text>
          </div>
          {pending ? <Loader size="sm" /> : <IconArrowRight size={18} color="var(--mantine-color-gray-5)" />}
        </Group>
      </Box>
    </UnstyledButton>
  );
}

export function LoginPage() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const accounts = useDemoAccounts();
  const [pending, setPending] = useState<string | null>(null);
  const [formOpened, { toggle }] = useDisclosure(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (user) return <Navigate to={user.role === 'analyst' ? '/queue' : '/'} replace />;

  const finish = (token: TokenResponse) => {
    signIn(token);
    navigate(token.user.role === 'analyst' ? '/queue' : '/', { replace: true });
  };

  const demoLogin = async (account: DemoAccount) => {
    setPending(account.email);
    try {
      finish(await api<TokenResponse>('/auth/demo-login', { method: 'POST', json: { email: account.email } }));
    } catch (e) {
      notifyError(e);
    } finally {
      setPending(null);
    }
  };

  const passwordLogin = async (event: FormEvent) => {
    event.preventDefault();
    setPending('form');
    try {
      finish(await api<TokenResponse>('/auth/login', { method: 'POST', json: { email, password } }));
    } catch (e) {
      notifyError(e);
    } finally {
      setPending(null);
    }
  };

  const clients = accounts.data?.filter((a) => a.role === 'client') ?? [];
  const staff = accounts.data?.filter((a) => a.role === 'analyst') ?? [];

  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing={0} mih="100vh">
      <Box className="hero login-hero" p={{ base: 'xl', md: 56 }} style={{ display: 'flex', flexDirection: 'column', gap: 40 }}>
        <Logo inverted />
        <Stack gap="lg" style={{ position: 'relative', zIndex: 1 }} maw={520} my="auto">
          <Title order={1} fz={{ base: 32, md: 44 }} lh={1.1} c="white">
            Кредит для бизнеса — от идеи до денег на счёте в одном окне
          </Title>
          <Text fz="lg" c="rgba(255,255,255,0.9)">
            Умный кредитный кабинет для малого и микробизнеса: понятный путь для предпринимателя и управляемый процесс
            для банка.
          </Text>
          <Stack gap="md" mt="md">
            {FEATURES.map((f) => (
              <Group key={f.text} wrap="nowrap" align="flex-start" gap="md">
                <ThemeIcon size={36} radius="md" color="white" variant="white">
                  <f.icon size={20} color="#ef3124" />
                </ThemeIcon>
                <Text c="white" fw={500} lh={1.4}>
                  {f.text}
                </Text>
              </Group>
            ))}
          </Stack>
        </Stack>
        <Text fz="xs" c="rgba(255,255,255,0.75)" style={{ position: 'relative', zIndex: 1 }}>
          Прототип для Альфа-Хакатона 2026. Все компании и люди вымышлены, данные синтетические.
        </Text>
      </Box>

      <Box p={{ base: 'md', md: 56 }} style={{ display: 'flex', justifyContent: 'center' }}>
        <Stack gap="lg" w="100%" maw={520}>
          <div>
            <Title order={2}>Вход в кабинет</Title>
            <Text c="dimmed" mt={6}>
              Выберите тестовую учётную запись. Каждая показывает свой сценарий кредитного конвейера.
            </Text>
          </div>

          <Stack gap="sm">
            <Text fz="xs" fw={700} tt="uppercase" c="dimmed" lts={0.5}>
              Предприниматели
            </Text>
            {accounts.isLoading && [0, 1, 2].map((i) => <Skeleton key={i} h={92} radius="lg" />)}
            {clients.map((a) => (
              <AccountButton key={a.email} account={a} pending={pending === a.email} onClick={() => demoLogin(a)} />
            ))}
          </Stack>

          {staff.length > 0 && (
            <Stack gap="sm">
              <Text fz="xs" fw={700} tt="uppercase" c="dimmed" lts={0.5}>
                Сотрудник банка
              </Text>
              {staff.map((a) => (
                <AccountButton key={a.email} account={a} pending={pending === a.email} onClick={() => demoLogin(a)} />
              ))}
            </Stack>
          )}

          <Divider label="или" />
          <Button variant="default" onClick={toggle}>
            Войти по почте и паролю
          </Button>
          <Collapse in={formOpened}>
            <form onSubmit={passwordLogin}>
              <Stack gap="sm">
                <TextInput
                  label="Почта"
                  placeholder="bakery@demo.local"
                  value={email}
                  onChange={(e) => setEmail(e.currentTarget.value)}
                  autoComplete="username"
                  required
                />
                <PasswordInput
                  label="Пароль"
                  value={password}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                  autoComplete="current-password"
                  description="У всех тестовых учёток пароль demo1234"
                  required
                />
                <Button type="submit" loading={pending === 'form'}>
                  Войти
                </Button>
              </Stack>
            </form>
          </Collapse>
        </Stack>
      </Box>
    </SimpleGrid>
  );
}
