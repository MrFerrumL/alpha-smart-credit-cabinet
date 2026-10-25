import { expect, test } from '@playwright/test';

import { apply, login, money, PURPOSE, session } from './helpers';

// Правки клиентского кабинета: кнопка карточки при подписании, диалог отзыва заявки, панель «Ваша заявка».

test('подписание: бухгалтеру карточка предлагает открыть заявку, красная «Подписать договор» — руководителю', async ({
  page,
  browser,
}) => {
  await login(page, 'Елена Счётова');
  const id = await apply(page, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 1_000_000, term: 12 });
  await expect(page.getByRole('heading', { name: 'Банк готов выдать кредит' })).toBeVisible();
  await page.getByRole('button', { name: 'Передать руководителю на подпись' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Предложение передано руководителю' })).toBeVisible();

  const director = await session(browser, 'Ольга Северова');
  await director.goto(`/applications/${id}`);
  await director.getByRole('button', { name: 'Принять предложение' }).click();
  await expect(director.getByRole('heading', { name: 'Договор готов к подписанию' })).toBeVisible();

  // Руководитель может подписать: на главной красная кнопка ведёт к договору.
  await director.goto('/');
  const sign = director.getByRole('region', { name: 'Текущая заявка' }).getByRole('link', { name: 'Подписать договор' });
  await expect(sign).toBeVisible();
  await expect(sign).toHaveAttribute('data-variant', 'filled');

  // Бухгалтер подписать не может: спокойная кнопка «Открыть заявку» и никакой «Подписать договор».
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Текущая заявка' });
  const open = card.getByRole('link', { name: 'Открыть заявку' });
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute('data-variant', 'default');
  await expect(card.getByRole('link', { name: 'Подписать договор' })).toHaveCount(0);
  await open.click();
  await expect(page).toHaveURL(new RegExp(`/applications/${id}$`));
  await expect(page.getByText('Подписать договор может только руководитель компании.')).toBeVisible();

  // Договор остаётся неподписанным — убираем заявку, чтобы не оставлять её в кабинете пекарни.
  await director.goto(`/applications/${id}`);
  await director.getByRole('button', { name: 'Отозвать заявку' }).click();
  await director.getByRole('dialog', { name: 'Отозвать заявку?' }).getByRole('button', { name: 'Отозвать', exact: true }).click();
  await expect(director.getByText('Заявка отозвана').first()).toBeVisible();
});

test('отзыв заявки с предложением: диалог называет сумму, которую клиент теряет', async ({ page }) => {
  await login(page, 'Ольга Северова');
  await apply(page, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 1_000_000, term: 12 });
  await expect(page.getByRole('heading', { name: 'Банк готов выдать кредит' })).toBeVisible();
  await expect(page.getByTestId('offer-amount')).toContainText(money(1_000_000));
  await page.getByRole('button', { name: 'Принять предложение' }).click();
  await expect(page.getByRole('heading', { name: 'Договор готов к подписанию' })).toBeVisible();

  await page.getByRole('button', { name: 'Отозвать заявку' }).click();
  const dialog = page.getByRole('dialog', { name: 'Отозвать заявку?' });
  await expect(dialog).toContainText(`Одобренное предложение банка — ${money(1_000_000)} на 12 мес.`);
  await expect(dialog).toContainText('понадобится новая заявка и новая проверка');
  await dialog.getByRole('button', { name: 'Не отзывать' }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Отозвать заявку' }).click();
  await dialog.getByRole('button', { name: 'Отозвать', exact: true }).click();
  await expect(page.getByText('Заявка отозвана').first()).toBeVisible();
});

test('отзыв черновика: диалог говорит об удалении', async ({ page }) => {
  await login(page, 'Ольга Северова');
  await page.goto('/match');
  await page.getByText(PURPOSE.equipment, { exact: true }).click();
  await page.getByRole('button', { name: 'Оформить заявку' }).first().click();
  await expect(page).toHaveURL(/\/applications\/\d+\/edit$/);
  const id = page.url().match(/applications\/(\d+)/)![1];

  await page.goto(`/applications/${id}`);
  await page.getByRole('button', { name: 'Удалить черновик' }).click();
  const dialog = page.getByRole('dialog', { name: 'Удалить черновик?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Оставить' }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Удалить черновик' }).click();
  await dialog.getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(page.getByText('Заявка отозвана').first()).toBeVisible();
});

test('проверка заявки: панель «Ваша заявка» показывает сумму, срок, платёж и залог', async ({ page }) => {
  await login(page, 'Игорь Волков');
  await apply(page, {
    purpose: PURPOSE.equipment,
    product: 'Инвестиционный кредит',
    amount: 25_000_000,
    term: 48,
    collateral: { kind: 'Оборудование', value: 30_000_000 },
  });
  await expect(page.getByText('Рассматривает специалист').first()).toBeVisible();

  const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Ваша заявка' }) });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(money(25_000_000));
  await expect(panel).toContainText('48 месяцев');
  await expect(panel).toContainText(/Платёж в месяц\s*≈\s*[\d\s]+₽/);
  await expect(panel).toContainText(`Оборудование, ${money(30_000_000)}`);

  // Заявка остаётся на рассмотрении у специалиста — отзываем, чтобы не копить очередь.
  await page.getByRole('button', { name: 'Отозвать заявку' }).click();
  await page.getByRole('dialog', { name: 'Отозвать заявку?' }).getByRole('button', { name: 'Отозвать', exact: true }).click();
  await expect(page.getByText('Заявка отозвана').first()).toBeVisible();
  await expect(panel).toBeHidden();
});
