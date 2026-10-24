import { Button, Modal, ScrollArea, SimpleGrid, Skeleton, Stack, Table, Text, Title } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { useCalculation, useCreateApplication, useMatch, useMeta, useProducts } from '../api/hooks';
import type { Product, ProductMatch, Purpose } from '../api/types';
import { ChoiceList } from '../components/Choice';
import { AmountTermFields } from '../components/Money';
import { Empty } from '../components/States';
import { Chip } from '../components/Status';
import { Stat } from '../components/ui';
import { NBSP, money, moneyBig, months, rate, typo } from '../lib/format';
import { nb } from '../lib/nobreak';

function ScheduleModal({ match, onClose }: { match: ProductMatch | null; onClose: () => void }) {
  const calc = useCalculation(match?.product.code ?? null, match?.amount ?? 0, match?.term_months ?? 0);
  return (
    <Modal opened={match !== null} onClose={onClose} title={<Text fw={600}>График платежей</Text>} size="lg" centered>
      {calc.isLoading || !calc.data ? (
        <Skeleton h={300} />
      ) : (
        <Stack>
          <SimpleGrid cols={3}>
            <Stat label="Платёж" value={money(calc.data.monthly_payment)} />
            <Stat label="Переплата" value={money(calc.data.overpayment)} />
            <Stat label="Всего" value={money(calc.data.total)} />
          </SimpleGrid>
          <ScrollArea h={360}>
            <Table stickyHeader withRowBorders fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>№</Table.Th>
                  <Table.Th ta="right">Платёж</Table.Th>
                  <Table.Th ta="right">Основной долг</Table.Th>
                  <Table.Th ta="right">Проценты</Table.Th>
                  <Table.Th ta="right">Остаток</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {calc.data.schedule.map((r) => (
                  <Table.Tr key={r.n}>
                    <Table.Td>{r.n}</Table.Td>
                    <Table.Td ta="right">{money(r.payment)}</Table.Td>
                    <Table.Td ta="right">{money(r.principal)}</Table.Td>
                    <Table.Td ta="right">{money(r.interest)}</Table.Td>
                    <Table.Td ta="right">{money(r.balance)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
          <Text fz="sm" c="dimmed">
            Расчёт предварительный, по минимальной ставке продукта. Точные условия банк назовёт в решении.
          </Text>
        </Stack>
      )}
    </Modal>
  );
}

const interestOnly = (p: Product) => p.repayment === 'interest_only';

/** Сумма, срок и ставка варианта — одной фразой, без разделителей, которые переносятся в начало строки. */
function Terms({ match }: { match: ProductMatch }) {
  return (
    <p className="potok-terms-prose" data-testid="match-terms">
      {interestOnly(match.product) ? 'Лимит' : 'Сумма'} {money(match.amount)} на {months(match.term_months)}, от{NBSP}{rate(match.product.rate)} годовых
    </p>
  );
}

/** Лучший вариант — крупно: платёж, условия, почему подходит, главная кнопка. */
function BestOffer({ match, loading, onApply, onSchedule }: { match: ProductMatch; loading: boolean; onApply: () => void; onSchedule: () => void }) {
  const p = match.product;
  return (
    <article className="potok-offer" aria-label={p.name}>
      <div className="potok-offer-top">
        {match.fit === 'partial' ? <Chip tone="warning">Подходит с оговорками</Chip> : <Chip tone="success">Лучше всего подходит</Chip>}
        <span className="potok-muted-text">
          {p.decision === 'auto' ? 'Решение автоматически' : 'Рассматривает специалист'}, {p.decision_time}
        </span>
      </div>
      <Title order={3} className="potok-offer-name">
        {nb(p.name)}
      </Title>
      <Text c="dimmed">{p.tagline}</Text>
      <div className="potok-offer-pay">
        ≈{NBSP}{moneyBig(match.monthly_payment)} <span>{interestOnly(p) ? 'процентов в месяц' : 'в месяц'}</span>
      </div>
      <Terms match={match} />
      <ul className="potok-list">
        {match.reasons.map((r) => (
          <li key={r}>{typo(r)}</li>
        ))}
        {match.caveats.map((c) => (
          <li key={c} className="potok-muted-text">
            {typo(c)}
          </li>
        ))}
      </ul>
      <div className="potok-cta" style={{ marginTop: 24 }}>
        <Button size="lg" onClick={onApply} loading={loading}>
          Оформить заявку
        </Button>
        <Button size="lg" variant="subtle" onClick={onSchedule}>
          График платежей
        </Button>
      </div>
    </article>
  );
}

/** Остальные варианты — строкой; на телефоне строка складывается в столбик. */
function OtherOffer({ match, loading, onApply }: { match: ProductMatch; loading: boolean; onApply: () => void }) {
  const p = match.product;
  return (
    <article className="potok-offer-row" aria-label={p.name}>
      <div className="potok-offer-row-main">
        <Title order={3} className="potok-offer-row-name">
          {nb(p.name)}
        </Title>
        <Terms match={match} />
        {match.fit === 'partial' && match.caveats[0] && <Text fz="sm" c="dimmed" mt={4}>{match.caveats[0]}</Text>}
      </div>
      <div className="potok-offer-row-pay">
        ≈{NBSP}{money(match.monthly_payment)}
        <span>{interestOnly(p) ? 'процентов в месяц' : 'в месяц'}</span>
      </div>
      <Button size="md" variant="default" onClick={onApply} loading={loading}>
        Оформить заявку
      </Button>
    </article>
  );
}

/**
 * «Ваш расчёт» — пересчитывается по ответам: платёж и переплата по лучшему варианту, что понадобится и что
 * дальше. На 1440 — липкая правая колонка, на телефоне — свёрнутая строка под вопросами.
 */
function Estimate({ best, amount, term, purposeChosen, open }: { best?: ProductMatch; amount: number; term: number; purposeChosen: boolean; open: boolean }) {
  const p = best?.product;
  // Переплата — из расчёта банка (тот же график, что в договоре), а не «платёж × срок».
  const calc = useCalculation(p?.code ?? null, best?.amount ?? 0, best?.term_months ?? 0);
  const overpay = calc.data?.overpayment ?? null;
  return (
    <aside className="potok-match-side" data-open={open} aria-label="Ваш расчёт" id="estimate">
      <section className="potok-panel">
        <Title order={3}>Ваш расчёт</Title>
        <div className="potok-side-amount">{moneyBig(best?.amount ?? amount)}</div>
        <div className="potok-muted-text">
          на {months(best?.term_months ?? term)}
          {p ? `, ${p.name}` : ''}
        </div>
        {best && p ? (
          <dl className="potok-pairs potok-side-pairs">
            <div>
              <dt>{interestOnly(p) ? 'Проценты в месяц' : 'Платёж'}</dt>
              <dd>≈{NBSP}{money(best.monthly_payment)}</dd>
            </div>
            <div className="potok-side-extra">
              <dt>{interestOnly(p) ? 'Проценты за срок' : 'Переплата'}</dt>
              <dd>{overpay !== null ? `≈${NBSP}${money(overpay)}` : '…'}</dd>
            </div>
            <div className="potok-side-extra">
              <dt>Ставка</dt>
              <dd>от {rate(p.rate)}</dd>
            </div>
            <div className="potok-side-extra">
              <dt>Решение</dt>
              <dd>{p.decision_time}</dd>
            </div>
          </dl>
        ) : (
          <Text fz="sm" c="dimmed" mt="md">
            {purposeChosen ? 'Считаем платёж…' : 'Выберите цель — посчитаем платёж по подходящему продукту.'}
          </Text>
        )}
        <div className="potok-side-more">
          {best && (
            <Text fz="sm" c="dimmed" mt="md">
              Оценка по минимальной ставке: точные условия банк назовёт в решении.
            </Text>
          )}
          <Title order={4} mt="lg">
            Что понадобится
          </Title>
          <ul className="potok-rows">
            <li className="potok-side-row">
              <b>Данные компании</b>
              <span>Подставим из ЕГРЮЛ и ФНС сами</span>
            </li>
            {(p?.documents ?? ['Выписка по расчётному счёту за 6 месяцев']).map((d) => (
              <li key={d} className="potok-side-row">
                <b>{d}</b>
                <span>Можно приложить позже</span>
              </li>
            ))}
            {p?.collateral && (
              <li className="potok-side-row">
                <b>Обеспечение</b>
                <span>{p.collateral}</span>
              </li>
            )}
          </ul>
          <Title order={4} mt="lg">
            Что дальше
          </Title>
          <ol className="potok-steps">
            <li>Анкета: около 5 минут, черновик сохраняется сам</li>
            <li>Решение банка{p ? `: ${p.decision_time}` : ''}, придёт уведомление</li>
            <li>Подпись кодом в кабинете, и деньги придут на счёт</li>
          </ol>
        </div>
      </section>
    </aside>
  );
}

export function MatchPage() {
  const meta = useMeta();
  const products = useProducts();
  const navigate = useNavigate();
  const [purpose, setPurpose] = useState<Purpose | null>(null);
  const [amount, setAmount] = useState(3_000_000);
  const [term, setTerm] = useState(12);
  const [debouncedAmount] = useDebouncedValue(amount, 300);
  const [debouncedTerm] = useDebouncedValue(term, 300);
  const match = useMatch({ purpose, amount: debouncedAmount, term_months: debouncedTerm });
  const create = useCreateApplication();
  const [applying, setApplying] = useState<string | null>(null);
  const [scheduleFor, setScheduleFor] = useState<ProductMatch | null>(null);
  const [estimateOpen, setEstimateOpen] = useState(false);
  // Шкалы — по всему каталогу продуктов: от самого маленького минимума до самого большого максимума.
  const all = products.data ?? [];
  const minAmount = all.length ? Math.min(...all.map((p) => p.min_amount)) : 100_000;
  const maxAmount = all.length ? Math.max(...all.map((p) => p.max_amount)) : 50_000_000;
  const minTerm = all.length ? Math.min(...all.map((p) => p.min_term)) : 3;
  const maxTerm = all.length ? Math.max(...all.map((p) => p.max_term)) : 60;
  const results = purpose ? (match.data ?? []) : [];
  const [best, ...others] = results;

  const apply = (m: ProductMatch) => {
    if (!purpose) return;
    setApplying(m.product.code);
    create.mutate(
      { product_code: m.product.code, purpose, amount: m.amount, term_months: m.term_months },
      {
        onSuccess: (app) => navigate(`/applications/${app.id}/edit`),
        onSettled: () => setApplying(null),
      },
    );
  };

  return (
    <div className="potok-col">
      <div>
        <Title order={1}>Подобрать кредит</Title>
        <Text c="dimmed" mt={4}>
          Три вопроса, и вы увидите подходящие продукты с платежом. Ни к чему не обязывает.
        </Text>
      </div>

      <div className="potok-match">
        <section className="potok-panel potok-match-q">
          <Title order={3}>1. Для чего нужны деньги</Title>
          <div style={{ marginTop: 16 }}>
            {meta.data ? (
              <ChoiceList
                label="Для чего нужны деньги"
                value={purpose}
                onChange={setPurpose}
                options={meta.data.purposes.map((p) => ({ value: p.code, title: p.title, text: p.description }))}
              />
            ) : (
              <Skeleton h={320} radius="md" />
            )}
          </div>

          <Title order={3} mt={32}>
            2. Сколько и на какой срок
          </Title>
          <div style={{ marginTop: 16 }}>
            {/* До выбора продукта — общий диапазон каталога; подбор сам подгонит срок под продукт. */}
            <AmountTermFields
              amount={amount}
              onAmount={setAmount}
              term={term}
              onTerm={setTerm}
              minAmount={minAmount}
              maxAmount={maxAmount}
              minTerm={minTerm}
              maxTerm={maxTerm}
            />
          </div>
        </section>

        <Estimate best={best} amount={amount} term={term} purposeChosen={!!purpose} open={estimateOpen} />

        <section className="potok-panel potok-match-r" aria-label="Подходящие варианты">
          <Title order={3}>3. Подходящие варианты</Title>
          {!purpose ? (
            <Empty
              art="list"
              title="Выберите цель кредита"
              text="Покажем продукты, которые подходят под вашу задачу, и сразу посчитаем платёж."
            />
          ) : match.isLoading ? (
            <Skeleton h={320} radius={16} mt={16} />
          ) : match.isError ? (
            <div className="potok-inline-note" data-tone="warn" role="alert">
              Не получилось подобрать варианты: сервер банка не ответил. Измените сумму или срок, чтобы повторить, или
              обновите страницу.
            </div>
          ) : (
            <div className="potok-offers">
              {best && (
                <BestOffer
                  match={best}
                  loading={applying === best.product.code}
                  onApply={() => apply(best)}
                  onSchedule={() => setScheduleFor(best)}
                />
              )}
              {others.map((m) => (
                <OtherOffer key={m.product.code} match={m} loading={applying === m.product.code} onApply={() => apply(m)} />
              ))}
            </div>
          )}
          {/* На телефоне расчёт не занимает экран — он по ссылке под вариантами. */}
          <Button
            variant="subtle"
            px={0}
            mt="md"
            className="potok-phone-only"
            component="a"
            href="#estimate"
            onClick={() => setEstimateOpen((o) => !o)}
            aria-expanded={estimateOpen}
          >
            {estimateOpen ? 'Скрыть расчёт' : 'Ваш расчёт и документы'}
          </Button>
        </section>
      </div>

      <ScheduleModal match={scheduleFor} onClose={() => setScheduleFor(null)} />
    </div>
  );
}
