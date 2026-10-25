import { expect, test } from '@playwright/test';

import { apply, login, money, PURPOSE } from './helpers';

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
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(PHONE.width);
  await page.setViewportSize({ width: 1366, height: 900 });

  await start.click();
  await expect(page).toHaveURL(/\/applications\/\d+\/edit$/);
  expect(page.url()).not.toContain(`/applications/${id}/`);
  await expect(page.getByRole('heading', { name: 'Проверьте данные компании' })).toBeVisible();
  await page.getByRole('button', { name: 'Далее' }).click();
  await expect(page.getByRole('heading', { name: 'Какой кредит нужен' })).toBeVisible();
  await expect(page.getByLabel('Сумма', { exact: true })).toHaveValue(/^4\s500\s000/);
  await expect(page.getByLabel('Срок', { exact: true })).toHaveValue('24');
  // Анкета заполнена из прежней заявки: выручку вводить заново не нужно.
  const next = page.getByRole('button', { name: 'Далее' });
  await next.click();
  await expect(page.getByRole('heading', { name: 'Финансы компании' })).toBeVisible();
  await expect(page.getByLabel('Выручка в месяц')).not.toHaveValue('');

  // Это не прогноз: новая заявка на выбранные условия одобряется ровно на них.
  const created = page.url().match(/applications\/(\d+)/)![1];
  await next.click();
  await expect(page.getByRole('heading', { name: 'Документы' })).toBeVisible();
  await next.click();
  await expect(page.getByRole('heading', { name: 'Всё верно?' })).toBeVisible();
  await page.getByLabel(/Согласен на запрос кредитной истории/).check();
  await page.getByRole('button', { name: 'Отправить в банк' }).click();
  await expect(page).toHaveURL(new RegExp(`/applications/${created}$`));
  await expect(page.getByRole('heading', { name: 'Банк готов выдать кредит' })).toBeVisible();
  await expect(page.getByTestId('offer-amount')).toContainText(money(4_500_000));
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
