import { Button, Collapse, Group, Loader, Modal, Radio, Stack, Table, Text, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import {
  useAcceptOffer,
  useApprovalMap,
  useCreateApplication,
  useDecisionExplanation,
  useDeclineOffer,
  useHandoffOffer,
  useProducts,
} from '../api/hooks';
import type { Application, ApprovalMap, ApprovalTerm, Product } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { schedule, type ScheduleRowCalc } from '../lib/finance';
import { NBSP, dayMonth, money, moneyBig, months, monthsShort, rate, typo } from '../lib/format';
import { nb } from '../lib/nobreak';
import { ChoiceMark } from './Choice';
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

/** «≈ 343 000 ₽»: платёж на карте — ориентир до тысяч (у небольших сумм — до десятков). */
function approx(value: number): number {
  return value >= 10_000 ? Math.round(value / 1000) * 1000 : Math.round(value / 10) * 10;
}

const sentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

/** Строка карты: срок, сумма до границы, платёж, отметки; полоса — сумма относительно лучшего срока на карте. */
function ApprovalRow({ term, best, interestOnly }: { term: ApprovalTerm; best: number; interestOnly: boolean }) {
  const marks = [term.requested && 'вы просили', term.offered && 'предложение банка'].filter(Boolean) as string[];
  const tags = marks.length > 0 && (
    <>
      {' '}
      <span className="potok-amap-tags">
        {marks.map((m) => (
          <span key={m} className="potok-tag">
            {m}
          </span>
        ))}
      </span>
    </>
  );
  if (term.amount === null || term.monthly_payment === null) {
    // Не проходит ни на какую сумму — не вариант выбора: строка тихая, без отметки, стрелки её пропускают.
    return (
      <div className="potok-amap-row potok-amap-off">
        <span className="potok-choice-text">
          <span className="potok-choice-title">{monthsShort(term.term_months)} — не пройдёт</span>
          {tags}
        </span>
      </div>
    );
  }
  const pay = `≈${NBSP}${money(approx(term.monthly_payment))} ${interestOnly ? 'процентов в месяц' : 'в месяц'}`;
  if (term.offered) {
    // Эти условия банк уже предлагает выше — новая заявка на них была бы дублем, поэтому строка не для выбора.
    return (
      <div className="potok-amap-row potok-amap-current">
        <span className="potok-choice-text">
          <span className="potok-amap-line">
            <span className="potok-choice-title">
              {monthsShort(term.term_months)} — до {money(term.amount)}
            </span>{' '}
            <span className="potok-amap-pay">
              <span className="potok-amap-dot">· </span>
              {pay}
            </span>
          </span>
          {tags}
          <span className="potok-amap-bar" aria-hidden="true">
            <span style={{ width: `${Math.max(4, Math.round((term.amount / best) * 100))}%` }} />
          </span>
          <span className="potok-note">Эти условия — в предложении выше</span>
        </span>
      </div>
    );
  }
  return (
    <Radio.Card value={String(term.term_months)} className="potok-choice potok-amap-row">
      <span className="potok-choice-text">
        <span className="potok-amap-line">
          <span className="potok-choice-title">
            {monthsShort(term.term_months)} — до {money(term.amount)}
          </span>{' '}
          <span className="potok-amap-pay">
            <span className="potok-amap-dot">· </span>
            {pay}
          </span>
        </span>
        {tags}
        <span className="potok-amap-bar" aria-hidden="true">
          <span style={{ width: `${Math.max(4, Math.round((term.amount / best) * 100))}%` }} />
        </span>
      </span>
      <ChoiceMark />
    </Radio.Card>
  );
}

/** Ни один срок не проходит: одной строкой почему и что банк предложит вместо этого продукта. */
function ApprovalNone({ app, map }: { app: Application; map: ApprovalMap }) {
  // Сервер объясняет по самому долгому сроку и минимальной сумме: раз не проходят они, не проходит ни один срок.
  const only = map.terms.length === 1 ? map.terms[0].term_months : null;
  const where = only !== null ? `на ${months(only)}` : 'ни на одном сроке';
  const alt = map.alternative;
  const offer = app.offer;
  const isOffer =
    !!alt && !!offer && alt.product_code === offer.product_code && alt.amount === offer.amount && alt.term_months === offer.term_months;
  return (
    <>
      <Text className="potok-amap-none" mt={10}>
        <b>{nb(`«${map.product_name}» не пройдёт ${where}.`)}</b> {map.explanation && nb(typo(sentence(map.explanation)))}
      </Text>
      {alt && (
        <Text className="potok-note" mt={8}>
          {nb(
            typo(
              isOffer
                ? `Поэтому банк предлагает «${alt.product_name}» — его условия выше.`
                : `По тем же правилам банк одобрит «${alt.product_name}»: ${money(alt.amount)} на ${months(alt.term_months)}.`,
            ),
          )}
        </Text>
      )}
    </>
  );
}

/**
 * «Сколько банк одобрит на другом сроке» — граница одобрения по тому же продукту под решением банка. Суммы посчитаны
 * теми же правилами скоринга и решения на тех же данных компании, поэтому это не прогноз: заявку на выбранные условия
 * банк одобрит сразу, пока данные компании не изменились. Выбор строки — как в списке вариантов: красная рамка по
 * всему контуру. «Оформить на этих условиях» — вторичная кнопка: главное действие экрана остаётся одно.
 * Аналитику, при одобрении и при стоп-факторе панели нет (у стоп-фактора сервер возвращает пустую карту).
 */
function ApprovalMapPanel({ app }: { app: Application }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const create = useCreateApplication();
  const headingId = useId();
  const owner = user?.role === 'client' && user.company?.id === app.company.id;
  const map = useApprovalMap(app, owner);
  const [picked, setPicked] = useState<string | null>(null);
  const data = map.data;
  if (!owner || !data || data.terms.length === 0) return null;

  const passing = data.terms.filter((t) => t.amount !== null);
  const best = Math.max(0, ...passing.map((t) => t.amount ?? 0));
  // Строку с условиями действующего предложения не выбирают: они уже выше, в решении банка.
  const chosen = passing.find((t) => !t.offered && String(t.term_months) === picked) ?? null;
  const start = () => {
    if (!chosen || chosen.amount === null) return;
    create.mutate(
      {
        product_code: data.product_code,
        purpose: app.purpose,
        amount: chosen.amount,
        term_months: chosen.term_months,
        // Анкета — из этой заявки, чтобы не заполнять её заново; согласие на запрос в БКИ даётся к каждой заявке.
        form: { ...app.form, consent_bki: false },
      },
      { onSuccess: (created) => navigate(`/applications/${created.id}/edit`) },
    );
  };

  return (
    <section className="potok-amap" aria-labelledby={headingId}>
      <Title order={3} id={headingId}>
        Сколько банк одобрит на другом сроке
      </Title>
      {passing.length === 0 ? (
        <ApprovalNone app={app} map={data} />
      ) : (
        <>
          <Text className="potok-note" mt={6}>
            Это не прогноз: суммы посчитаны по тем же правилам и данным, что и решение выше. Заявку на выбранные срок и
            сумму банк одобрит сразу, если данные компании не изменятся.
          </Text>
          <Radio.Group value={picked} onChange={setPicked}>
            <div className="potok-choices potok-amap-list" role="radiogroup" aria-label="Сколько банк одобрит на каждом сроке">
              {data.terms.map((t) => (
                <ApprovalRow key={t.term_months} term={t} best={best} interestOnly={data.repayment === 'interest_only'} />
              ))}
            </div>
          </Radio.Group>
          <div className="potok-amap-act">
            <Button variant="default" size="md" disabled={!chosen} loading={create.isPending} onClick={start}>
              Оформить на этих условиях
            </Button>
            <Text fz="sm" c="dimmed" aria-live="polite">
              {chosen && chosen.amount !== null
                ? `Новая заявка: ${money(chosen.amount)} на ${months(chosen.term_months)}. Анкета заполнится из этой${
                    app.offer?.status === 'active' ? ', а нынешнее предложение останется в силе' : ''
                  }.`
                : 'Выберите срок — откроется новая заявка с этими суммой и сроком.'}
            </Text>
          </div>
        </>
      )}
    </section>
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
        {/* Без права подписи передача руководителю — главное действие экрана, поэтому красная. */}
        {canHandoff && (
          <div className={canAccept ? undefined : 'potok-cta-main'}>
            <Button size="lg" variant={canAccept ? 'default' : 'filled'} loading={handoff.isPending} onClick={() => handoff.mutate()}>
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

/** Заголовки решения на экране клиента; их же показывает предпросмотр «Клиент увидит» в карточке аналитика. */
export const OUTCOME: Record<string, string> = {
  approved: 'Банк готов выдать кредит',
  counter_offer: 'Банк готов выдать на других условиях',
};

export const REASONS_TITLE: Record<string, string> = {
  approved: 'Почему одобрено',
  counter_offer: 'Почему условия другие',
  rejected: 'Почему банк отказал',
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
        {code === 'counter_offer' && <ApprovalMapPanel app={app} />}
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
            <Title order={3}>{REASONS_TITLE.rejected}</Title>
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
        {/* Без стоп-фактора — сколько банк одобрит на каждом сроке: иногда меньшая сумма или другой срок проходят. */}
        {!hardStop && <ApprovalMapPanel app={app} />}
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

/** Почему решение такое — второй план под блоком решения. Почему заявку смотрит специалист — в самом блоке статуса. */
export function DecisionReasons({ app }: { app: Application }) {
  const d = app.decision;
  if (!d || !d.reasons.length) return null;
  const title =
    app.status.code === 'approved' || app.status.code === 'counter_offer' ? REASONS_TITLE[app.status.code] : null;
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

/**
 * Пояснение решения простыми словами от языковой модели (необязательная функция) — панель второго плана, как у
 * причин, сразу после них. Пока текст готовится — одна спокойная строка, когда готов — обычные абзацы и тихая
 * пометка, что текст сформирован автоматически. Функция выключена, ошибка, текст не прошёл проверку — ничего:
 * условия и причины банка выше остаются единственным источником.
 */
export function AutoExplanation({ app }: { app: Application }) {
  const { data } = useDecisionExplanation(app);
  const pending = data?.status === 'pending';
  const text = data?.status === 'ready' ? data.text : null;
  if (!pending && !text) return null;
  // Один элемент и для ожидания, и для текста: область aria-live не пересоздаётся, готовый текст зачитывается.
  return (
    <section
      className="potok-panel"
      aria-live="polite"
      aria-busy={pending}
      data-testid={text ? 'auto-explanation' : 'auto-explanation-pending'}
    >
      {text ? (
        <>
          <Title order={3}>Простыми словами</Title>
          {text.split(/\n+/).map((p, i) => (
            <Text key={i} mt={i ? 8 : 10}>
              {nb(typo(p))}
            </Text>
          ))}
          <Text fz="sm" c="dimmed" mt="md">
            Сформировано автоматически языковой моделью по данным этого решения. Если что-то расходится, действуют
            условия и причины банка выше.
          </Text>
        </>
      ) : (
        <Group gap={8} wrap="nowrap">
          <Loader size="xs" color="gray" />
          <Text fz="sm" c="dimmed">
            Готовим пояснение простыми словами…
          </Text>
        </Group>
      )}
    </section>
  );
}

const PIPELINE = ['submitted', 'validation', 'enrichment', 'scoring'];

/**
 * Что дальше по заявке — настоящая последовательность, поэтому с номерами: проверка, ответ на запрос, решение
 * специалиста, предложение, подписание. На телефоне — сразу под главным блоком.
 */
export function NextSteps({ app }: { app: Application }) {
  const offered = useProduct(app.offer?.product_code);
  const asked = useProduct(app.product.code);
  const { user } = useAuth();
  const code = app.status.code;
  const product = offered ?? asked;
  const payout =
    product?.repayment === 'interest_only'
      ? 'Банк открывает лимит овердрафта на расчётном счёте'
      : product?.collateral
        ? 'После оформления залога деньги приходят на расчётный счёт'
        : 'Деньги приходят на расчётный счёт';
  const decision =
    asked?.decision === 'manual'
      ? 'Решение примет кредитный специалист — придёт уведомление в кабинет'
      : 'Банк примет решение и пришлёт уведомление в кабинет';

  let steps: string[] | null = null;
  if (code === 'approved' || code === 'counter_offer') {
    steps = user?.can_sign
      ? ['Вы принимаете предложение', 'Подписываете договор кодом в окне подписания', payout]
      : ['Вы передаёте предложение руководителю', 'Руководитель принимает его и подписывает договор кодом в кабинете', payout];
  } else if (code === 'signing' && app.offer?.status !== 'signed') {
    const last =
      product?.repayment === 'interest_only'
        ? 'Введите 6 цифр, и лимит овердрафта откроется через несколько секунд'
        : app.open_tasks > 0
          ? 'Введите 6 цифр и закройте условия выдачи — после этого деньги придут на счёт'
          : 'Введите 6 цифр, и деньги придут на счёт через несколько секунд';
    steps = app.allowed_actions.includes('sign')
      ? ['Отметьте согласие с условиями договора', 'Нажмите «Подписать кодом»: код появится в окне подписания, SMS не нужна', last]
      : ['Руководитель открывает договор в своём кабинете', 'Подписывает его кодом из окна подписания', payout];
  } else if (code === 'needs_info') {
    steps = ['Вы отвечаете на запрос банка', 'Проверка продолжается сама — ничего нажимать не нужно', decision];
  } else if (code === 'manual_review') {
    steps = [
      'Специалист проверяет оценку, данные компании и условия',
      'Решение придёт уведомлением в кабинет',
      'Если банк одобрит, вы примете предложение и подпишете договор кодом',
    ];
  } else if (PIPELINE.includes(code)) {
    steps = ['Банк сам проверяет компанию в ЕГРЮЛ, ФНС и БКИ', 'Оценивает заявку и подбирает условия', decision];
  }
  if (!steps) return null;
  return (
    <section className="potok-panel potok-phone-first">
      <Title order={3}>Что дальше</Title>
      <ol className="potok-steps">
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </section>
  );
}
