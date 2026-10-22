import { ActionIcon, Badge, Button, Group, Indicator, Popover, ScrollArea, Stack, Text, UnstyledButton } from '@mantine/core';
import { notifications as toasts } from '@mantine/notifications';
import { IconBell, IconKey } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { useNotifications, useReadAllNotifications } from '../api/hooks';
import type { AppNotification } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { dateTime } from '../lib/format';

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
      toasts.show({
        title: n.title,
        message: n.body ?? '',
        color: n.kind === 'signing_code' ? 'brand' : 'blue',
        icon: n.kind === 'signing_code' ? <IconKey size={16} /> : <IconBell size={16} />,
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
      width={360}
      position="bottom-end"
      shadow="md"
      radius="lg"
      onOpen={() => unread > 0 && readAll.mutate()}
    >
      <Popover.Target>
        <Indicator label={unread} size={18} disabled={unread === 0} offset={4} color="brand">
          <ActionIcon variant="subtle" color="gray" size="lg" radius="xl" onClick={() => setOpened((o) => !o)} aria-label="Уведомления">
            <IconBell size={22} />
          </ActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown p={0}>
        <Group justify="space-between" px="md" py="sm" style={{ borderBottom: '1px solid var(--app-line)' }}>
          <Text fw={800}>Уведомления</Text>
          {items.length > 0 && (
            <Badge variant="light" color="gray">
              {items.length}
            </Badge>
          )}
        </Group>
        {items.length === 0 ? (
          <Text c="dimmed" fz="sm" p="md">
            Пока ничего нет. Здесь появятся новости по заявкам и коды для подписания договора.
          </Text>
        ) : (
          <ScrollArea.Autosize mah={420}>
            <Stack gap={0}>
              {items.map((n) => (
                <UnstyledButton
                  key={n.id}
                  onClick={() => open(n)}
                  px="md"
                  py="sm"
                  style={{
                    borderBottom: '1px solid var(--app-line)',
                    background: n.read_at ? undefined : 'var(--mantine-color-brand-0)',
                  }}
                >
                  <Group gap="xs" wrap="nowrap" align="flex-start">
                    {n.kind === 'signing_code' && <IconKey size={16} color="var(--mantine-color-brand-6)" style={{ marginTop: 2 }} />}
                    <div>
                      <Text fz="sm" fw={700} lh={1.35}>
                        {n.title}
                      </Text>
                      {n.body && (
                        <Text fz="xs" c="dimmed" mt={2} lineClamp={2}>
                          {n.body}
                        </Text>
                      )}
                      <Text fz={11} c="dimmed" mt={4}>
                        {dateTime(n.created_at)}
                      </Text>
                    </div>
                  </Group>
                </UnstyledButton>
              ))}
            </Stack>
          </ScrollArea.Autosize>
        )}
        {items.length > 0 && (
          <Button variant="subtle" fullWidth radius={0} onClick={() => setOpened(false)}>
            Закрыть
          </Button>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
