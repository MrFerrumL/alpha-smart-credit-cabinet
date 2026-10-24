import { ActionIcon, Indicator, Popover, ScrollArea, Text, UnstyledButton } from '@mantine/core';
import { notifications as toasts } from '@mantine/notifications';
import { IconBell } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { useNotifications, useReadAllNotifications } from '../api/hooks';
import type { AppNotification } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { dateTime, typo } from '../lib/format';
import { nb } from '../lib/nobreak';

/** «Заявка № 2026-000003» → «Заявка 2026-000003»; число не отрывается от единицы. */
const clean = (text: string) => typo(text.replace(/№\s*(?=\d)/g, ''));

/** Группы по дню: «Сегодня», «Вчера», «Раньше» — время у всех в одном виде. */
function groups(items: AppNotification[]): [string, AppNotification[]][] {
  const day = (iso: string) => new Date(iso).toDateString();
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  const out: [string, AppNotification[]][] = [
    ['Сегодня', items.filter((n) => day(n.created_at) === today)],
    ['Вчера', items.filter((n) => day(n.created_at) === yesterday)],
    ['Раньше', items.filter((n) => ![today, yesterday].includes(day(n.created_at)))],
  ];
  return out.filter(([, g]) => g.length > 0);
}

/** Уведомления внутри кабинета: вместо SMS и почты. Новые показываются всплывающим сообщением. */
export function NotificationsBell() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [opened, setOpened] = useState(false);
  const query = useNotifications(!!user);
  const readAll = useReadAllNotifications();
  const seen = useRef<number | null>(null);
  const items = query.data ?? [];
  const unread = items.filter((n) => !n.read_at).length;

  useEffect(() => {
    if (!query.data) return;
    const maxId = query.data.reduce((max, n) => Math.max(max, n.id), 0);
    if (seen.current === null) {
      seen.current = maxId; // при входе старые уведомления не всплывают
      return;
    }
    const fresh = query.data.filter((n) => n.id > (seen.current ?? 0) && !n.read_at).reverse();
    for (const n of fresh) {
      // Тост — тёмная плашка с текстом, без цветной метки и значка.
      toasts.show({
        title: clean(n.title),
        message: n.body ? clean(n.body) : '',
        autoClose: n.kind === 'signing_code' ? 15_000 : 6_000,
      });
    }
    seen.current = Math.max(seen.current, maxId);
  }, [query.data]);

  const open = (n: AppNotification) => {
    setOpened(false);
    if (n.link) navigate(n.link);
  };

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      width="min(400px, calc(100vw - 32px))"
      position="bottom-end"
      shadow="md"
      radius="lg"
      onOpen={() => unread > 0 && readAll.mutate()}
    >
      <Popover.Target>
        <Indicator label={unread} size={18} disabled={unread === 0} offset={4} color="dark">
          <ActionIcon variant="subtle" color="gray" size="lg" radius="xl" onClick={() => setOpened((o) => !o)} aria-label="Уведомления">
            <IconBell size={22} />
          </ActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown p={0} className="potok-ntf">
        <div className="potok-ntf-head">
          <Text fw={600} fz="lg">
            Уведомления
          </Text>
        </div>
        {items.length === 0 ? (
          <Text c="dimmed" fz="sm" px="lg" pb="md">
            Пока ничего нет. Здесь появятся новости по заявкам и коды для подписания договора.
          </Text>
        ) : (
          <ScrollArea.Autosize mah="min(480px, 70dvh)">
            {groups(items).map(([title, group]) => (
              <div key={title}>
                <div className="potok-ntf-group">{title}</div>
                <ul className="potok-ntf-list">
                  {group.map((n) => (
                    <li key={n.id}>
                      <UnstyledButton onClick={() => open(n)} className="potok-ntf-item" data-unread={!n.read_at}>
                        <span className="potok-ntf-title">{nb(clean(n.title))}</span>
                        {n.body && <span className="potok-ntf-body">{nb(clean(n.body))}</span>}
                        <span className="potok-ntf-when">{dateTime(n.created_at)}</span>
                      </UnstyledButton>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </ScrollArea.Autosize>
        )}
        <Text fz="xs" c="dimmed" className="potok-ntf-foot">
          Уведомления приходят только в кабинет: SMS и почта в демо не используются.
        </Text>
      </Popover.Dropdown>
    </Popover>
  );
}
