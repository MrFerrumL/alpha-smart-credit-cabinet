import { expect, test, type APIRequestContext } from '@playwright/test';

import { login } from './helpers';

async function scoredApplication(request: APIRequestContext) {
  const customer = await request.post('/api/auth/login', { data: { email: 'bakery@demo.local', password: 'demo1234' } });
  expect(customer.ok()).toBeTruthy();
  const token = (await customer.json()).access_token;
  const headers = { Authorization: `Bearer ${token}` };
  const response = await request.post('/api/applications', {
    headers, data: { product_code: 'express', purpose: 'working_capital', amount: 500000, term_months: 12,
      form: { finance: { monthly_revenue: 4000000 }, consent_bki: true } },
  });
  expect(response.status()).toBe(201);
  const id = (await response.json()).id;
  expect((await request.post(`/api/applications/${id}/submit`, { headers })).ok()).toBeTruthy();
  await expect.poll(async () => (await (await request.get(`/api/applications/${id}`, { headers })).json()).status.code,
    { timeout: 45000 }).toBe('approved');
  return id as number;
}

test('аналитик видит реальный прогноз из снимка и раскрывает объяснение', async ({ page, request }) => {
  const id = await scoredApplication(request);
  await login(page, 'Мария Кредитова');
  await page.goto(`/applications/${id}`);
  const panel = page.getByRole('region', { name: 'Учебная ML-оценка' });
  await expect(panel.getByTestId('ml-probability')).toHaveText(/\d+[,.]\d\s?%/);
  await expect(panel).toContainText('не влияет на решение');
  await panel.locator('summary').click();
  await expect(panel.getByRole('table', { name: 'Вклады ML-признаков' })).toBeVisible();
  await expect(panel).toContainText('synthetic-risk-logreg-v2');
  await expect(panel).toContainText('SHA-256:');
  await panel.screenshot({ path: test.info().outputPath('ml-risk-panel.png') });
});

test('аналитик видит отсутствие данных, без выдуманной вероятности', async ({ page, request }) => {
  const id = await scoredApplication(request);
  await login(page, 'Мария Кредитова');
  await page.route(`**/api/applications/${id}/ml-risk`, route => route.fulfill({ json: {
    application_id: id, status: 'unavailable', unavailable_fields: ['margin'], prediction: null,
  } }));
  await page.goto(`/applications/${id}`);
  const panel = page.getByRole('region', { name: 'Учебная ML-оценка' });
  await expect(panel).toContainText('Недостаточно корректных данных: Рентабельность');
  await expect(panel.getByTestId('ml-probability')).toHaveCount(0);
});

test('сбой ML не скрывает основную карточку и доступен повтор расчёта', async ({ page, request }) => {
  const id = await scoredApplication(request);
  await login(page, 'Мария Кредитова');
  await page.route(`**/api/applications/${id}/ml-risk`, route => route.fulfill({ status: 503, json: {
    status: 503, code: 'model_unavailable', title: 'Модель недоступна', detail: 'Модель недоступна',
  } }));
  await page.goto(`/applications/${id}`);
  const panel = page.getByRole('region', { name: 'Учебная ML-оценка' });
  await expect(panel).toContainText('Модель временно недоступна');
  await expect(panel.getByRole('button', { name: 'Повторить расчёт' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Сводка' })).toBeVisible();
  await page.unroute(`**/api/applications/${id}/ml-risk`);
  await panel.getByRole('button', { name: 'Повторить расчёт' }).click();
  await expect(panel.getByTestId('ml-probability')).toBeVisible();
});

test('клиент не получает ML-панель аналитика', async ({ page, request }) => {
  const id = await scoredApplication(request);
  await login(page, 'Ольга Северова');
  await page.goto(`/applications/${id}`);
  await expect(page.getByRole('heading', { name: 'Банк готов выдать кредит' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Учебная ML-оценка' })).toHaveCount(0);
});
