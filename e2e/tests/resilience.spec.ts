import { expect, test } from '@playwright/test';

import { apply, login, PURPOSE } from './helpers';

const MOCKS_URL = process.env.E2E_MOCKS_URL ?? 'http://localhost:8001';

test.afterEach(async ({ request }) => {
  await request.post(`${MOCKS_URL}/admin/faults`, { data: { source: 'all', mode: 'none' } });
});

// README, «Проверка за 10 минут», шаг 5: БКИ трижды не отвечает — конвейер повторяет запрос и доходит до решения.
test('сбой БКИ: повтор запроса виден в истории, решение принимается', async ({ page, request }) => {
  const fault = await request.post(`${MOCKS_URL}/admin/faults`, { data: { source: 'bki', mode: 'error', count: 3 } });
  expect(fault.ok()).toBeTruthy();
  await login(page, 'Ольга Северова');
  await apply(page, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 1_000_000, term: 12 });
  await expect(page.getByText('Бюро кредитных историй не ответил — повторяем запрос').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Банк готов выдать кредит' })).toBeVisible();
});
