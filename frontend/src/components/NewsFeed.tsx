import { Button, Skeleton, Title } from '@mantine/core';
import { useState } from 'react';

import { useApplications, useFeed } from '../api/hooks';
import type { FeedItem } from '../api/types';
import { dayMonth, typo } from '../lib/format';

/**
 * Короткая метка «почему показано»: этап заявки, отрасль, форма, регион или продукты. Новость, которую подняла
 * заявка клиента, — «По вашей заявке»; полный список причин — строкой под заголовком.
 */
function tag(reasons: string[]): { label: string; app: boolean } | null {
  // Причина по этапу заявки приходит как «Сейчас …» (см. _STATUS_TITLES в backend/app/services/feed.py).
  if (reasons.some((r) => r.startsWith('Сейчас '))) return { label: 'По вашей заявке', app: true };
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

/** «Для вашей отрасли: производство · по продуктам, которые вы оформляете». */
const why = (reasons: string[]) => reasons.map((r, i) => (i ? r.charAt(0).toLowerCase() + r.slice(1) : r)).join(' · ');

function News({ item }: { item: FeedItem }) {
  const t = tag(item.reasons);
  return (
    <li>
      <div className="potok-news-meta">
        {t && (
          <span className="potok-tag" data-tone={t.app ? 'app' : undefined}>
            {t.label}
          </span>
        )}
        <span>{dayMonth(item.published_at)}</span>
      </div>
      <div className="potok-news-title" data-testid="news-title">
        {typo(item.title.replace(' (синтетическая новость)', ''))}
      </div>
      {item.reasons.length > 0 && <div className="potok-news-why">{typo(why(item.reasons))}</div>}
      <div className="potok-news-summary">{typo(item.summary)}</div>
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
