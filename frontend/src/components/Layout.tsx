import { Menu, Text, UnstyledButton } from '@mantine/core';
import {
  IconActivity,
  IconAdjustments,
  IconChevronDown,
  IconCreditCard,
  IconFileText,
  IconHome2,
  IconListCheck,
  IconLogout,
  IconSearch,
  IconUser,
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
  short: string;
  icon: Icon;
}

const CLIENT_NAV: NavItem[] = [
  { to: '/', label: 'Главная', short: 'Главная', icon: IconHome2 },
  { to: '/match', label: 'Подобрать кредит', short: 'Подбор', icon: IconSearch },
  { to: '/applications', label: 'Мои заявки', short: 'Заявки', icon: IconFileText },
  { to: '/loans', label: 'Мои кредиты', short: 'Кредиты', icon: IconCreditCard },
];

const ANALYST_NAV: NavItem[] = [
  { to: '/queue', label: 'Очередь заявок', short: 'Очередь', icon: IconListCheck },
  { to: '/policy', label: 'Кредитная политика', short: 'Политика', icon: IconAdjustments },
  { to: '/system', label: 'Состояние системы', short: 'Система', icon: IconActivity },
];

/** Меню профиля: кто вошёл и выход. */
function ProfileMenu() {
  const { user, signOut } = useAuth();
  if (!user) return null;
  return (
    <Menu position="bottom-end" width={260}>
      <Menu.Target>
        <UnstyledButton className="potok-profile" aria-label={`Профиль: ${user.full_name}`}>
          <span className="potok-avatar">{initials(user.full_name)}</span>
          <span className="potok-profile-name">{user.full_name}</span>
          <IconChevronDown size={16} className="potok-profile-name" />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <div className="potok-profile-card">
          <Text fw={600}>{user.full_name}</Text>
          <Text fz="sm" c="dimmed">
            {user.position}
          </Text>
          {user.company && (
            <Text fz="sm" c="dimmed">
              {user.company.short_name}
            </Text>
          )}
        </div>
        <Menu.Divider />
        <Menu.Item component={Link} to="/profile" leftSection={<IconUser size={18} />}>
          Профиль
        </Menu.Item>
        <Menu.Item leftSection={<IconLogout size={18} />} onClick={signOut}>
          Выйти
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

/** Каркас кабинета: шапка с вкладками, на телефоне — нижняя панель (в анкете её место занимают кнопки шага). */
export function Layout() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const nav = user?.role === 'analyst' ? ANALYST_NAV : CLIENT_NAV;
  const inWizard = /^\/applications\/\d+\/edit$/.test(pathname);
  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to));

  return (
    <div className="potok-shell" data-tabbar={!inWizard}>
      <header className="potok-header">
        <div className="potok-wrap potok-top">
          <Link to={user?.role === 'analyst' ? '/queue' : '/'} className="potok-brand">
            <Logo />
          </Link>
          <span className="potok-org">{user?.company ? user.company.short_name : user?.role === 'analyst' ? 'Кабинет аналитика' : null}</span>
          <span className="potok-spacer" />
          <NotificationsBell />
          <ProfileMenu />
        </div>
        <nav className="potok-wrap potok-tabs" aria-label="Разделы">
          {nav.map((item) => (
            <Link key={item.to} to={item.to} aria-current={isActive(item.to) ? 'page' : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>
      </header>

      <main className="potok-wrap potok-page">
        <Outlet />
      </main>

      {!inWizard && (
        <nav className="potok-tabbar" aria-label="Нижняя панель разделов" style={{ gridTemplateColumns: `repeat(${nav.length}, 1fr)` }}>
          {nav.map((item) => (
            <Link key={item.to} to={item.to} aria-current={isActive(item.to) ? 'page' : undefined}>
              <item.icon size={22} stroke={1.7} />
              <span>{item.short}</span>
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
