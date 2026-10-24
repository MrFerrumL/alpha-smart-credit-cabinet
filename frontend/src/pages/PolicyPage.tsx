import { Button, Skeleton, Slider, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { Link } from 'react-router';

import { ApiError } from '../api/client';
import { usePolicySimulation } from '../api/hooks';
import type { PolicySummary, Tone } from '../api/types';
import { Chip } from '../components/Status';
import { money, percent } from '../lib/format';
import { nb } from '../lib/nobreak';

// Действующие пороги (правила от 22 октября) — с них начинается симулятор, к ним возвращает «Вернуть действующие».
const CURRENT = { dsr: 50, coverage: 1.2 };
const DSR = { min: 20, max: 70, step: 5 };
const COVERAGE = { min: 0.8, max: 2.5, step: 0.1 };

const OUTCOME: Record<string, { title: string; tone: Tone }> = {
  approved: { title: 'Одобрение', tone: 'success' },
  counter_offer: { title: 'Другие условия', tone: 'warning' },
  manual_review: { title: 'Специалист', tone: 'info' },
  rejected: { title: 'Отказ', tone: 'danger' },
  needs_info: { title: 'Запрос информации', tone: 'warning' },
};

function Outcome({ code }: { code: string }) {
  const o = OUTCOME[code] ?? { title: code, tone: 'neutral' as Tone };
  return <Chip tone={o.tone}>{o.title}</Chip>;
}

// Порог покрытия — всегда с одним знаком после запятой: «×1,2», «×2,0».
const x = (v: number) => `×${v.toFixed(1).replace('.', ',')}`;

/** Порог: что он значит, текущее значение крупно, слайдер с меткой действующего значения и краями шкалы. */
function Rule({
  title,
  text,
  value,
  shown,
  current,
  currentLabel,
  range,
  format,
  onChange,
}: {
  title: string;
  text: string;
  value: number;
  shown: string;
  current: number;
  currentLabel: string;
  range: { min: number; max: number; step: number };
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const at = ((current - range.min) / (range.max - range.min)) * 100;
  return (
    <div className="potok-rule">
      <div className="potok-rule-head">
        <Title order={3}>{title}</Title>
        <span className="potok-rule-val">{shown}</span>
      </div>
      <p className="potok-rule-text">{text}</p>
      <div className="potok-rule-slider">
        <Slider
          min={range.min}
          max={range.max}
          step={range.step}
          value={value}
          onChange={onChange}
          label={null}
          thumbLabel={title}
        />
        <span className="potok-rule-mark" style={{ left: `${at}%` }} aria-hidden="true">
          <span>сейчас {currentLabel}</span>
        </span>
      </div>
      <div className="potok-rule-scale" aria-hidden="true">
        <span>{format(range.min)}</span>
        <span>{format(range.max)}</span>
      </div>
    </div>
  );
}

function Summary({ title, s }: { title: string; s: PolicySummary }) {
  return (
    <div className="potok-sim-col">
      <Text fw={600}>{title}</Text>
      <Text fz="sm" c="dimmed">
        нагрузка до {percent(s.max_dsr, 0)} выручки, покрытие от {x(s.min_coverage)}
      </Text>
      <dl className="potok-pairs">
        <div>
          <dt>Положительные решения</dt>
          <dd>{percent(s.approval_share, 0)}</dd>
        </div>
        <div>
          <dt>Объём предложений</dt>
          <dd>{money(s.offered_total)}</dd>
        </div>
      </dl>
      <div className="potok-sim-chips">
        {Object.entries(s.counts).map(([code, n]) => (
          <Chip key={code} tone={OUTCOME[code]?.tone ?? 'neutral'}>
            {OUTCOME[code]?.title ?? code}: {n}
          </Chip>
        ))}
      </div>
    </div>
  );
}

/** Симулятор политики: как изменились бы решения по сохранённым заявкам при других порогах. Заявки не меняются. */
export function PolicyPage() {
  const [maxDsr, setMaxDsr] = useState(CURRENT.dsr);
  const [coverage, setCoverage] = useState(CURRENT.coverage);
  const sim = usePolicySimulation();
  const run = () => sim.mutate({ max_dsr: maxDsr / 100, min_coverage: coverage });
  const changed = maxDsr !== CURRENT.dsr || Math.abs(coverage - CURRENT.coverage) > 1e-9;

  return (
    <div className="potok-policy-page">
      <div>
        <Title order={1}>Кредитная политика</Title>
        <Text c="dimmed" mt={4}>
          Измените пороги и посмотрите, как изменились бы решения по уже поданным заявкам.
        </Text>
      </div>

      <div className="potok-policy">
        <section className="potok-panel">
          <Rule
            title="Нагрузка на выручку"
            text={`Максимальная нагрузка: ${maxDsr}% выручки на все кредитные платежи`}
            value={maxDsr}
            shown={`${maxDsr}%`}
            current={CURRENT.dsr}
            currentLabel={`${CURRENT.dsr}%`}
            range={DSR}
            format={(v) => `${v}%`}
            onChange={setMaxDsr}
          />
          <Rule
            title="Покрытие платежа прибылью"
            text={`Минимальное покрытие нового платежа прибылью: ${x(coverage)}`}
            value={coverage}
            shown={x(coverage)}
            current={CURRENT.coverage}
            currentLabel={x(CURRENT.coverage)}
            range={COVERAGE}
            format={x}
            onChange={setCoverage}
          />
          <Text fz="sm" c="dimmed" mt="lg">
            Действующие значения — по правилам от 22 октября. Пересчёт идёт теми же правилами, что и в конвейере; для
            заявок у специалиста сравнивается рекомендация конвейера.
          </Text>
          <div className="potok-cta" style={{ marginTop: 24 }}>
            <Button size="lg" onClick={run} loading={sim.isPending}>
              Рассчитать
            </Button>
            {changed && (
              <Button
                size="lg"
                variant="subtle"
                onClick={() => {
                  setMaxDsr(CURRENT.dsr);
                  setCoverage(CURRENT.coverage);
                  sim.reset();
                }}
              >
                Вернуть действующие
              </Button>
            )}
          </div>
          {sim.error && (
            <div className="potok-inline-note" data-tone="warn" role="alert">
              {sim.error instanceof ApiError ? sim.error.message : 'Не удалось рассчитать — попробуйте ещё раз.'}
            </div>
          )}
        </section>

        <section className="potok-panel" aria-label="Что изменится" aria-busy={sim.isPending}>
          <Title order={3}>Что изменится</Title>
          {!sim.data ? (
            <>
              <Text fz="sm" c="dimmed" mt={4}>
                Покажем, сколько поданных заявок изменят исход и какие именно.
              </Text>
              <div className="potok-sim-preview" aria-hidden="true">
                <Skeleton h={40} w="60%" radius="md" />
                {[0, 1, 2].map((i) => (
                  <div key={i} className="potok-sim-sk">
                    <Skeleton h={14} radius="sm" />
                    <Skeleton h={14} radius="sm" />
                    <Skeleton h={14} radius="sm" />
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <p className="potok-sim-total">
                Изменится решение: {sim.data.changed.length} из {sim.data.applications}
              </p>
              <div className="potok-sim-cols">
                <Summary title="По текущей политике" s={sim.data.current} />
                <Summary title="С новыми порогами" s={sim.data.simulated} />
              </div>
              {sim.data.changed.length === 0 ? (
                <Text c="dimmed" fz="sm" mt="md">
                  При этих порогах ни одно решение не меняется.
                </Text>
              ) : (
                <ul className="potok-rows potok-sim-rows">
                  {sim.data.changed.map((r) => (
                    <li key={r.id}>
                      <Link to={`/applications/${r.id}`} className="potok-row potok-sim-row">
                        <span className="potok-row-main">
                          <span className="potok-row-title">{nb(r.company)}</span>
                          <span className="potok-row-sub">
                            {nb(r.number)}, {nb(r.product)}, {money(r.requested)}
                          </span>
                        </span>
                        <span className="potok-sim-change">
                          <Outcome code={r.outcome_now} />
                          <span aria-label="станет">→</span>
                          <Outcome code={r.outcome_then} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
