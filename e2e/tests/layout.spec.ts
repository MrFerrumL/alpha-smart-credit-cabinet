import { expect, test, type Page } from '@playwright/test';

import { apply, login, PURPOSE, session, sign } from './helpers';

// На телефоне (390 px) нет горизонтальной прокрутки ни на одном экране клиента и аналитика.
const PHONE = { width: 390, height: 844 };

async function expectFits(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect.soft(width, `ширина документа на ${path}`).toBe(PHONE.width);
}

test('ширина 390: экраны клиента и аналитика без горизонтальной прокрутки', async ({ page, browser }) => {
  // Данные для экранов: выданный кредит пекарни и черновик заявки.
  await login(page, 'Ольга Северова');
  const id = await apply(page, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 1_000_000, term: 12 });
  await page.getByRole('button', { name: 'Принять предложение' }).click();
  await sign(page);
  await expect(page.getByRole('heading', { name: 'Деньги на счёте!' })).toBeVisible({ timeout: 60_000 });
  const loan = (await page.getByRole('link', { name: 'Кредит и график платежей' }).getAttribute('href'))!;
  await page.goto('/match');
  await page.getByText(PURPOSE.equipment, { exact: true }).click();
  await page.getByRole('button', { name: 'Оформить заявку' }).first().click();
  await expect(page).toHaveURL(/\/applications\/\d+\/edit$/);
  const draft = new URL(page.url()).pathname;

  await page.setViewportSize(PHONE);
  for (const path of ['/', '/match', '/applications', `/applications/${id}`, `/applications/${id}/contract`, draft, '/loans', loan]) {
    await expectFits(page, path);
  }

  const analyst = await session(browser, 'Мария Кредитова');
  await analyst.setViewportSize(PHONE);
  for (const path of ['/queue', '/policy', `/applications/${id}`]) {
    await expectFits(analyst, path);
  }

  const guest = await (await browser.newContext({ viewport: PHONE })).newPage();
  await expectFits(guest, '/login');
});
