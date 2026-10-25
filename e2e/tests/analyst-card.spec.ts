import { expect, test } from '@playwright/test';

import { analystDecides, apply, login, money, PURPOSE, session } from './helpers';

// Карточка аналитика: сводка сверху (почему у вас, рекомендация, расхождения), запросы и документы клиента,
// предпросмотр «Клиент увидит» под формой решения и итог решения вместо формы.

test('vector: сводка, предпросмотр для клиента и итог решения аналитика', async ({ page, browser }) => {
  await login(page, 'Игорь Волков');
  const id = await apply(page, {
    purpose: PURPOSE.equipment,
    product: 'Инвестиционный кредит',
    amount: 25_000_000,
    term: 48,
    collateral: { kind: 'Оборудование', value: 30_000_000 },
  });
  await expect(page.getByText('Рассматривает специалист').first()).toBeVisible();

  const analyst = await session(browser, 'Мария Кредитова');
  await analyst.goto(`/applications/${id}`);
  const summary = analyst.getByRole('region', { name: 'Сводка' });
  await expect(summary).toContainText('Почему у вас: по этому продукту решение всегда принимает специалист');
  await expect(summary).toContainText(`Конвейер рекомендует: контрпредложение ${money(19_500_000)} на 60 мес. под 23,5%`);
  await expect(summary).toContainText('на запрошенных условиях покрытие ×0,82 при минимуме ×1,2');
  // Платежи по кредитам в анкете не указаны, а в БКИ они есть.
  await expect(summary).toContainText('Платежи по кредитам не указаны, а в БКИ');

  // Пока решение не принято, правила раскрыты, непройденное выделено.
  await expect(analyst.getByRole('button', { name: 'Скрыть правила' })).toBeVisible();
  await expect(analyst.locator('li[data-result="fail"]').filter({ hasText: 'Покрытие платежа прибылью' })).toBeVisible();

  // Предпросмотр и сообщение клиенту следуют за суммой в форме.
  const form = analyst.locator('#decision');
  await expect(form.getByRole('radio', { name: 'Контрпредложение' })).toBeChecked();
  await form.getByLabel('Сумма', { exact: true }).fill('18000000');
  const preview = analyst.getByRole('region', { name: 'Клиент увидит' });
  await expect(preview).toContainText('Банк готов выдать на других условиях');
  await expect(preview).toContainText(money(18_000_000));
  await expect(preview).toContainText('на 60 месяцев под 23,5% годовых');
  await expect(preview).toContainText('Предложение действует 7 дней');
  await expect(preview).toContainText('После принятия: документы по залогу и поручительство собственника');
  await expect(form.getByLabel('Сообщение клиенту')).toHaveValue(/^Сумма уменьшена до 18\sмлн\s₽, чтобы прибыль покрывала платёж с запасом\./);
  await expect(preview).toContainText('Срок увеличен до 60 мес.');

  await form.getByLabel('Обоснование для журнала аудита').fill('Сумма ниже рекомендации: залог оценён консервативно');
  await form.getByRole('button', { name: 'Сохранить решение' }).click();
  await expect(analyst.getByRole('heading', { name: 'Решение по заявке' })).toBeHidden();

  // Вместо формы — что предложено, в каком состоянии предложение и кто решил; в условиях — колонка «Предложено».
  const decided = analyst.getByRole('region', { name: 'Решение', exact: true });
  await expect(decided).toContainText(`Предложено: ${money(18_000_000)} на 60 месяцев под 23,5%`);
  await expect(decided).toContainText('Ждём ответа клиента до');
  await expect(decided).toContainText('Решение: Мария Кредитова');
  await expect(analyst.getByRole('columnheader', { name: 'Предложено', exact: true })).toBeVisible();
  await expect(analyst.getByRole('region', { name: 'Сводка' })).toContainText('Конвейер рекомендовал:');

  // Клиент видит то, что было в предпросмотре.
  await expect(page.getByRole('heading', { name: 'Банк готов выдать на других условиях' })).toBeVisible();
  await expect(page.getByTestId('offer-amount')).toContainText(money(18_000_000));
  await expect(page.getByText(/Сумма уменьшена до 18/).first()).toBeVisible();
});

test('smirnova: аналитик видит запрос банка, ответ клиента и выписку, после решения — кто решил', async ({ page, browser }) => {
  await login(page, 'Анна Смирнова');
  const id = await apply(page, {
    purpose: PURPOSE.workingCapital,
    product: 'Экспресс-оборот',
    amount: 500_000,
    term: 12,
    revenue: 600_000,
  });
  await expect(page.getByRole('heading', { name: 'Банк просит уточнить' })).toBeVisible();

  // Пока клиент не ответил, запрос у аналитика — «Ждём ответа».
  const analyst = await session(browser, 'Мария Кредитова');
  await analyst.goto(`/applications/${id}`);
  const requests = analyst.getByRole('region', { name: 'Запросы и документы' }).getByRole('list', { name: 'Запросы клиенту' });
  const statement = requests.getByRole('listitem').filter({ hasText: 'Загрузите выписку по расчётному счёту' });
  await expect(statement).toContainText('Ждём ответа');

  await page.goto(`/applications/${id}`);
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'vypiska-6m.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% Выписка по счёту за полгода\n%%EOF\n'),
  });
  await expect(page.getByRole('heading', { name: 'Почему заявку смотрит специалист' })).toBeVisible();

  await analyst.goto(`/applications/${id}`);
  await expect(analyst.getByRole('heading', { name: 'Решение по заявке' })).toBeVisible();
  await expect(analyst.getByRole('region', { name: 'Сводка' })).toContainText('Почему у вас: выручка подтверждена только выпиской');
  await expect(statement).toContainText('Выполнено');
  await expect(statement).toContainText('Приложен файл: vypiska-6m.pdf');
  const documents = analyst.getByRole('region', { name: 'Запросы и документы' }).getByRole('list', { name: 'Документы' });
  const file = documents.getByRole('listitem').filter({ hasText: 'vypiska-6m.pdf' });
  await expect(file).toContainText('Выписка по расчётному счёту');
  await expect(file).toContainText('КБ');

  await analystDecides(analyst, id);
  const decided = analyst.getByRole('region', { name: 'Решение', exact: true });
  await expect(decided).toContainText(`Предложено: ${money(500_000)} на 12 месяцев`);
  await expect(decided).toContainText('Решение: Мария Кредитова');
  await expect(page.getByRole('heading', { name: 'Банк готов выдать кредит' })).toBeVisible();
});
