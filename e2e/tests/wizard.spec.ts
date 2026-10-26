import { expect, test } from '@playwright/test';

import { login, money, PURPOSE, startDraft } from './helpers';

// Анкета не теряет введённое и объясняет себя: черновик сохраняется сам, анкета открывается там, где клиент
// остановился, ошибки показываются у поля, а проверки банка видны до отправки.

test('черновик: введённое сохраняется без «Далее», ошибки — у поля с фокусом', async ({ page }) => {
  // У ИП Смирновой в налоговой нет выручки — её вводят руками.
  await login(page, 'Анна Смирнова');
  const id = await startDraft(page, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 500_000, term: 12 });
  const next = page.getByRole('button', { name: 'Далее' });
  await next.click();
  await expect(page.getByRole('heading', { name: 'Какой кредит нужен' })).toBeVisible();
  await next.click();
  // После смены шага фокус — на заголовке шага: экранный диктор прочитает, где клиент оказался.
  const finance = page.getByRole('heading', { name: 'Финансы компании' });
  await expect(finance).toBeFocused();

  // Без выручки «Далее» не пускает: ошибка у поля, фокус — в нём.
  const revenue = page.getByLabel('Выручка в месяц');
  await next.click();
  await expect(page.getByText('Без выручки банк не сможет оценить заявку')).toBeVisible();
  await expect(revenue).toBeFocused();

  // Автосохранение: через секунду после правки, статус честный — сначала «Сохраняем…», потом «Черновик сохранён».
  const status = page.getByTestId('draft-status');
  await revenue.fill('600000');
  await expect(status).toContainText('Сохраняем…');
  await expect(status).toContainText('Черновик сохранён');

  // Расходы — и сразу «К заявке», не дожидаясь автосохранения и не нажимая «Далее».
  await page.getByLabel('Расходы в месяц').fill('450000');
  await page.getByRole('link', { name: 'К заявке' }).click();
  await expect(page).toHaveURL(new RegExp(`/applications/${id}$`));

  // Снова в анкету: всё обязательное заполнено — она открывается на проверке, выручка на месте.
  await page.goto(`/applications/${id}/edit`);
  await expect(page.getByRole('heading', { name: 'Всё верно?' })).toBeVisible();
  const financeReview = page.getByRole('region', { name: 'Финансы', exact: true });
  await expect(financeReview).toContainText(money(600_000));

  // «Отправить в банк» без согласия: ошибка у галочки, фокус на ней, заявка остаётся черновиком.
  await page.getByRole('button', { name: 'Отправить в банк' }).click();
  await expect(page.getByText('Без согласия банк не сможет проверить кредитную историю')).toBeVisible();
  await expect(page.getByLabel(/Согласен на запрос кредитной истории/)).toBeFocused();
  await expect(page).toHaveURL(/\/applications\/\d+\/edit$/);

  // Расходы, введённые перед уходом, тоже сохранились.
  await financeReview.getByRole('button', { name: 'Изменить' }).click();
  await expect(finance).toBeFocused();
  await expect(revenue).toHaveValue(/^600\s000$/);
  await expect(page.getByLabel('Расходы в месяц')).toHaveValue(/^450\s000$/);
});

test('sklad: на шаге «Финансы» видны проверки банка — сумма больше лимита по выручке', async ({ page }) => {
  await login(page, 'Дмитрий Орлов');
  await startDraft(page, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 10_000_000, term: 12 });
  const next = page.getByRole('button', { name: 'Далее' });
  await next.click();
  await expect(page.getByRole('heading', { name: 'Какой кредит нужен' })).toBeVisible();
  await next.click();
  await expect(page.getByRole('heading', { name: 'Финансы компании' })).toBeVisible();
  // Выручку и расходы подставляет ФНС: 3 млн и 2,58 млн в месяц.
  await expect(page.getByLabel('Выручка в месяц')).not.toHaveValue('');

  const checks = page.getByRole('region', { name: 'Что проверит банк' });
  await expect(checks).toContainText('в пределах лимита 50%');
  await expect(checks).toContainText(`По продукту банк даёт до 1,5 месячной выручки — до ${money(4_500_000)}`);
  await expect(checks).toContainText(`Вы просите ${money(10_000_000)} — больше лимита`);
  await expect(checks).toContainText('Прибыль покрывает платёж в 0,44 раза, банку нужно от 1,2');
  await expect(checks).toContainText('Скорее всего, банк предложит другие условия');
});
