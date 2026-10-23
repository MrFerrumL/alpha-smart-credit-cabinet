import { IconChevronRight } from '@tabler/icons-react';
import { Link } from 'react-router';

import { useProducts } from '../api/hooks';
import type { Application } from '../api/types';
import { money, monthsShort } from '../lib/format';
import { shownTerms } from './ApplicationBlocks';
import { StatusChip } from './Status';

/** Заявка одной строкой: продукт и сумма слева, статус справа, вся строка — ссылка. */
export function AppRow({ app }: { app: Application }) {
  const products = useProducts();
  const terms = shownTerms(app, products.data);
  const to = app.status.code === 'draft' ? `/applications/${app.id}/edit` : `/applications/${app.id}`;
  return (
    <li>
      <Link to={to} className="potok-row">
        <span className="potok-row-main">
          <span className="potok-row-title">{terms.product}</span>
          <span className="potok-row-sub num">
            Заявка {app.number}, {money(terms.amount)} на {monthsShort(terms.term)}
          </span>
        </span>
        <StatusChip app={app} />
        <IconChevronRight size={18} className="potok-row-go" aria-hidden="true" />
      </Link>
    </li>
  );
}
