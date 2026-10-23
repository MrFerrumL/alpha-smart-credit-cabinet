import { useProducts } from '../api/hooks';
import type { Application } from '../api/types';
import { money, moneyBig, months } from '../lib/format';
import { nb } from '../lib/nobreak';
import { shownTerms } from './ApplicationBlocks';
import { StatusBlock, StatusChip } from './Status';

/**
 * Заявка с её статусом: сумма, срок и платёж, затем общий компонент статуса с кнопкой следующего шага. Первый блок
 * главной и строка «в работе» в списке заявок.
 */
export function AppStatusCard({ app }: { app: Application }) {
  const products = useProducts();
  const terms = shownTerms(app, products.data);
  const offer = ['approved', 'counter_offer'].includes(app.status.code) ? app.offer : null;
  const offered = offer ? products.data?.find((p) => p.code === offer.product_code) : undefined;
  const amount = offer?.amount ?? terms.amount;
  const term = offer?.term_months ?? terms.term;
  const interestOnly = offer ? offered?.repayment === 'interest_only' : terms.interestOnly;
  // До решения платёж — оценка, после решения и в договоре — точный.
  const payment = offer ? money(offer.monthly_payment) : terms.payment;
  return (
    <section className="potok-panel potok-home-status" aria-label="Текущая заявка">
      <div className="potok-home-top">
        <span className="potok-muted-text">
          Заявка {nb(app.number)}, {nb(offered?.name ?? terms.product)}
        </span>
        <StatusChip app={app} />
      </div>
      <div className="potok-home-amount">{moneyBig(amount)}</div>
      {/* Срок и платёж — одной фразой; «месяцев» целиком, без сокращения «мес.,». */}
      <p className="potok-home-terms">
        на {months(term)}, {payment} {interestOnly ? 'процентов в месяц' : 'в месяц'}
      </p>
      <StatusBlock app={app} />
    </section>
  );
}
