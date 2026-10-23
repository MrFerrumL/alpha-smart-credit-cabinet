import { Button, Skeleton, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { useApplications } from '../api/hooks';
import type { Application } from '../api/types';
import { Empty } from '../components/States';
import { Chip, StatusChip } from '../components/Status';
import { duration, money, monthsShort } from '../lib/format';
import { nb } from '../lib/nobreak';

// Ждут банк — конвейер или специалист; остальные ждут клиента или уже закрыты.
const PIPELINE = ['submitted', 'validation', 'enrichment', 'scoring'];
const waitsForBank = (a: Application) => a.status.code === 'manual_review' || PIPELINE.includes(a.status.code);

const FILTERS: { value: string; label: string; match: (a: Application) => boolean }[] = [
  { value: 'review', label: 'Ждут решения', match: (a) => a.status.code === 'manual_review' },
  { value: 'pipeline', label: 'В конвейере', match: (a) => PIPELINE.includes(a.status.code) },
  { value: 'info', label: 'Нужна информация', match: (a) => a.status.code === 'needs_info' },
  { value: 'offer', label: 'Есть предложение', match: (a) => ['approved', 'counter_offer', 'signing'].includes(a.status.code) },
  { value: 'done', label: 'Завершённые', match: (a) => a.status.terminal },
  { value: 'all', label: 'Все', match: () => true },
];

const waitMs = (a: Application) => (a.submitted_at ? Date.now() - new Date(a.submitted_at).getTime() : 0);

/** Сначала те, кто дольше всех ждёт банк; остальные — по последнему изменению. */
function byWaiting(a: Application, b: Application): number {
  const wa = waitsForBank(a);
  const wb = waitsForBank(b);
  if (wa !== wb) return wa ? -1 : 1;
  if (wa) return waitMs(b) - waitMs(a);
  return b.updated_at.localeCompare(a.updated_at);
}

function Waiting({ app }: { app: Application }) {
  return waitsForBank(app) && app.submitted_at ? (
    <Chip tone="neutral" dot={false}>
      {duration(waitMs(app))}
    </Chip>
  ) : (
    <span className="potok-muted-text">—</span>
  );
}

export function QueuePage() {
  const navigate = useNavigate();
  const all = useApplications(undefined, true);
  const apps = all.data ?? [];
  const [filter, setFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // По умолчанию — «Ждут решения», а если там пусто — «Все».
  const current = filter ?? (apps.some(FILTERS[0].match) ? 'review' : 'all');
  const active = FILTERS.find((f) => f.value === current)!;
  const q = query.trim().toLowerCase();
  const list = apps
    .filter(active.match)
    .filter((a) => !q || [a.company.name, a.company.inn, a.number].some((s) => (s ?? '').toLowerCase().includes(q)))
    .sort(byWaiting);

  // Выбранный фильтр на телефоне прокручивается в видимую часть ленты фильтров.
  const filtersRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    filtersRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [current]);

  return (
    <Stack gap="lg">
      <div className="potok-q-head">
        <div>
          <Title order={1}>Очередь заявок</Title>
          <Text c="dimmed" mt={4}>
            Сверху — те, кто дольше всех ждёт решения банка. Статусы обновляются сами.
          </Text>
        </div>
        <TextInput
          className="potok-q-search on-canvas"
          label="Компания, ИНН или номер"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
      </div>

      <div className="potok-q-filters" role="group" aria-label="Фильтр заявок" ref={filtersRef}>
        {FILTERS.map((f) => {
          const n = apps.filter(f.match).length;
          return (
            <button key={f.value} type="button" className="potok-q-filter" aria-pressed={f.value === current} onClick={() => setFilter(f.value)}>
              <span>{f.label}</span>
              <span className="potok-q-count" data-zero={n === 0}>
                {n}
              </span>
            </button>
          );
        })}
      </div>

      {all.isLoading ? (
        <Skeleton h={280} radius={24} />
      ) : list.length === 0 ? (
        <section className="potok-panel">
          <Empty
            art="queue"
            title={q ? 'Ничего не нашлось' : `В фильтре «${active.label}» заявок нет`}
            text={q ? 'Проверьте название компании, ИНН или номер заявки.' : undefined}
            action={
              <Button variant="default" size="md" onClick={() => (q ? setQuery('') : setFilter('all'))}>
                {q ? 'Сбросить поиск' : 'Показать все'}
              </Button>
            }
          />
        </section>
      ) : (
        <section className="potok-panel potok-q">
          <Table highlightOnHover withRowBorders verticalSpacing={12} className="potok-q-table" aria-label="Заявки">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Компания</Table.Th>
                <Table.Th>Продукт</Table.Th>
                <Table.Th ta="right">Сумма</Table.Th>
                <Table.Th>Статус</Table.Th>
                <Table.Th>В очереди</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.map((a) => (
                <Table.Tr key={a.id} onClick={() => navigate(`/applications/${a.id}`)}>
                  <Table.Td>
                    <Link to={`/applications/${a.id}`} className="potok-q-co" onClick={(e) => e.stopPropagation()}>
                      {nb(a.company.name)}
                    </Link>
                    <span className="potok-q-no">{nb(a.number)}</span>
                  </Table.Td>
                  <Table.Td>
                    {nb(a.product.name)}
                    <span className="potok-q-no">{monthsShort(a.term_months)}</span>
                  </Table.Td>
                  <Table.Td ta="right">{money(a.amount)}</Table.Td>
                  <Table.Td>
                    <StatusChip app={a} />
                  </Table.Td>
                  <Table.Td>
                    <Waiting app={a} />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>

          {/* Телефон: та же очередь карточками-строками. */}
          <ul className="potok-q-cards">
            {list.map((a) => (
              <li key={a.id}>
                <Link to={`/applications/${a.id}`} className="potok-q-card">
                  <span className="potok-q-card-l1">
                    <span>{nb(a.company.name)}</span>
                    <span className="potok-nowrap">{money(a.amount)}</span>
                  </span>
                  <span className="potok-q-card-l2">
                    {nb(a.product.name)}, {monthsShort(a.term_months)}, заявка {nb(a.number)}
                  </span>
                  <span className="potok-q-card-l3">
                    <StatusChip app={a} />
                    {waitsForBank(a) && a.submitted_at && (
                      <Chip tone="neutral" dot={false}>
                        В очереди {duration(waitMs(a))}
                      </Chip>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Stack>
  );
}
