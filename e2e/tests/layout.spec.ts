import { expect, test, type Page } from '@playwright/test';

import { apply, login, PURPOSE, session, sign } from './helpers';

// На телефоне (390 px) нет горизонтальной прокрутки ни на одном экране клиента и аналитика, в том числе на каждом шаге анкеты.
const PHONE = { width: 390, height: 844 };

// Шаги анкеты инвестиционного кредита (у него есть обеспечение, поэтому шагов шесть).
const WIZARD_STEPS = ['Компания', 'Кредит', 'Финансы', 'Обеспечение', 'Документы', 'Проверка'];

async function expectWidth(page: Page, where: string): Promise<void> {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect.soft(width, `ширина документа на ${where}`).toBe(PHONE.width);
}

async function expectFits(page: Page, path: string): Promise<void> {
  await page.goto(path);
  // Поток статусов держит соединение открытым, поэтому ждём не «тишины в сети», а заголовок страницы и данные.
  await page.locator('h1, h2').first().waitFor();
  await page.waitForTimeout(1000);
  await expectWidth(page, path);
}

/** Все шаги анкеты по кнопке «Далее». Черновик не отправляется: на последнем шаге кнопки «Далее» уже нет. */
async function expectWizardFits(page: Page, path: string): Promise<void> {
  await page.goto(path);
  const next = page.getByRole('button', { name: 'Далее' });
  for (const [i, step] of WIZARD_STEPS.entries()) {
    // Подпись шага: «Анкета: 3 из 6»; на телефоне после неё идёт название шага.
    await expect(page.getByText(new RegExp(`^Анкета: ${i + 1} из ${WIZARD_STEPS.length}`)).first()).toBeVisible();
    if (step === 'Финансы') {
      // Без выручки «Далее» не пустит дальше: её подставляет ФНС, ждём подстановку.
      await expect(page.getByLabel('Выручка в месяц')).not.toHaveValue('');
    }
    if (step === 'Обеспечение') {
      // Залог обязателен — вводим, как при подаче заявки (helpers.apply).
      await page.getByRole('textbox', { name: 'Что предлагаете в залог' }).click();
      await page.getByRole('option', { name: 'Оборудование' }).click();
      await page.getByLabel('Примерная стоимость').fill('3000000');
    }
    // Шаг дорисовывается после ответов сервера — даём ему секунду, как и страницам выше.
    await page.waitForTimeout(1000);
    await expectWidth(page, `шаге «${step}» анкеты`);
    if (i < WIZARD_STEPS.length - 1) await next.click();
  }
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
  for (const path of ['/', '/match', '/applications', `/applications/${id}`, `/applications/${id}/contract`, draft, '/loans', loan, '/profile']) {
    await expectFits(page, path);
  }
  // Анкета целиком: шесть шагов подряд (первый шаг проверяется и выше, как страница черновика).
  await expectWizardFits(page, draft);

  const analyst = await session(browser, 'Мария Кредитова');
  await analyst.setViewportSize(PHONE);
  for (const path of ['/queue', '/policy', `/applications/${id}`, '/profile']) {
    await expectFits(analyst, path);
  }

  const guest = await (await browser.newContext({ viewport: PHONE })).newPage();
  await expectFits(guest, '/login');
});
