import { Button, Skeleton, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';

import { ApiError } from '../api/client';

/** Свои простые иллюстрации: линия графитом, плоскость «Туман», волна «Потока» — без наборов иконок. */
function Art({ kind }: { kind: 'folder' | 'list' | 'queue' | 'error' }) {
  if (kind === 'error') {
    return (
      <svg viewBox="0 0 120 80" width="120" fill="none" aria-hidden="true">
        <rect x="4" y="4" width="112" height="72" rx="16" fill="#f2f3f5" />
        <path d="M16 46c6 0 8-14 14-14s8 20 14 20" stroke="#212124" strokeWidth="3" strokeLinecap="round" />
        <path d="M62 30c6 0 8 14 14 14s8-20 14-20 6 10 14 10" stroke="#babbc2" strokeWidth="3" strokeLinecap="round" strokeDasharray="2 7" />
        <circle cx="53" cy="54" r="3" fill="#ef3124" />
      </svg>
    );
  }
  if (kind === 'queue') {
    return (
      <svg viewBox="0 0 120 72" width="120" fill="none" aria-hidden="true">
        <rect x="10" y="10" width="100" height="52" rx="12" fill="#f2f3f5" />
        <path d="M26 28h68M26 40h44" stroke="#babbc2" strokeWidth="2" strokeLinecap="round" />
        <circle cx="92" cy="46" r="10" fill="#fff" stroke="#212124" strokeWidth="1.5" />
        <path d="M88 46l3 3 5-6" stroke="#0cc44d" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === 'list') {
    return (
      <svg viewBox="0 0 120 80" width="120" fill="none" aria-hidden="true">
        <rect x="18" y="8" width="84" height="64" rx="10" fill="#fff" stroke="#212124" strokeWidth="1.5" />
        <path d="M32 26h56M32 38h56M32 50h30" stroke="#babbc2" strokeWidth="2" strokeLinecap="round" />
        <path d="M70 60c3 0 4-6 7-6s4 8 7 8 4-8 7-8" stroke="#ef3124" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 160 112" width="140" fill="none" aria-hidden="true">
      <rect x="10" y="22" width="140" height="82" rx="12" fill="#f2f3f5" />
      <path d="M10 34a12 12 0 0 1 12-12h34l10 10h72a12 12 0 0 1 12 12" stroke="#212124" strokeWidth="1.5" />
      <rect x="40" y="8" width="62" height="74" rx="6" fill="#fff" stroke="#212124" strokeWidth="1.5" />
      <path d="M52 26h38M52 36h38M52 46h24" stroke="#babbc2" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M52 62c4 0 5-7 9-7s5 9 9 9 5-9 9-9 5 7 7 7" stroke="#ef3124" strokeWidth="2.5" strokeLinecap="round" />
      <rect x="10" y="50" width="140" height="54" rx="12" fill="#fff" fillOpacity=".9" stroke="#212124" strokeWidth="1.5" />
    </svg>
  );
}

/** Пустое состояние — приглашение к действию: что сделать и кнопка с тем же глаголом. */
export function Empty({
  art = 'folder',
  title,
  text,
  action,
}: {
  art?: 'folder' | 'list' | 'queue';
  title: string;
  text?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="potok-empty">
      <Art kind={art} />
      <Title order={3} mt="md">
        {title}
      </Title>
      {text && (
        <Text c="dimmed" mt={6} maw={460} mx="auto">
          {text}
        </Text>
      )}
      {action && <div className="potok-empty-action">{action}</div>}
    </div>
  );
}

/** Ошибка загрузки: что случилось и что сделать, без извинений. */
export function LoadError({ error, what, back }: { error: unknown; what: string; back?: ReactNode }) {
  const code = error instanceof ApiError ? error.status : null;
  return (
    <div className="potok-error" role="alert">
      <Art kind="error" />
      <div>
        <Title order={2}>Не получилось загрузить {what}</Title>
        <Text c="dimmed" mt={8} maw={560}>
          {code === 404
            ? 'Такой страницы нет: возможно, ссылка устарела.'
            : 'Сервер банка не ответил. Данные не потеряны — обновите страницу через минуту.'}
        </Text>
        <div className="potok-error-actions">
          {code !== 404 && (
            <Button size="md" onClick={() => window.location.reload()}>
              Обновить страницу
            </Button>
          )}
          {back}
        </div>
        {code && code !== 404 && (
          <Text fz="sm" c="dimmed" mt="md">
            Код ошибки {code}
          </Text>
        )}
      </div>
    </div>
  );
}

/** Скелетон страницы заявки: в форме блока решения, а не пустое ожидание. */
export function DecisionSkeleton() {
  return (
    <Stack gap="lg" aria-busy="true" aria-label="Загружаем заявку">
      <Skeleton h={36} w={320} radius="md" />
      <div className="potok-decision">
        <Skeleton h={4} radius="xl" />
        <Skeleton h={22} w={300} mt={32} radius="md" />
        <div className="potok-sk-figures">
          <Skeleton h={58} w={340} radius="md" />
          <Skeleton h={58} w={260} radius="md" />
        </div>
        <Skeleton h={18} w={420} mt={20} radius="md" />
        <div className="potok-sk-bars">
          {Array.from({ length: 12 }, (_, i) => (
            <Skeleton key={i} h={`${70 + i * 2}%`} radius="sm" />
          ))}
        </div>
      </div>
    </Stack>
  );
}
