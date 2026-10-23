import { Text, Title } from '@mantine/core';
import { Link } from 'react-router';

import { useNotifications } from '../api/hooks';
import type { Company } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { date, dateTime } from '../lib/format';
import { nb } from '../lib/nobreak';

/** Компания из ЕГРЮЛ — правая колонка главной и страницы заявки. Длинный вид деятельности — под подписью. */
export function CompanyCard({ company }: { company: Company }) {
  const rows: [string, string | null][] = [
    ['ИНН', company.inn],
    ['Работает с', company.registered_at ? date(company.registered_at) : null],
    ['Руководитель', company.director],
  ];
  return (
    <section className="potok-panel">
      <Title order={3}>{nb(company.short_name)}</Title>
      <dl className="potok-pairs">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>
      {company.okved_name && (
        <dl className="potok-pairs potok-pairs-stack">
          <div>
            <dt>Вид деятельности</dt>
            <dd>{company.okved_name}</dd>
          </div>
        </dl>
      )}
      <Text fz="sm" c="dimmed" mt="md">
        Данные из ЕГРЮЛ подставляются в заявки сами.
      </Text>
    </section>
  );
}

/** Компания текущего клиента, если она подключена. */
export function MyCompany() {
  const { user } = useAuth();
  return user?.company ? <CompanyCard company={user.company} /> : null;
}

/**
 * Последние уведомления — те же, что под колокольчиком: только свои события, без кодов подписи (код живёт
 * в окне подписания). Одна форма времени — «23 октября в 14:35».
 */
export function RecentNotifications({ limit = 3 }: { limit?: number }) {
  const { user } = useAuth();
  const query = useNotifications(!!user);
  const items = (query.data ?? []).filter((n) => n.kind !== 'signing_code').slice(0, limit);
  if (!items.length) return null;
  return (
    <section className="potok-panel">
      <Title order={3}>Уведомления</Title>
      <ul className="potok-rows">
        {items.map((n) => (
          <li key={n.id} className="potok-note-row" data-unread={!n.read_at}>
            {n.link ? (
              <Link to={n.link} className="potok-note-title">
                {nb(n.title)}
              </Link>
            ) : (
              <span className="potok-note-title">{nb(n.title)}</span>
            )}
            {n.body && <span className="potok-note-body">{nb(n.body)}</span>}
            <span className="potok-note-when">{dateTime(n.created_at)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
