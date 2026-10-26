import { Anchor, Button, Skeleton, Title } from '@mantine/core';
import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';

import { useApplications, useFeed, useTasks } from '../api/hooks';
import type { Application, ClientTask, Company, FeedItem } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { dayMonth, typo } from '../lib/format';
import { byAction } from './Status';

const SECTOR = 'Для вашей отрасли: ';

const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * Короткая метка «почему показано»: этап заявки, отрасль, форма, регион или продукты. Новость, которую подняла
 * главная заявка клиента (у неё есть application_id), — «По вашей заявке»; полный список причин — строкой под
 * заголовком.
 */
function tag(item: FeedItem): { label: string; app: boolean } | null {
  const { reasons } = item;
  if (item.application_id != null) return { label: 'По вашей заявке', app: true };
  const sector = reasons.find((r) => r.startsWith(SECTOR));
  if (sector) {
    const name = sector.slice(SECTOR.length);
    return { label: name.charAt(0).toUpperCase() + name.slice(1), app: false };
  }
  if (reasons.includes('Для индивидуальных предпринимателей')) return { label: 'Для ИП', app: false };
  if (reasons.includes('Для вашего региона')) return { label: 'Ваш регион', app: false };
  if (reasons.includes('По продуктам, которые вы оформляете')) return { label: 'Ваши продукты', app: false };
  if (reasons.includes('Полезно всем предпринимателям')) return { label: 'Всем', app: false };
  return null;
}

/** «Для вашей отрасли: производство · по продуктам, которые вы оформляете». */
const why = (reasons: string[]) => reasons.map((r, i) => (i ? lower(r) : r)).join(' · ');

/**
 * Ссылка из новости этапа на саму заявку — словами следующего шага клиента. Пока задачи запроса банка не загружены,
 * ссылки нет: подпись «Загрузить выписку» не должна подменяться на ходу.
 */
function stageAction(app: Application, tasks: ClientTask[] | undefined): { label: string; to: string } | null {
  const page = `/applications/${app.id}`;
  switch (app.status.code) {
    case 'approved':
    case 'counter_offer':
      return { label: 'Открыть предложение', to: page };
    case 'needs_info': {
      if (!tasks) return null;
      const open = tasks.filter((t) => t.status === 'open');
      if (open.some((t) => t.payload?.document_kind === 'bank_statement')) return { label: 'Загрузить выписку', to: page };
      if (open.some((t) => t.kind === 'document')) return { label: 'Загрузить документ', to: page };
      return { label: 'Ответить на запрос', to: page };
    }
    case 'signing':
      return { label: app.allowed_actions.includes('sign') ? 'Подписать договор' : 'Открыть заявку', to: page };
    case 'draft':
      return { label: 'Продолжить оформление', to: `${page}/edit` };
    case 'issued':
      return app.loan_id ? { label: 'Кредит и график платежей', to: `/loans/${app.loan_id}` } : { label: 'Открыть заявку', to: page };
    default:
      return { label: 'Открыть заявку', to: page };
  }
}

/** «Подобрано для ООО «…»: производство · Экспресс-оборот · одобрено» — по чему собрана лента. */
function pickedFor(company: Company, items: FeedItem[], app: Application | undefined): string {
  const sector = items.flatMap((i) => i.reasons).find((r) => r.startsWith(SECTOR));
  const parts = [
    sector ? sector.slice(SECTOR.length) : company.okved_name && lower(company.okved_name),
    app?.product.name,
    app && lower(app.status.title),
  ].filter(Boolean);
  return parts.length ? `Подобрано для ${company.short_name}: ${parts.join(' · ')}` : `Подобрано для ${company.short_name}`;
}

/** Пересказ — до трёх строк; если не уместился (узкий экран), его можно раскрыть целиком. */
function Summary({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, text]);
  return (
    <>
      <div ref={ref} className="potok-news-summary" data-open={open || undefined} data-testid="news-summary">
        {typo(text)}
      </div>
      {(clamped || open) && (
        <button type="button" className="potok-news-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Скрыть' : 'Читать полностью'}
        </button>
      )}
    </>
  );
}

function News({ item, app, tasks }: { item: FeedItem; app?: Application; tasks?: ClientTask[] }) {
  const t = tag(item);
  const action = app && item.application_id === app.id ? stageAction(app, tasks) : null;
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
      <Summary text={item.summary} />
      {action && (
        <Anchor component={Link} to={action.to} className="potok-link potok-news-act">
          {action.label}
        </Anchor>
      )}
    </li>
  );
}

/**
 * Персональная лента: синтетические новости под отрасль, продукты и этап главной заявки клиента. На главной — три
 * первые в порядке сервера (новость этапа наверху), в «Все новости» — все, по дате.
 */
export function NewsFeed() {
  const { user } = useAuth();
  // Ключ ленты включает статусы заявок: сменился статус (опрос или поток) — лента пересчитывается.
  const apps = useApplications();
  const list = apps.data ?? [];
  const feed = useFeed(list.map((a) => `${a.id}:${a.status.code}`).join(','));
  const [all, setAll] = useState(false);
  const items = feed.data ?? [];
  // Заявка, этап которой поднял новость, — та же главная, что на главной; если такой новости нет — главная по byAction.
  const raisedBy = items.find((i) => i.application_id != null)?.application_id;
  const app =
    list.find((a) => a.id === raisedBy) ?? [...list].filter((a) => !a.status.terminal).sort(byAction)[0];
  const tasks = useTasks(app?.id ?? 0, app?.status.code === 'needs_info' ? app : undefined);
  const byDate = (news: FeedItem[]) => [...news].sort((x, y) => y.published_at.localeCompare(x.published_at));
  const shown = all ? byDate(items) : items.slice(0, 3);
  return (
    <section className="potok-panel potok-news" aria-label="Новости для вас">
      <Title order={3}>Новости для вас</Title>
      {feed.isLoading ? (
        <Skeleton h={180} mt="md" radius="md" />
      ) : items.length > 0 ? (
        <>
          {user?.company && <div className="potok-news-for">{pickedFor(user.company, items, app)}</div>}
          <ul>
            {shown.map((item) => (
              <News key={item.id} item={item} app={app} tasks={tasks.data} />
            ))}
          </ul>
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
        </>
      ) : feed.isError ? (
        <p className="potok-news-state" role="alert">
          {typo('Не получилось загрузить новости — обновите страницу')}
        </p>
      ) : (
        <p className="potok-news-state">
          Подходящих новостей пока нет. Они появятся, когда в отрасли компании или по вашим заявкам будет что-то важное.
        </p>
      )}
    </section>
  );
}
