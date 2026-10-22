import { Badge, Card, Group, Skeleton, Stack, Text, Title } from '@mantine/core';
import { IconNews } from '@tabler/icons-react';

import { useApplications, useFeed } from '../api/hooks';
import { date } from '../lib/format';

/** Персональная лента: синтетические новости, подобранные под отрасль, продукты и этап заявки клиента. */
export function NewsFeed() {
  // Ключ ленты включает статусы заявок: сменился статус (опрос или поток) — лента пересчитывается.
  const apps = useApplications();
  const feed = useFeed((apps.data ?? []).map((a) => `${a.id}:${a.status.code}`).join(','));
  return (
    <Card p="lg">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Group gap="xs" wrap="nowrap">
          <IconNews size={20} />
          <Title order={4}>Новости для вас</Title>
        </Group>
        <Badge variant="light" color="gray" size="sm">
          Смоделировано
        </Badge>
      </Group>
      <Text fz="xs" c="dimmed" mt={4}>
        Синтетические новости. Подобраны под отрасль компании, ваши заявки и то, что с ними происходит сейчас.
      </Text>
      {feed.isLoading ? (
        <Skeleton h={160} mt="md" radius="md" />
      ) : (
        <Stack gap="md" mt="md">
          {(feed.data ?? []).map((item) => (
            <div key={item.id}>
              <Text fz="sm" fw={700} lh={1.35}>
                {item.title.replace(' (синтетическая новость)', '')}
              </Text>
              <Text fz="sm" mt={2} lh={1.4}>
                {item.summary}
              </Text>
              <Text fz="xs" c="dimmed" mt={2}>
                {date(item.published_at)} · {item.reasons.join(' · ')}
              </Text>
            </div>
          ))}
        </Stack>
      )}
    </Card>
  );
}
