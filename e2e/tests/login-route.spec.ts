import { expect, test, type Page } from '@playwright/test';

import { fast } from './helpers';

// Маршрут проверки на странице входа — шаги README «Проверка за 10 минут». Имя в шаге подставляет почту и пароль, как
// выбор профиля в списке «Почта»; входит пользователь сам, кнопкой «Войти».

const route = (page: Page) => page.getByRole('region', { name: 'Как проверить за 10 минут' });

test('маршрут проверки: шесть шагов, имя подставляет учётку, вход — кнопкой «Войти»', async ({ page }) => {
  await page.goto('/login');
  await expect(route(page)).toBeVisible();
  const steps = route(page).getByRole('listitem');
  await expect(steps).toHaveCount(6);
  await expect(route(page)).toContainText('у каждой вкладки свой вход');

  await fast.click(steps.nth(1).getByRole('button', { name: 'Выбрать профиль Дмитрий Орлов' }));
  await expect(page.getByRole('combobox', { name: 'Почта' })).toHaveValue('sklad@demo.local');
  await expect(page.getByLabel('Пароль', { exact: true })).toHaveValue('demo1234');
  // Выбор профиля сам не входит: пока не нажата «Войти», страница входа на месте.
  await expect(page).toHaveURL(/\/login$/);

  await fast.click(page.getByRole('button', { name: 'Войти', exact: true }));
  await expect(page).not.toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Профиль: Дмитрий Орлов' })).toBeVisible();
});

test('маршрут проверки на телефоне: под формой, без горизонтальной прокрутки', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await page.goto('/login');
  await expect(route(page)).toBeVisible();
  const button = await page.getByRole('button', { name: 'Войти', exact: true }).boundingBox();
  const block = await route(page).boundingBox();
  expect(block!.y).toBeGreaterThan(button!.y + button!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
