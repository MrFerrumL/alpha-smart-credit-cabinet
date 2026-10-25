import { Skeleton, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { SYSTEM_POLL_MS, useHealthDeps, useSystemJobs } from '../api/hooks';
import type { HealthDeps, SourceCode, SystemJob, Tone } from '../api/types';
import { LoadError } from '../components/States';
import { Chip } from '../components/Status';
import { NBSP, dateTime, duration, int, typo } from '../lib/format';
import { nb } from '../lib/nobreak';

const SOURCES: { code: SourceCode; title: string; what: string }[] = [
  { code: 'egrul', title: 'ЕГРЮЛ', what: 'Выписка о компании: статус, руководитель, адрес' },
  { code: 'fns', title: 'ФНС «Прозрачный бизнес»', what: 'Выручка, налоги и численность сотрудников' },
  { code: 'bki', title: 'БКИ', what: 'Бюро кредитных историй: долги, платежи, просрочки' },
  { code: 'abs', title: 'АБС', what: 'Банковская система: перевод суммы кредита на счёт' },
];

const SOURCE_TITLE = Object.fromEntries(SOURCES.map((s) => [s.code, s.title])) as Record<SourceCode, string>;

// Пороги предохранителя — значения по умолчанию из backend/app/config.py (breaker_threshold, breaker_cooldown_s).
const BREAKER = { failures: 5, pauseS: 20 };

const JOB_STATE: Record<SystemJob['status'], { label: string; tone: Tone }> = {
  pending: { label: 'ждёт повтора', tone: 'warning' },
  running: { label: 'повторяем', tone: 'info' },
  done: { label: 'получилось', tone: 'success' },
  failed: { label: 'попытки исчерпаны', tone: 'neutral' },
};

// Что происходит с заявкой, когда попытки шага кончились (запасной путь шага в backend/app/pipeline/steps.py).
const AFTER_FAILURE: Record<string, string> = {
  'pipeline.validate': 'заявка передана специалисту',
  'pipeline.enrich': 'заявка передана специалисту',
  'pipeline.score': 'заявка передана специалисту',
  'pipeline.disburse': 'перевод повторится позже',
};

/** Секунды коротко: 8 с, 3 мин 5 с, 1 ч 12 мин. */
function seconds(total: number): string {
  const s = Math.max(0, Math.round(total));
  if (s < 60) return `${s}${NBSP}с`;
  if (s < 3600) return `${Math.floor(s / 60)}${NBSP}мин${s % 60 ? `${NBSP}${s % 60}${NBSP}с` : ''}`;
  return duration(s * 1000);
}

const clockFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Сегодня — время до секунды, раньше — дата и время. */
function when(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? clockFmt.format(d) : dateTime(iso);
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** «N с назад» с момента at; тикает раз в секунду сам, без перерисовки страницы. */
function Ago({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const s = Math.max(0, Math.round((now - at) / 1000));
  return <>{s === 0 ? 'только что' : `${seconds(s)} назад`}</>;
}

function SourcesPanel({ sources }: { sources: HealthDeps['sources'] }) {
  return (
    <section className="potok-panel" aria-labelledby="sys-sources">
      <Title order={3} id="sys-sources">
        Внешние источники
      </Title>
      <ul className="potok-sys-list">
        {SOURCES.map((s) => {
          const paused = sources[s.code] === 'paused';
          return (
            <li key={s.code} className="potok-sys-source" data-testid={`source-${s.code}`}>
              <div className="potok-sys-main">
                <span className="potok-row-title">{s.title}</span>
                <span className="potok-row-sub">
                  {paused ? 'Запросы приостановлены после серии сбоев, повторим автоматически' : s.what}
                </span>
              </div>
              <Chip tone={paused ? 'warning' : 'success'}>{paused ? 'на паузе' : 'работает'}</Chip>
            </li>
          );
        })}
      </ul>
      <p className="potok-sys-note">
        {BREAKER.failures}&nbsp;сбоев подряд → пауза {BREAKER.pauseS}&nbsp;с, запросы к источнику не уходят → один
        пробный запрос: ответил — работаем дальше, нет — снова пауза. Шаги заявок на это время откладываются, а не
        теряются.
      </p>
    </section>
  );
}

function Figure({ label, value, id }: { label: string; value: string; id: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd data-testid={id}>{value}</dd>
    </div>
  );
}

function QueuePanel({ queue }: { queue: HealthDeps['queue'] }) {
  return (
    <section className="potok-panel" aria-labelledby="sys-queue">
      <Title order={3} id="sys-queue">
        Очередь конвейера
      </Title>
      {queue ? (
        <>
          <dl className="potok-sys-queue">
            <Figure label="Ждут" value={int(queue.pending)} id="queue-pending" />
            <Figure label="Выполняются" value={int(queue.running)} id="queue-running" />
            <Figure label="Самая старая ждёт" value={seconds(queue.oldest_ready_age_s)} id="queue-oldest" />
            <Figure label="Сбоев за час" value={int(queue.failed_last_hour)} id="queue-failed" />
          </dl>
          <p className="potok-sys-note">
            «Ждут» — вместе с отложенными повторами. «Самая старая ждёт» — задача, которой уже пора выполняться: если
            число растёт, обработчики не успевают.
          </p>
        </>
      ) : (
        <div className="potok-inline-note" data-tone="warn">
          База данных не ответила — очередь сейчас не видна. Состояние источников продолжает обновляться.
        </div>
      )}
    </section>
  );
}

function JobRow({ job }: { job: SystemJob }) {
  const state = JOB_STATE[job.status];
  const title = job.source ? `${SOURCE_TITLE[job.source]}: ${job.reason}` : capital(job.reason);
  const tail =
    job.status === 'pending' && job.next_attempt_at
      ? `следующая в ${when(job.next_attempt_at)}`
      : job.status === 'failed'
        ? AFTER_FAILURE[job.kind]
        : null;
  return (
    <li className="potok-sys-job">
      <div className="potok-sys-main">
        <span className="potok-row-title">{typo(title)}</span>
        <span className="potok-row-sub">
          {job.step}
          {job.application_id !== null && (
            <>
              {' · '}
              <Link to={`/applications/${job.application_id}`} className="potok-link">
                заявка {nb(job.application_number ?? `№${job.application_id}`)}
              </Link>
            </>
          )}
          {job.status !== 'done' && ` · попытка ${job.attempts} из ${job.max_attempts}`}
          {tail && ` · ${tail}`}
        </span>
      </div>
      <div className="potok-sys-job-side">
        <Chip tone={state.tone}>{state.label}</Chip>
        <time dateTime={job.updated_at}>{when(job.updated_at)}</time>
      </div>
    </li>
  );
}

function JobsPanel() {
  const jobs = useSystemJobs();
  return (
    <section className="potok-panel" aria-labelledby="sys-jobs" aria-busy={jobs.isLoading}>
      <Title order={3} id="sys-jobs">
        Последние повторы и сбои
      </Title>
      <Text fz="sm" c="dimmed" mt={4}>
        Шаги конвейера, которые не выполнились с первой попытки, свежие — сверху. Без ИНН и технических подробностей:
        полный текст ошибки — в журнале сервиса.
      </Text>
      {jobs.isLoading ? (
        <div className="potok-sys-sk">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} h={44} radius="md" />
          ))}
        </div>
      ) : !jobs.data ? (
        <div className="potok-inline-note" data-tone="warn" role="status">
          Не получилось загрузить список — повторим через {SYSTEM_POLL_MS / 1000}&nbsp;с.
        </div>
      ) : jobs.data.length === 0 ? (
        <div className="potok-inline-note" data-tone="ok">
          Повторов и сбоев нет: все шаги конвейера выполнились с первой попытки.
        </div>
      ) : (
        <>
          {jobs.isError && (
            <div className="potok-inline-note" data-tone="warn" role="status">
              Нет связи с сервером — список мог устареть, повторим через {SYSTEM_POLL_MS / 1000}&nbsp;с.
            </div>
          )}
          <ul className="potok-sys-list">
            {jobs.data.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function SystemSkeleton() {
  return (
    <div className="potok-sys" aria-busy="true" aria-label="Загружаем состояние системы">
      <div className="potok-col">
        <Skeleton h={340} radius={24} />
        <Skeleton h={240} radius={24} />
      </div>
      <Skeleton h={600} radius={24} />
    </div>
  );
}

/** Состояние системы для банка: внешние источники, очередь конвейера, последние повторы и сбои. Обновляется само. */
export function SystemPage() {
  const deps = useHealthDeps();
  const data = deps.data;
  // Данные есть, но последний опрос не прошёл: показываем их с пометкой и продолжаем опрашивать.
  const offline = deps.isError && !!data;

  return (
    <div className="potok-col">
      <div className="potok-q-head">
        <div>
          <Title order={1}>Состояние системы</Title>
          <Text c="dimmed" mt={4}>
            Внешние источники и очередь конвейера. Страница обновляется сама каждые {SYSTEM_POLL_MS / 1000}&nbsp;секунд.
          </Text>
        </div>
        {data && (
          <div className="potok-sys-meta">
            <span className="potok-sys-fresh">
              <span className="potok-live" data-live={!offline} />
              {offline ? 'Нет связи с сервером, данные получены ' : 'Обновлено '}
              <Ago at={deps.dataUpdatedAt} />
            </span>
            <span data-testid="system-version">Версия {data.version}</span>
          </div>
        )}
      </div>

      {deps.isLoading ? (
        <SystemSkeleton />
      ) : !data ? (
        <LoadError error={deps.error} what="состояние системы" onRetry={() => deps.refetch()} />
      ) : (
        <div className="potok-sys">
          <div className="potok-col">
            <SourcesPanel sources={data.sources} />
            <QueuePanel queue={data.queue} />
          </div>
          <JobsPanel />
        </div>
      )}
    </div>
  );
}
