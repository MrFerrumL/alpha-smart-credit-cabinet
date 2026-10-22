import { AppShell, Avatar, Burger, Button, Container, Group, NavLink, Stack, Text } from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import {
  IconCreditCard,
  IconFileText,
  IconHome2,
  IconAdjustments,
  IconListCheck,
  IconLogout,
  IconSparkles,
  type Icon,
} from '@tabler/icons-react';
import { Link, Outlet, useLocation } from 'react-router';

import { useAuth } from '../auth/AuthContext';
import { initials } from '../lib/format';
import { NotificationsBell } from './Notifications';
import { Logo } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: Icon;
}

const CLIENT_NAV: NavItem[] = [
  { to: '/', label: 'Главная', icon: IconHome2 },
  { to: '/match', label: 'Подобрать кредит', icon: IconSparkles },
  { to: '/applications', label: 'Мои заявки', icon: IconFileText },
  { to: '/loans', label: 'Мои кредиты', icon: IconCreditCard },
];

const ANALYST_NAV: NavItem[] = [
  { to: '/queue', label: 'Очередь заявок', icon: IconListCheck },
  { to: '/policy', label: 'Кредитная политика', icon: IconAdjustments },
];

export function Layout() {
  const { user, signOut } = useAuth();
  const [opened, { toggle, close }] = useDisclosure();
  const mobile = useMediaQuery('(max-width: 48em)');
  const { pathname } = useLocation();
  const nav = user?.role === 'analyst' ? ANALYST_NAV : CLIENT_NAV;

  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to));

  return (
    <AppShell
      header={{ height: 60, collapsed: !mobile }}
      navbar={{ width: 272, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding={0}
    >
      <AppShell.Header px="md">
        <Group h="100%" justify="space-between">
          <Logo />
          <Group gap="xs">
            {mobile && <NotificationsBell />}
            <Burger opened={opened} onClick={toggle} size="sm" aria-label="Меню" />
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="md" style={{ borderRight: '1px solid var(--app-line)' }}>
        <Group visibleFrom="sm" px="xs" pt="xs" pb="lg" justify="space-between" wrap="nowrap">
          <Logo />
          {!mobile && <NotificationsBell />}
        </Group>
        <Stack gap={4} style={{ flex: 1 }}>
          {nav.map((item) => (
            <NavLink
              key={item.to}
              component={Link}
              to={item.to}
              label={item.label}
              leftSection={<item.icon size={20} stroke={1.8} />}
              active={isActive(item.to)}
              onClick={close}
              className="nav-link"
              variant="light"
            />
          ))}
        </Stack>
        {user && (
          <Stack gap="sm" pt="md" style={{ borderTop: '1px solid var(--app-line)' }}>
            <Group gap="sm" wrap="nowrap">
              <Avatar color="brand" radius="xl">
                {initials(user.full_name)}
              </Avatar>
              <div style={{ minWidth: 0 }}>
                <Text fw={700} fz="sm" truncate>
                  {user.full_name}
                </Text>
                <Text fz="xs" c="dimmed" truncate>
                  {user.company ? user.company.short_name : user.position}
                </Text>
              </div>
            </Group>
            <Button variant="subtle" color="gray" leftSection={<IconLogout size={18} />} onClick={signOut} justify="flex-start">
              Выйти
            </Button>
          </Stack>
        )}
      </AppShell.Navbar>

      <AppShell.Main>
        <Container size={1180} px={{ base: 'md', md: 'xl' }} py={{ base: 'lg', md: 40 }}>
          <Outlet />
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
