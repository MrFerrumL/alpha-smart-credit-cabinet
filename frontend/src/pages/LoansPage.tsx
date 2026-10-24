import { Anchor, Button, Skeleton, Table, Text, Title } from '@mantine/core';
import { useQueries } from '@tanstack/react-query';
import { IconArrowLeft, IconChevronRight } from '@tabler/icons-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';

import { ApiError, api } from '../api/client';
import { useApplications, useInterestOnly, useLoan, useLoans } from '../api/hooks';
import type { Application, Loan, LoanDetail } from '../api/types';
import { BarsLegend, PaymentBars } from '../components/PaymentBars';
import { MoreMoney, MyCompany } from '../components/Side';
import { Empty, LoadError } from '../components/States';
import { Chip } from '../components/Status';
import { NBSP, date, dayMonth, money, moneyBig, months, rate, shortDate } from '../lib/format';
import { nb } from '../lib/nobreak';

function LoanStatus({ loan }: { loan: Loan }) {
  return loan.status === 'active' ? <Chip tone="success">Действует</Chip> : <Chip tone="neutral">Погашен</Chip>;
}

/** Прогресс погашения: сколько платежей внесено и когда последний. */
function Progress({ loan, last }: { loan: Loan; last?: string }) {
  const share = loan.term_months ? loan.paid_payments / loan.term_months : 0;
  return (
    <div className="potok-progress">
      <div className="potok-progress-track">
        {share > 0 && <span style={{ width: `${share * 100}%` }} />}
      </div>
      <div className="potok-progress-scale">
        <span>
          оплачено {loan.paid_payments} из {loan.term_months}
        </span>
        {last && <span>последний платёж — {date(last)}</span>}
      </div>
    </div>
  );
}

/** Кредит в списке: продукт и статус, договор, долг к погашению, ближайший платёж, прогресс. */
function LoanRow({ loan }: { loan: Loan }) {
  return (
    <Link to={`/loans/${loan.id}`} className="potok-panel potok-loan-row">
      <div className="potok-home-top">
        <Title order={3}>{nb(loan.product_name)}</Title>
        <LoanStatus loan={loan} />
      </div>
      <Text fz="sm" c="dimmed" mt={2}>
        Договор {nb(loan.contract_number)}, выдан {date(loan.issued_at)}
      </Text>
      <dl className="potok-kv">
        <div>
          <dt>Основной долг к погашению</dt>
          <dd>{money(loan.balance)}</dd>
        </div>
        <div>
          <dt>Следующий платёж</dt>
          <dd>{loan.next_payment_amount && loan.next_payment_date ? `${money(loan.next_payment_amount)}, ${dayMonth(loan.next_payment_date)}` : '—'}</dd>
        </div>
        <div>
          <dt>Ставка</dt>
          <dd>{rate(loan.rate)}</dd>
        </div>
      </dl>
      <Progress loan={loan} />
      <span className="potok-loan-open">
        Открыть кредит и график <IconChevronRight size={16} aria-hidden="true" />
      </span>
    </Link>
  );
}

