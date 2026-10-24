import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { apply, login, money, PURPOSE } from '../helpers';

// Пояснение решения простыми словами на стенде с включённой функцией: LLM_ENABLED=true, модель — фейковая из
// эмулятора (LLM_BASE_URL=http://mocks:8001/llm/v1). Её сбои включаются так же, как сбои источников: /admin/faults.
const MOCKS_URL = process.env.E2E_MOCKS_URL ?? 'http://localhost:8001';
const PHONE = { width: 390, height: 844 };

async function llmFault(request: APIRequestContext, mode: 'contradict' | 'wrong_numbers' | 'timeout'): Promise<void> {
  const res = await request.post(`${MOCKS_URL}/admin/faults`, { data: { source: 'llm', mode } });
  expect(res.ok()).toBeTruthy();
}

/** Итог генерации: первый ответ ручки пояснения, в котором текст уже не готовится (ready или none). */
async function settled(page: Page, id: string): Promise<string> {
  const res = await page.waitForResponse(
    async (r) => r.url().endsWith(`/api/applications/${id}/explanation`) && r.ok() && (await r.json()).status !== 'pending',
    { timeout: 90_000 },
  );
  return (await res.json()).status;
}

test.afterEach(async ({ request }) => {
  await request.post(`${MOCKS_URL}/admin/faults`, { data: { source: 'all', mode: 'none' } });
});

test('одобрение: блок «Простыми словами» с пометкой, первое предложение — условия из карточки', async ({ page }) => {
  await login(page, 'Ольга Северова');
  await apply(page, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 3_000_000, term: 12 });
  await expect(page.getByRole('heading', { name: 'Банк готов выдать кредит' })).toBeVisible();

  const block = page.getByTestId('auto-explanation');
  await expect(block.getByRole('heading', { name: 'Простыми словами' })).toBeVisible();
  await expect(block.getByText(/^Сформировано автоматически языковой моделью по данным этого решения/)).toBeVisible();
  await expect(block.getByRole('list')).toHaveCount(0);
  // Пояснение дополняет шаблонные причины банка, а не заменяет их.
  await expect(page.getByRole('heading', { name: 'Почему одобрено' })).toBeVisible();

  // Первое предложение пишет код по предложению банка: те же сумма, срок, ставка и платёж, что в карточке.
  const digits = async (testId: string) => Number((await page.getByTestId(testId).innerText()).replace(/\D/g, ''));
  const amount = await digits('offer-amount');
  const payment = await digits('offer-payment');
  expect(amount).toBe(3_000_000);
  const [, term, rate] = (await page.getByTestId('offer-terms').innerText()).match(/на (\d+)\s\S+ под ([\d,]+)%/)!;
  const lead =
    `Банк одобрил «Экспресс-оборот» на запрошенных условиях: ${money(amount)} на ${term} мес. под ${rate}% ` +
    `годовых, платёж ${money(payment)} в месяц.`;
  const text = (await block.locator('p').first().innerText()).replace(/\s/g, ' ');
  expect(text.slice(0, lead.length)).toBe(lead);
  expect(text.length).toBeGreaterThan(lead.length);

  // На телефоне блок помещается по ширине, а главная кнопка остаётся закреплённой внизу экрана.
  await page.setViewportSize(PHONE);
  await block.scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(PHONE.width);
  await expect(page.getByRole('button', { name: 'Принять предложение' })).toBeInViewport();
});

test('сбой contradict: ответ противоречит решению — пояснения нет, причины банка на месте', async ({ page, request }) => {
  await llmFault(request, 'contradict');
  await login(page, 'Ольга Северова');
  const id = await apply(page, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 1_000_000, term: 12 });
  const final = settled(page, id);
  await expect(page.getByRole('heading', { name: 'Банк готов выдать кредит' })).toBeVisible();
  expect(await final).toBe('none');
  await expect(page.getByTestId('auto-explanation')).toHaveCount(0);
  await expect(page.getByTestId('auto-explanation-pending')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Почему одобрено' })).toBeVisible();
});

test('сбой wrong_numbers: в ответе чужое число — пояснения нет, причины и подсказки банка на месте', async ({ page, request }) => {
  await llmFault(request, 'wrong_numbers');
  await login(page, 'Павел Быстров');
  const id = await apply(page, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 2_000_000, term: 12 });
  const final = settled(page, id);
  await expect(page.getByRole('heading', { name: 'Почему банк отказал' })).toBeVisible();
  expect(await final).toBe('none');
  await expect(page.getByTestId('auto-explanation')).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Причины отказа' }).getByRole('listitem')).toHaveCount(3);
  await expect(page.getByRole('list', { name: 'Что можно сделать' }).getByRole('listitem').first()).toBeVisible();
});

test('сбой timeout: пока модель молчит, виден «Готовим…», а предложение принимается сразу', async ({ page, request }) => {
  await llmFault(request, 'timeout');
  await login(page, 'Ольга Северова');
  const id = await apply(page, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 1_000_000, term: 12 });
  await expect(page.getByRole('heading', { name: 'Банк готов выдать кредит' })).toBeVisible();
  // Эмулятор «висит» MOCK_TIMEOUT_SLEEP_S (10 с): всё это время генерация идёт, а строку заявки она не трогает.
  await expect(page.getByTestId('auto-explanation-pending')).toContainText('Готовим пояснение простыми словами…');
  await expect(page.getByTestId('auto-explanation')).toHaveCount(0);

  const accepted = page.waitForResponse((r) => r.url().endsWith(`/api/applications/${id}/offer/accept`));
  await page.getByRole('button', { name: 'Принять предложение' }).click();
  expect((await accepted).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Договор готов к подписанию' })).toBeVisible();
});
