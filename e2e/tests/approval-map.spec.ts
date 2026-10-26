import { expect, test } from '@playwright/test';

import { apply, declineOffer, login, money, PURPOSE } from './helpers';

// Граница одобрения по сроку: под решением банка клиент видит, сколько банк одобрит по тому же продукту на каждом
// сроке — по тем же правилам, что и решение, — и может сразу оформить новую заявку на выбранных условиях.

const PANEL = 'Сколько банк одобрит на другом сроке';
const PHONE = { width: 390, height: 844 };

test('sklad: сколько банк одобрит на другом сроке — выбранная строка открывает анкету с этими условиями', async ({ page }) => {
  await login(page, 'Дмитрий Орлов');
  const id = await apply(page, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 10_000_000, term: 12 });
  await expect(page.getByRole('heading', { name: 'Банк готов выдать на других условиях' })).toBeVisible();

  const panel = page.getByRole('region', { name: PANEL });
  const terms = panel.getByRole('radiogroup', { name: 'Сколько банк одобрит на каждом сроке' });
  const row = (term: number) => terms.getByRole('radio', { name: new RegExp(`^${term}\\sмес\\.`) });
  // Стандартные сроки продукта и срок предложения банка (16 мес.); все проходят — на каждом своя граница суммы.
  // Срок предложения виден, но не выбирается: эти условия уже в решении выше.
  await expect(terms.getByRole('radio')).toHaveCount(4);
  await expect(row(12)).toContainText(`до ${money(3_650_000)}`);
  await expect(row(12)).toContainText('343 000 ₽ в месяц');
  await expect(row(12)).toContainText('вы просили');
  const current = terms.locator('.potok-amap-current');
  await expect(current).toContainText(`до ${money(4_500_000)}`);
  await expect(current).toContainText('предложение банка');
  await expect(current).toContainText('Эти условия — в предложении выше');
  await expect(row(6)).toContainText(`до ${money(1_950_000)}`);

  // Пока срок не выбран, оформлять нечего; главная кнопка экрана — по-прежнему «Принять предложение».
  const start = panel.getByRole('button', { name: 'Оформить на этих условиях' });
  await expect(start).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Принять предложение' })).toBeVisible();

  await row(24).click();
  await expect(row(24)).toHaveAttribute('aria-checked', 'true');
  await expect(row(12)).toHaveAttribute('aria-checked', 'false');
  await expect(panel.getByText(`Новая заявка: ${money(4_500_000)} на 24 месяца`)).toBeVisible();

  // На телефоне панель помещается в ширину экрана.
  await page.setViewportSize(PHONE);
  await expect(panel).toBeVisible();
  // Уведомление о решении выезжает с правого края и на время анимации расширяет документ — ждём, пока оно встанет.
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth), { timeout: 10_000 }).toBe(PHONE.width);
  await page.setViewportSize({ width: 1366, height: 900 });

  await start.click();
  await expect(page).toHaveURL(/\/applications\/\d+\/edit$/);
  expect(page.url()).not.toContain(`/applications/${id}/`);
  // Анкета перенесена из прежней заявки целиком, поэтому открывается сразу проверка перед отправкой:
  // условия — выбранные на карте, выручку вводить заново не нужно.
  await expect(page.getByRole('heading', { name: 'Всё верно?' })).toBeVisible();
  const loan = page.getByRole('region', { name: 'Кредит', exact: true });
  await expect(loan).toContainText(money(4_500_000));
  await expect(loan).toContainText(/24\sмесяца/);
  await expect(page.getByRole('region', { name: 'Финансы', exact: true })).toContainText('Выручка в месяц');

  // Это не прогноз: новая заявка на выбранные условия одобряется ровно на них.
  const created = page.url().match(/applications\/(\d+)/)![1];
  await page.getByLabel(/Согласен на запрос кредитной истории/).check();
  await page.getByRole('button', { name: 'Отправить в банк' }).click();
  await expect(page).toHaveURL(new RegExp(`/applications/${created}$`));
  await expect(page.getByRole('heading', { name: 'Банк готов выдать кредит' })).toBeVisible();
  await expect(page.getByTestId('offer-amount')).toContainText(money(4_500_000));

  // Обе заявки сценариям дальше не нужны: клиент отказывается от обоих предложений.
  await declineOffer(page);
  await page.goto(`/applications/${id}`);
  await declineOffer(page);
});

test('clean: продукт не проходит ни на одном сроке — одна строка почему, без выбора', async ({ page }) => {
  await login(page, 'Лариса Тихонова');
  await apply(page, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 300_000, term: 12 });
  await expect(page.getByRole('heading', { name: 'Вместо кредита «Экспресс-оборот» банк предлагает «Овердрафт»' })).toBeVisible();

  const panel = page.getByRole('region', { name: PANEL });
  await expect(panel).toContainText('«Экспресс-оборот» не пройдёт ни на одном сроке');
  await expect(panel).toContainText(`Даже ${money(300_000)} на 24 месяца банк не одобрит`);
  await expect(panel).toContainText('Поэтому банк предлагает «Овердрафт»');
  await expect(panel.getByRole('radio')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Оформить на этих условиях' })).toHaveCount(0);
});
