import { Button, Collapse, Group, Modal, Stack, Table, Text, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useState } from 'react';
import { Link } from 'react-router';

import { useAcceptOffer, useDeclineOffer, useHandoffOffer, useProducts } from '../api/hooks';
import type { Application, Product } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { schedule, type ScheduleRowCalc } from '../lib/finance';
import { NBSP, dayMonth, money, moneyBig, months, monthsShort, rate, typo } from '../lib/format';
import { nb } from '../lib/nobreak';
import { BarsLegend, PaymentBars } from './PaymentBars';
import { StatusBlock } from './Status';

function useProduct(code: string | undefined): Product | undefined {
  const products = useProducts();
  return products.data?.find((p) => p.code === code);
}

function nextMonth(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

/** Сумма и платёж — самые крупные цифры экрана, графитом. */
function Figures({
  amount,
  term,
  ratePct,
  payment,
  interestOnly,
}: {
  amount: number;
  term: number;
  ratePct: number;
  payment: number;
  interestOnly: boolean;
}) {
  return (
    <div className="potok-figures">
      <div>
        <div className="potok-big" data-testid="offer-amount">
          {moneyBig(amount)}
        </div>
        <div className="potok-under" data-testid="offer-terms">
          {interestOnly ? 'лимит ' : ''}на {months(term)} под {rate(ratePct)} годовых
        </div>
      </div>
      <div>
        <div className="potok-big" data-testid="offer-payment">
          {moneyBig(payment)}
        </div>
        <div className="potok-under">
          {interestOnly ? 'проценты в месяц при полном использовании лимита весь срок' : `платёж в месяц, ${term}${NBSP}платежей`}
        </div>
      </div>
    </div>
  );
}

/**
 * Переплата и полная стоимость. У овердрафта — ровно показанные проценты в месяц × срок (лимит использован весь
 * срок), у кредита — сумма платежей графика.
 */
function Cost({ rows, amount, interestOnly, monthly, term }: { rows: ScheduleRowCalc[]; amount: number; interestOnly: boolean; monthly: number; term: number }) {
  const overpay = interestOnly ? monthly * term : rows.reduce((s, r) => s + r.payment, 0) - amount;
  return (
    <div className="potok-cost">
      <span>
        {interestOnly ? 'Проценты за весь срок при полном использовании лимита' : 'Переплата'} <b>{money(overpay)}</b>
      </span>
      <span>
        Всего вернёте <b>{money(amount + overpay)}</b>
      </span>
    </div>
  );
}

/** Сравнение с заявкой — только у контрпредложения. */
function Compare({ app, offered }: { app: Application; offered?: Product }) {
  const offer = app.offer!;
  const other = offer.product_code !== app.product.code;
  const diffMoney = app.amount - offer.amount;
  const diffTerm = offer.term_months - app.term_months;
  const payment = offered?.repayment === 'interest_only' ? `${money(offer.monthly_payment)} — только проценты` : money(offer.monthly_payment);
  const rows: [string, string, string, string | null][] = [
    ...(other ? ([['Продукт', app.product.name, offered?.name ?? '…', null]] as [string, string, string, string | null][]) : []),
    [
      'Сумма',
      money(app.amount),
      money(offer.amount),
      diffMoney > 0 ? `на ${money(diffMoney)} меньше` : diffMoney < 0 ? `на ${money(-diffMoney)} больше` : 'как просили',
    ],
    [
      'Срок',
      months(app.term_months),
      months(offer.term_months),
      diffTerm > 0 ? `на ${monthsShort(diffTerm)} дольше` : diffTerm < 0 ? `на ${monthsShort(-diffTerm)} короче` : 'как просили',
    ],
    // Ставка у заявки — объявленная ставка продукта «от», в предложении — точная; у другого продукта она другая.
    ['Ставка', `от${NBSP}${rate(app.product.rate)}`, rate(offer.rate), null],
    ['Платёж в месяц', `≈${NBSP}${money(app.monthly_payment)}`, payment, null],
  ];
  return (
    <Table className="potok-compare" withRowBorders verticalSpacing={10} aria-label="Сравнение с заявкой">
      <Table.Thead>
        <Table.Tr>
          <Table.Th />
          <Table.Th>Вы просили</Table.Th>
          <Table.Th>Банк предлагает</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map(([label, asked, given, delta]) => (
          <Table.Tr key={label}>
            <Table.Td className="potok-compare-k">{label}</Table.Td>
            <Table.Td className="potok-compare-was">{nb(asked)}</Table.Td>
            <Table.Td className="potok-compare-now">
              {nb(given)}
              {delta && <span className="potok-compare-delta">{delta}</span>}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function ScheduleTable({ rows }: { rows: ScheduleRowCalc[] }) {
  return (
    <div className="potok-table-wrap">
      <Table stickyHeader withRowBorders verticalSpacing={8} aria-label="График платежей">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>№</Table.Th>
            <Table.Th ta="right">Платёж</Table.Th>
            <Table.Th ta="right" className="potok-hide-phone">
              Основной долг
            </Table.Th>
            <Table.Th ta="right" className="potok-hide-phone">
              Проценты
            </Table.Th>
            <Table.Th ta="right">Остаток</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r) => (
            <Table.Tr key={r.n}>
              <Table.Td>{r.n}</Table.Td>
              <Table.Td ta="right">{money(r.payment)}</Table.Td>
              <Table.Td ta="right" className="potok-hide-phone">
                {money(r.principal)}
              </Table.Td>
              <Table.Td ta="right" className="potok-hide-phone">
                {money(r.interest)}
              </Table.Td>
              <Table.Td ta="right">{money(r.balance)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

/** График платежей по условиям предложения; у овердрафта вместо столбиков — как он погашается. */
function OfferSchedule({ rows, interestOnly, amount }: { rows: ScheduleRowCalc[]; interestOnly: boolean; amount: number }) {
  const [open, setOpen] = useState(false);
  if (interestOnly) {
    return (
      <Text className="potok-note" mt="lg">
        Каждый месяц платятся только проценты (при полном использовании лимита), основной долг {money(amount)}{' '}
        возвращается в конце срока.
      </Text>
    );
  }
  return (
    <section className="potok-sched">
      <div className="potok-sched-head">
        <Title order={3}>График платежей</Title>
        <BarsLegend />
      </div>
      <PaymentBars rows={rows} firstDate={nextMonth()} />
      <Text fz="sm" c="dimmed" mt={8}>
        Даты — если деньги поступят сегодня; точный график будет в договоре.
      </Text>
      <Button variant="subtle" px={0} mt="xs" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? 'Скрыть платежи' : `Все ${rows.length}${NBSP}платежей`}
      </Button>
      <Collapse in={open}>
        <ScheduleTable rows={rows} />
      </Collapse>
    </section>
  );
}

/** Принять или отказаться — одна главная кнопка; на телефоне она в закреплённой нижней панели, остальное — в потоке. */
export function OfferActions({ app }: { app: Application }) {
  const { user } = useAuth();
  const accept = useAcceptOffer(app.id);
  const decline = useDeclineOffer(app.id);
  const handoff = useHandoffOffer(app.id);
  const [declineOpened, setDeclineOpened] = useState(false);
  const [comment, setComment] = useState('');
  const canAccept = app.allowed_actions.includes('accept_offer');
  const canDecline = app.allowed_actions.includes('decline_offer');
  const canHandoff = app.allowed_actions.includes('handoff_to_signer');
  const waitsForDirector = user?.role === 'client' && !user.can_sign && app.offer?.status === 'active';
  if (!canAccept && !canDecline && !waitsForDirector) return null;
  const director = user?.company?.director ? ` — ${user.company.director}` : '';

  const doAccept = () =>
    accept.mutate(undefined, {
      onSuccess: () => notifications.show({ message: 'Предложение принято. Договор готов к подписанию.' }),
    });

  return (
    <>
      {!canAccept && (
        <div className="potok-inline-note" role="alert">
          {/* Пол руководителя по ФИО не знаем — текст без «он/она». */}
          {app.awaiting_signer
            ? `Предложение передано руководителю${director}: уведомление уже в кабинете руководителя, осталось принять предложение и подписать договор.`
            : `Принять предложение, отказаться от него и подписать договор может только руководитель компании${director}. Передайте предложение руководителю — уведомление придёт в кабинет.`}
        </div>
      )}
      <div className="potok-cta">
        {canAccept && (
          <div className="potok-cta-main">
            <Button size="lg" loading={accept.isPending} onClick={doAccept}>
              Принять предложение
            </Button>
          </div>
        )}
        {canHandoff && (
          <div className={canAccept ? undefined : 'potok-cta-main'}>
            <Button size="lg" variant="default" loading={handoff.isPending} onClick={() => handoff.mutate()}>
              Передать руководителю на подпись
            </Button>
          </div>
        )}
        {canDecline && (
          <Button size="lg" variant="subtle" onClick={() => setDeclineOpened(true)}>
            Отказаться от предложения
          </Button>
        )}
      </div>
      <Modal opened={declineOpened} onClose={() => setDeclineOpened(false)} title={<Text fw={600}>Отказаться от предложения?</Text>}>
        <Stack>
          <Text fz="sm" c="dimmed">
            Заявка будет закрыта. Подобрать другой вариант можно в любой момент — данные компании сохранятся.
          </Text>
          <Textarea
            label="Что не подошло, необязательно"
            placeholder="Например: нужна бо́льшая сумма"
            value={comment}
            onChange={(e) => setComment(e.currentTarget.value)}
            autosize
            minRows={2}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeclineOpened(false)}>
              Вернуться
            </Button>
            <Button
              loading={decline.isPending}
              onClick={() =>
                decline.mutate(
                  { comment: comment || undefined },
                  {
                    onSuccess: () => {
                      setDeclineOpened(false);
                      notifications.show({ message: 'Вы отказались от предложения. Заявка закрыта.' });
                    },
                  },
                )
              }
            >
              Отказаться
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

/** Что сказать, когда отказ из-за стоп-фактора: ограничение касается самой компании, а не суммы или продукта. */
const HARD_STOP_TIPS = [
  'Если в ЕГРЮЛ ошибка в статусе компании, исправьте её через налоговую — после этого можно подать новую заявку',
  'Другой продукт или меньшая сумма решение не изменят: ограничение касается компании, а не условий кредита',
];

const OUTCOME: Record<string, string> = {
  approved: 'Банк готов выдать кредит',
  counter_offer: 'Банк готов выдать на других условиях',
};

/** Блок решения — один на экране: статус, исход, сумма и платёж, сравнение, график, действие. */
export function DecisionBlock({ app }: { app: Application }) {
  const offered = useProduct(app.offer?.product_code);
  const code = app.status.code;
  const offer = app.offer;

  if ((code === 'approved' || code === 'counter_offer') && offer) {
    const interestOnly = offered?.repayment === 'interest_only';
    const rows = schedule(offer.amount, offer.rate, offer.term_months, offered?.repayment ?? 'annuity', offer.monthly_payment);
    const other = offer.product_code !== app.product.code;
    return (
      <section className="potok-decision" aria-live="polite">
        <StatusBlock
          app={app}
          onPage
          showLabels
          hint={false}
          note={offer.valid_until ? `предложение действует до ${dayMonth(offer.valid_until)}` : undefined}
        />
        <Title order={2} className="potok-say">
          {other ? nb(`Вместо кредита «${app.product.name}» банк предлагает «${offered?.name ?? '…'}»`) : OUTCOME[code]}
        </Title>
        <Figures amount={offer.amount} term={offer.term_months} ratePct={offer.rate} payment={offer.monthly_payment} interestOnly={interestOnly} />
        <Cost rows={rows} amount={offer.amount} interestOnly={interestOnly} monthly={offer.monthly_payment} term={offer.term_months} />
        {code === 'counter_offer' && <Compare app={app} offered={offered} />}
        <OfferSchedule rows={rows} interestOnly={interestOnly} amount={offer.amount} />
        <OfferActions app={app} />
      </section>
    );
  }

  if (code === 'rejected' && app.decision) {
    // Советов нет — сработал стоп-фактор (например, ликвидация): другой продукт или сумма не помогут,
    // поэтому «Подобрать другой вариант» не предлагаем.
    const hardStop = app.decision.tips.length === 0;
    const tips = hardStop ? HARD_STOP_TIPS : app.decision.tips;
    return (
      <section className="potok-decision" aria-live="polite">
        <StatusBlock app={app} onPage showLabels hint={false} note="банк отказал" />
        <Title order={2} className="potok-say">
          {hardStop ? 'Банк не может выдать кредит этой компании' : 'Банк не может выдать этот кредит сейчас'}
        </Title>
        <div className="potok-asked">
          Вы просили {moneyBig(app.amount)} на {months(app.term_months)}
        </div>
        <div className="potok-lists">
          <section>
            <Title order={3}>Почему банк отказал</Title>
            <ul aria-label="Причины отказа">
              {app.decision.reasons.map((r) => (
                <li key={r}>{typo(r)}</li>
              ))}
            </ul>
          </section>
          <section>
            <Title order={3}>Что можно сделать</Title>
            <ul aria-label="Что можно сделать">
              {tips.map((t) => (
                <li key={t}>{typo(t)}</li>
              ))}
            </ul>
          </section>
        </div>
        {/* При стоп-факторе предложить нечего: «На главную» — спокойная вторичная кнопка, не закреплённая внизу. */}
        <div className="potok-cta">
          {hardStop ? (
            <Button component={Link} to="/" size="lg" variant="default">
              На главную
            </Button>
          ) : (
            <div className="potok-cta-main">
              <Button component={Link} to="/match" size="lg">
                Подобрать другой вариант
              </Button>
            </div>
          )}
        </div>
      </section>
    );
  }

  return null;
}

/** Почему решение такое — второй план под блоком решения. */
export function DecisionReasons({ app }: { app: Application }) {
  const d = app.decision;
  if (!d || !d.reasons.length) return null;
  const title =
    app.status.code === 'approved'
      ? 'Почему одобрено'
      : app.status.code === 'counter_offer'
        ? 'Почему условия другие'
        : app.status.code === 'manual_review'
          ? 'Почему заявку смотрит специалист'
          : null;
  if (!title) return null;
  return (
    <section className="potok-panel">
      <Title order={3}>{title}</Title>
      <ul className="potok-list">
        {d.reasons.map((r) => (
          <li key={r}>{typo(r)}</li>
        ))}
      </ul>
    </section>
  );
}

/** Что дальше по предложению — настоящая последовательность, поэтому с номерами. */
export function NextSteps({ app }: { app: Application }) {
  const product = useProduct(app.offer?.product_code);
  const { user } = useAuth();
  if (!['approved', 'counter_offer'].includes(app.status.code)) return null;
  const last =
    product?.repayment === 'interest_only'
      ? 'Банк открывает лимит овердрафта на расчётном счёте'
      : product?.collateral
        ? 'После оформления залога деньги приходят на расчётный счёт'
        : 'Деньги приходят на расчётный счёт';
  return (
    <section className="potok-panel">
      <Title order={3}>Что дальше</Title>
      <ol className="potok-steps">
        {user?.can_sign ? (
          <>
            <li>Вы принимаете предложение</li>
            <li>Подписываете договор кодом в окне подписания</li>
          </>
        ) : (
          <>
            <li>Вы передаёте предложение руководителю</li>
            <li>Руководитель принимает его и подписывает договор кодом в кабинете</li>
          </>
        )}
        <li>{last}</li>
      </ol>
    </section>
  );
}
