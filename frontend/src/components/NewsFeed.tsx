import { Button, Skeleton, Title } from '@mantine/core';
import { useState } from 'react';

import { useApplications, useFeed } from '../api/hooks';
import type { FeedItem } from '../api/types';
import { dayMonth } from '../lib/format';

/**
 * Короткая метка «почему показано»: отрасль, форма, регион или продукты. Статья — не сообщение о заявке, поэтому
 * метки «Ваша заявка» нет. Полный список причин — в подсказке.
 */
function tag(reasons: string[]): { label: string; app: boolean } | null {
  const sector = reasons.find((r) => r.startsWith('Для вашей отрасли: '));
  if (sector) {
    const name = sector.slice('Для вашей отрасли: '.length);
    return { label: name.charAt(0).toUpperCase() + name.slice(1), app: false };
  }
  if (reasons.includes('Для индивидуальных предпринимателей')) return { label: 'Для ИП', app: false };
  if (reasons.includes('Для вашего региона')) return { label: 'Ваш регион', app: false };
  if (reasons.includes('По продуктам, которые вы оформляете')) return { label: 'Ваши продукты', app: false };
  if (reasons.includes('Полезно всем предпринимателям')) return { label: 'Всем', app: false };
  return null;
}

function News({ item }: { item: FeedItem }) {
  const t = tag(item.reasons);
  return (
    <li title={item.reasons.join('; ')}>
      <div className="potok-news-meta">
        {t && (
          <span className="potok-tag" data-tone={t.app ? 'app' : undefined}>
            {t.label}
          </span>
        )}
        <span>{dayMonth(item.published_at)}</span>
      </div>
      <div className="potok-news-title" data-testid="news-title">
        {item.title.replace(' (синтетическая новость)', '')}
      </div>
      <div className="potok-news-summary">{item.summary}</div>
    </li>
  );
}

/** Персональная лента: синтетические новости под отрасль, продукты и этап заявки клиента — 3 и «Все новости». */
export function NewsFeed() {
  // Ключ ленты включает статусы заявок: сменился статус (опрос или поток) — лента пересчитывается.
  const apps = useApplications();
  const feed = useFeed((apps.data ?? []).map((a) => `${a.id}:${a.status.code}`).join(','));
  const [all, setAll] = useState(false);
  // Сервер ставит первыми самые подходящие — на главной три из них; и они, и полный список — по дате, новые сверху.
  const byDate = (list: FeedItem[]) => [...list].sort((x, y) => y.published_at.localeCompare(x.published_at));
  const items = feed.data ?? [];
  const shown = all ? byDate(items) : byDate(items.slice(0, 3));
  return (
    <section className="potok-panel potok-news" aria-label="Новости для вас">
      <Title order={3}>Новости для вас</Title>
      {feed.isLoading ? (
        <Skeleton h={180} mt="md" radius="md" />
      ) : (
        <ul>
          {shown.map((item) => (
            <News key={item.id} item={item} />
          ))}
        </ul>
      )}
      <div className="potok-news-foot">
        {items.length > 3 ? (
          <Button variant="subtle" px={0} onClick={() => setAll((v) => !v)} aria-expanded={all}>
            {all ? 'Свернуть' : 'Все новости'}
          </Button>
        ) : (
          <span />
        )}
        <span className="potok-news-note">Новости смоделированы для демо</span>
      </div>
    </section>
  );
}
