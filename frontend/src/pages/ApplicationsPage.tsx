import { Button, Skeleton, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { Link } from 'react-router';

import { useApplications, useMeta } from '../api/hooks';
import type { Application } from '../api/types';
import { AppRow } from '../components/AppRow';
import { AppStatusCard } from '../components/AppStatusCard';
import { Empty, LoadError } from '../components/States';
import { byAction } from '../components/Status';
import { money } from '../lib/format';

type Filter = 'all' | 'active' | 'closed';

const FILTERS: { value: Filter; label: string; match: (a: Application) => boolean }[] = [
  { value: 'all', label: 'Все', match: () => true },
  { value: 'active', label: 'В работе', match: (a) => !a.status.terminal },
  { value: 'closed', label: 'Закрытые', match: (a) => a.status.terminal },
];

// Сколько обычно длится этап — для подсказки «как идёт заявка».
const STAGE_TIME = ['вы заполняете анкету', 'пара минут', 'ЕГРЮЛ, ФНС и БКИ — сам банк', 'до 15 минут', 'придёт уведомление', 'кодом в кабинете', 'несколько секунд после подписи'];

/** Сводка по заявкам компании: что ждёт клиента, что проверяет банк, сколько выдано. */
function Summary({ apps }: { apps: Application[] }) {
  const waiting = apps.filter((a) => a.status.action_required).length;
  const bank = apps.filter((a) => !a.status.terminal && !a.status.action_required && a.status.code !== 'draft').length;
  const issued = apps.filter((a) => a.status.code === 'issued');
  const issuedSum = issued.reduce((s, a) => s + (a.offer?.amount ?? a.amount), 0);
  return (
    <section className="potok-panel">
      <Title order={3}>Сводка</Title>
      <dl className="potok-pairs">
        <div>
          <dt>Ждут вашего действия</dt>
          <dd>{waiting}</dd>
        </div>
        <div>
          <dt>Банк проверяет</dt>
          <dd>{bank}</dd>
        </div>
        <div>
          <dt>Выдано</dt>
          <dd>{issued.length ? `${issued.length} на ${money(issuedSum)}` : 'пока нет'}</dd>
        </div>
      </dl>
      <Button component={Link} to="/match" variant="default" size="md" fullWidth mt="md">
        Подобрать кредит
      </Button>
    </section>
  );
}

function HowItGoes() {
  const meta = useMeta();
  const stages = meta.data?.stages ?? [];
  if (!stages.length) return null;
  return (
    <section className="potok-panel">
      <Title order={3}>Как идёт заявка</Title>
      <ul className="potok-timeline potok-timeline-plan">
        {stages.map((s, i) => (
          <li key={s}>
            {s}
            <span>{STAGE_TIME[i]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ApplicationsPage() {
  const apps = useApplications();
  const list = apps.data ?? [];
  const [filter, setFilter] = useState<Filter>('all');
  const match = FILTERS.find((f) => f.value === filter)!.match;
  const shown = list.filter(match);
  // Идущие — компонентом статуса, сверху та, где ход за клиентом; закрытые — строками.
  const active = shown.filter((a) => !a.status.terminal).sort(byAction);
  const closed = shown.filter((a) => a.status.terminal);
  // Красная кнопка — одна на экране: у первой заявки, где ход за клиентом, у остальных — спокойные.
  const lead = active.find((a) => a.status.action_required);

  return (
    <div className="potok-col">
      <div>
        <Title order={1}>Мои заявки</Title>
        <Text c="dimmed" mt={4}>
          Статус каждой заявки обновляется сам
        </Text>
      </div>
      <div className="potok-below">
        <div className="potok-col">
          <div className="potok-q-filters" role="group" aria-label="Фильтр заявок">
            {FILTERS.map((f) => (
              <button key={f.value} type="button" className="potok-q-filter" aria-pressed={f.value === filter} onClick={() => setFilter(f.value)}>
                <span>{f.label}</span>
                <span className="potok-q-count" data-zero={!list.filter(f.match).length}>
                  {list.filter(f.match).length}
                </span>
              </button>
            ))}
          </div>
          {apps.isLoading ? (
            <Skeleton h={220} radius={24} />
          ) : apps.isError ? (
            <LoadError error={apps.error} what="заявки" />
          ) : !list.length ? (
            <section className="potok-panel">
              <Empty
                art="folder"
                title="Заявок пока нет"
                text="Подберите продукт под задачу — платёж будет виден сразу, а заявка появится здесь."
                action={
                  <Button component={Link} to="/match" size="lg">
                    Подобрать кредит
                  </Button>
                }
              />
            </section>
          ) : !shown.length ? (
            <section className="potok-panel">
              <Empty
                art="folder"
                title={filter === 'active' ? 'Заявок в работе нет' : 'Закрытых заявок нет'}
                text={filter === 'active' ? 'Выданные, отклонённые и отозванные — в «Закрытых».' : 'Текущие заявки — в «В работе».'}
                action={
                  <Button variant="default" size="md" onClick={() => setFilter('all')}>
                    Показать все
                  </Button>
                }
              />
            </section>
          ) : (
            <>
              {active.map((a) => (
                <AppStatusCard key={a.id} app={a} primary={a === lead} />
              ))}
              {closed.length > 0 && (
                <section className="potok-panel">
                  <Title order={3}>Закрытые</Title>
                  <ul className="potok-rows">
                    {closed.map((a) => (
                      <AppRow key={a.id} app={a} />
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
        <div className="potok-col">
          {list.length > 0 && <Summary apps={list} />}
          <HowItGoes />
        </div>
      </div>
    </div>
  );
}