/** Ближайшие платежи по всем действующим кредитам — из графиков тех же кредитов (тот же запрос, что у страницы кредита). */
function UpcomingPayments({ loans }: { loans: Loan[] }) {
  const several = loans.length > 1;
  const details = useQueries({
    queries: loans.map((l) => ({ queryKey: ['loans', l.id], queryFn: () => api<LoanDetail>(`/loans/${l.id}`) })),
  });
  const rows = details
    .flatMap((q) => {
      const d = q.data;
      if (!d) return [];
      const from = d.next_payment_date ?? '';
      return d.schedule.filter((r) => r.date >= from).map((r) => ({ ...r, loan: d }));
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 4);
  if (!rows.length) return null;
  return (
    <section className="potok-panel">
      <Title order={3}>Ближайшие платежи</Title>
      <ul className="potok-rows">
        {rows.map((r) => (
          <li key={`${r.loan.id}-${r.n}`}>
            <Link to={`/loans/${r.loan.id}`} className="potok-row">
              <span className="potok-row-main">
                <span className="potok-row-title">{date(r.date)}</span>
                <span className="potok-row-sub">
                  {several && <>{nb(r.loan.product_name)}: </>}основной долг {money(r.principal)}, проценты {money(r.interest)}
                </span>
              </span>
              <span className="potok-row-side">{money(r.payment)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Пусто — с учётом заявок: одобренная ждёт ответа, договор ждёт подписи, заявка на рассмотрении. */
function NoLoans({ apps }: { apps: Application[] }) {
  const offer = apps.find((a) => ['approved', 'counter_offer'].includes(a.status.code));
  const signing = apps.find((a) => a.status.code === 'signing');
  const review = apps.find((a) => !a.status.terminal && a.status.code !== 'draft');
  if (offer) {
    return (
      <Empty
        art="folder"
        title="Кредитов пока нет"
        text={<>Банк ответил на заявку {nb(offer.number)}: примите предложение, и кредит появится здесь.</>}
        action={
          <Button component={Link} to={`/applications/${offer.id}`} size="lg">
            Открыть предложение
          </Button>
        }
      />
    );
  }
  if (signing) {
    return (
      <Empty
        art="folder"
        title="Кредитов пока нет"
        text={<>Договор по заявке {nb(signing.number)} ждёт подписи — после неё кредит появится здесь.</>}
        action={
          <Button component={Link} to={`/applications/${signing.id}`} size="lg">
            Подписать договор
          </Button>
        }
      />
    );
  }
  if (review) {
    return (
      <Empty
        art="folder"
        title="Кредит появится после решения банка"
        text={<>Заявка {nb(review.number)} на рассмотрении: статус обновляется сам.</>}
        action={
          <Button component={Link} to={`/applications/${review.id}`} size="lg" variant="default">
            Открыть заявку
          </Button>
        }
      />
    );
  }
  return (
    <Empty
      art="folder"
      title="Действующих кредитов нет"
      text="Когда банк выдаст кредит, он появится здесь вместе с графиком платежей."
      action={
        <Button component={Link} to="/match" size="lg">
          Подобрать кредит
        </Button>
      }
    />
  );
}

export function LoansPage() {
  const loans = useLoans();
  const apps = useApplications();
  const list = loans.data ?? [];
  const active = list.filter((l) => l.status === 'active');
  const debt = active.reduce((s, l) => s + l.balance, 0);
  const next = active
    .filter((l) => l.next_payment_date && l.next_payment_amount)
    .sort((a, b) => a.next_payment_date!.localeCompare(b.next_payment_date!))[0];
  return (
    <div className="potok-col">
      <div>
        <Title order={1}>Мои кредиты</Title>
        <Text c="dimmed" mt={4}>
          Кредиты компании, ближайшие платежи и графики погашения
        </Text>
      </div>
      <div className="potok-below">
        <div className="potok-col">
          {loans.isLoading ? (
            <Skeleton h={200} radius={24} />
          ) : loans.isError ? (
            <LoadError error={loans.error} what="кредиты" />
          ) : list.length ? (
            <>
              {list.map((loan) => (
                <LoanRow key={loan.id} loan={loan} />
              ))}
              <UpcomingPayments loans={active} />
            </>
          ) : (
            <section className="potok-panel">
              <NoLoans apps={apps.data ?? []} />
            </section>
          )}
        </div>
        <div className="potok-col">
          {next && (
            <section className="potok-panel potok-phone-first">
              <Title order={3}>Следующий платёж</Title>
              <div className="potok-side-amount">{moneyBig(next.next_payment_amount!)}</div>
              <div className="potok-muted-text">
                {date(next.next_payment_date!)}
                {active.length > 1 ? `, ${next.product_name}` : ''}
              </div>
              <Text fz="sm" c="dimmed" mt="md">
                Спишется с расчётного счёта автоматически — следить за датой не нужно.
              </Text>
            </section>
          )}
          {/* Сводка нужна, только когда кредитов несколько: при одном она повторила бы его карточку. */}
          {active.length > 1 && (
            <section className="potok-panel">
              <Title order={3}>Сводка</Title>
              <dl className="potok-pairs">
                <div>
                  <dt>Действующих кредитов</dt>
                  <dd>{active.length}</dd>
                </div>
                <div>
                  <dt>Основной долг к погашению</dt>
                  <dd>{money(debt)}</dd>
                </div>
              </dl>
            </section>
          )}
          {list.length > 0 && (
            <section className="potok-panel">
              <Title order={3}>Документы</Title>
              <ul className="potok-rows">
                {list.map((l) => (
                  <li key={l.id}>
                    <Link to={`/applications/${l.application_id}/contract`} className="potok-row">
                      <span className="potok-row-main">
                        <span className="potok-row-title">Договор {nb(l.contract_number)}</span>
                        <span className="potok-row-sub">с графиком платежей, подписан {date(l.issued_at)}</span>
                      </span>
                      <IconChevronRight size={18} className="potok-row-go" aria-hidden="true" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <MoreMoney />
          {!list.length && <MyCompany />}
        </div>
      </div>
    </div>
  );
}

/** График по выданному кредиту: на телефоне — дата, платёж и остаток, остальное раскрывается по строке. */
function LoanTable({ rows, current }: { rows: { n: number; date: string; payment: number; principal: number; interest: number; balance: number }[]; current?: number }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="potok-loan-table">
      <Table withRowBorders verticalSpacing={10} aria-label="График платежей">
        <Table.Thead>
          <Table.Tr>
            <Table.Th className="potok-hide-phone">№</Table.Th>
            <Table.Th>Дата</Table.Th>
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
          {rows.map((r, i) => (
            <Table.Tr key={r.n} data-current={i === current} data-open={open === r.n} onClick={() => setOpen((o) => (o === r.n ? null : r.n))}>
              <Table.Td className="potok-hide-phone">{r.n}</Table.Td>
              <Table.Td>
                <span className="potok-hide-phone">{date(r.date)}</span>
                <span className="potok-phone-only">{shortDate(r.date)}</span>
              </Table.Td>
              <Table.Td ta="right">
                {money(r.payment)}
                <span className="potok-row-more">
                  долг {money(r.principal)}, проценты {money(r.interest)}
                </span>
              </Table.Td>
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
        <Table.Tfoot>
          <Table.Tr className="potok-total">
            <Table.Td className="potok-hide-phone" />
            <Table.Td>Итого</Table.Td>
            <Table.Td ta="right">{money(rows.reduce((s, r) => s + r.payment, 0))}</Table.Td>
            <Table.Td ta="right" className="potok-hide-phone">
              {money(rows.reduce((s, r) => s + r.principal, 0))}
            </Table.Td>
            <Table.Td ta="right" className="potok-hide-phone">
              {money(rows.reduce((s, r) => s + r.interest, 0))}
            </Table.Td>
            <Table.Td />
          </Table.Tr>
        </Table.Tfoot>
      </Table>
    </div>
  );
}

export function LoanPage() {
  const { id } = useParams();
  const loan = useLoan(Number(id));
  const l = loan.data;
  const interestOnly = useInterestOnly(l?.product_code);

  if (loan.isLoading) return <Skeleton h={480} radius={24} />;
  if (loan.isError && !(loan.error instanceof ApiError && loan.error.status === 404)) {
    return (
      <LoadError
        error={loan.error}
        what="кредит"
        back={
          <Button component={Link} to="/loans" size="lg" variant="default">
            Мои кредиты
          </Button>
        }
      />
    );
  }
  if (!l) {
    return (
      <section className="potok-panel">
        <Empty
          art="folder"
          title="Кредит не найден"
          text="Возможно, ссылка устарела."
          action={
            <Button component={Link} to="/loans" size="lg" variant="default">
              Мои кредиты
            </Button>
          }
        />
      </section>
    );
  }

  const overpayment = l.total_payments - l.amount;
  const current = l.schedule.findIndex((r) => r.date === l.next_payment_date);
  const last = l.schedule[l.schedule.length - 1]?.date;
  return (
    <div className="potok-col">
      <div>
        <Anchor component={Link} to="/loans" fz="sm" c="dimmed" className="potok-back no-print">
          <IconArrowLeft size={16} /> Мои кредиты
        </Anchor>
        <div className="potok-loan-head">
          <div>
            <div className="potok-home-top" style={{ justifyContent: 'flex-start' }}>
              <Title order={1}>{nb(l.product_name)}</Title>
              <LoanStatus loan={l} />
            </div>
            <Text c="dimmed" mt={4} fz="sm">
              Договор {nb(l.contract_number)}, выдан {date(l.issued_at)}
            </Text>
          </div>
          <div className="potok-cta no-print on-canvas" style={{ marginTop: 0 }}>
            <Button component={Link} to={`/applications/${l.application_id}/contract`} variant="default" size="md">
              Договор
            </Button>
            <Button variant="default" size="md" onClick={() => window.print()}>
              Скачать график
            </Button>
          </div>
        </div>
      </div>

      <section className="potok-decision">
        <div className="potok-figures">
          <div>
            <div className="potok-fig-k">Сумма кредита</div>
            <div className="potok-big">{moneyBig(l.amount)}</div>
            <div className="potok-under">
              на {months(l.term_months)} под {rate(l.rate)} годовых
            </div>
          </div>
          <div>
            <div className="potok-fig-k">{interestOnly ? 'Проценты в месяц' : 'Платёж в месяц'}</div>
            <div className="potok-big">{moneyBig(l.monthly_payment)}</div>
            <div className="potok-under">{interestOnly ? 'основной долг — в конце срока' : `${l.term_months}${NBSP}платежей`}</div>
          </div>
        </div>
        <div className="potok-cost">
          <span>
            Переплата <b>{money(overpayment)}</b>
          </span>
          <span>
            Всего вернёте <b>{money(l.total_payments)}</b>
          </span>
        </div>

        {/* Один «следующий платёж» — дата и сумма вместе; остаток долга — только когда он уже меньше суммы кредита,
            иначе это та же цифра второй раз. */}
        <dl className="potok-next-pay">
          <div>
            <dt>Следующий платёж</dt>
            <dd>
              {l.next_payment_date && l.next_payment_amount ? `${dayMonth(l.next_payment_date)}, ${money(l.next_payment_amount)}` : 'платежей больше нет'}
            </dd>
          </div>
          {l.balance < l.amount && (
            <div>
              <dt>Остаток долга</dt>
              <dd>{money(l.balance)}</dd>
            </div>
          )}
        </dl>
        <div className="potok-inline-note">Платёж списывается с расчётного счёта автоматически — следить за датой не нужно.</div>
        <Progress loan={l} last={last} />

        <section className="potok-sched">
          <div className="potok-sched-head">
            <Title order={3}>График платежей</Title>
            <BarsLegend />
          </div>
          <PaymentBars rows={l.schedule} current={current >= 0 ? current : undefined} />
          <LoanTable rows={l.schedule} current={current >= 0 ? current : undefined} />
        </section>
      </section>
    </div>
  );
}
