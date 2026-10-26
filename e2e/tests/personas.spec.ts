import { expect, test } from '@playwright/test';

import { analystDecides, apply, expectIssued, feedTitles, login, PURPOSE, session, sign } from './helpers';

// Демо-сценарии из README, раздел «Демо-сценарии»: те же учётки, те же данные, те же исходы.

test('bakery: автоматическое одобрение, подпись кодом, выдача и график', async ({ page }) => {
  await login(page, 'Ольга Северова');
  const id = await apply(page, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 3_000_000, term: 12 });

  await expect(page.getByRole('heading', { name: 'Банк готов выдать кредит' })).toBeVisible();
  await expect(page.getByTestId('offer-terms')).toContainText('22,9%');
  for (const stage of ['Заявка отправлена', 'Проверка компании', 'Оценка', 'Решение']) {
    await expect(page.getByText(stage).first()).toBeVisible();
  }
  await page.getByRole('button', { name: 'Принять предложение' }).click();
  await page.getByRole('link', { name: 'Открыть договор и график платежей' }).click();
  await expect(page.getByRole('heading', { name: /Кредитный договор №/ })).toBeVisible();
  await expect(page.getByText('Ждёт подписи')).toBeVisible();
  await expect(page.locator('table tbody tr')).toHaveCount(12);
  await page.goto(`/applications/${id}`);
  await sign(page);
  await expectIssued(page, '3 000 000 ₽', 12);
});

test('buh: бухгалтер готовит заявку и передаёт её руководителю, тот подписывает', async ({ page, browser }) => {
  await login(page, 'Елена Счётова');
  await expect(page.getByText('Подписать договор сможет только руководитель компании.')).toBeVisible();
  const id = await apply(page, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 3_000_000, term: 12 });
  await expect(page.getByRole('heading', { name: 'Банк готов выдать кредит' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Принять предложение' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Отказаться' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Передать руководителю на подпись' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Предложение передано руководителю' })).toBeVisible();

  const director = await session(browser, 'Ольга Северова');
  await director.getByRole('button', { name: 'Уведомления' }).click();
  await expect(director.getByText(/Елена Счётова просит подписать кредит по заявке/).first()).toBeVisible();
  await director.goto(`/applications/${id}`);
  await director.getByRole('button', { name: 'Принять предложение' }).click();
  await sign(director);
  await expectIssued(director, '3 000 000 ₽', 12);
});

test('sklad: контрпредложение — сумма ограничена выручкой, срок длиннее', async ({ page }) => {
  await login(page, 'Дмитрий Орлов');
  await apply(page, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 10_000_000, term: 12 });
  await expect(page.getByRole('heading', { name: 'Банк готов выдать на других условиях' })).toBeVisible();
  const compare = page.getByRole('table', { name: 'Сравнение с заявкой' });
  await expect(compare.getByRole('row', { name: /Сумма/ })).toContainText('10 000 000 ₽');
  await expect(compare.getByRole('row', { name: /Сумма/ })).toContainText('4 500 000 ₽');
  await expect(compare.getByRole('row', { name: /Срок/ })).toContainText('16 месяцев');
  await expect(compare.getByRole('row', { name: /Ставка/ })).toContainText('22,9%');
});

test('clean: контрпредложение другим продуктом — овердрафт, выдача по нему', async ({ page }) => {
  await login(page, 'Лариса Тихонова');
  await apply(page, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 300_000, term: 12 });
  await expect(page.getByRole('heading', { name: 'Вместо кредита «Экспресс-оборот» банк предлагает «Овердрафт»' })).toBeVisible();
  const compare = page.getByRole('table', { name: 'Сравнение с заявкой' });
  await expect(compare.getByRole('row', { name: /Продукт/ })).toContainText('Экспресс-оборот');
  await expect(compare.getByRole('row', { name: /Продукт/ })).toContainText('Овердрафт');
  await expect(compare.getByRole('row', { name: /Сумма/ })).toContainText('150 000 ₽');
  await expect(compare.getByRole('row', { name: /Срок/ })).toContainText('12 месяцев');
  await expect(compare.getByRole('row', { name: /Ставка/ })).toContainText('26,9%');
  // У овердрафта в месяц платятся только проценты, а лимит возвращается в конце срока.
  await expect(compare.getByRole('row', { name: /Платёж в месяц/ })).toContainText('только проценты');
  await expect(page.getByText(/возвращается в конце срока/)).toBeVisible();
  await expect(page.getByText(/подходит «Овердрафт»/)).toBeVisible();
  await page.getByRole('button', { name: 'Принять предложение' }).click();
  await sign(page);
  await expect(page.getByRole('heading', { name: 'Лимит открыт!' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Лимит овердрафта .* открыт/)).toBeVisible();
  await expect(page.getByText('Лимит открыт', { exact: true }).first()).toBeVisible();
  // После выдачи заявка показывает условия кредита, а не то, что просили.
  const terms = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Условия кредита' }) });
  await expect(terms).toContainText('Овердрафт');
  await expect(terms).toContainText('150 000 ₽');
  await expect(terms).toContainText('Вы просили: Экспресс-оборот, 300 000 ₽ на 12 месяцев');
  await page.getByRole('link', { name: 'Кредит и график платежей' }).click();
  await expect(page.getByRole('heading', { name: 'Овердрафт' })).toBeVisible();
  await expect(page.getByText('Сумма кредита').locator('..')).toContainText('150 000 ₽');
  await expect(page.getByText('Проценты в месяц').locator('..')).toContainText('3 363 ₽');
  await expect(page.locator('table tbody tr')).toHaveCount(12);
  // Карточка в «Мои заявки» тоже показывает выданные условия.
  await page.goto('/applications');
  await page.getByRole('button', { name: /^Закрытые/ }).click();
  const card = page.getByRole('link').filter({ hasText: 'Овердрафт' }).first();
  await expect(card).toContainText('150 000 ₽ на 12 мес.');
});

test('smirnova: банк просит выписку, специалист сверяет и одобряет', async ({ page, browser }) => {
  await login(page, 'Анна Смирнова');
  const id = await apply(page, {
    purpose: PURPOSE.workingCapital,
    product: 'Экспресс-оборот',
    amount: 500_000,
    term: 12,
    revenue: 600_000,
  });
  await expect(page.getByRole('heading', { name: 'Банк просит уточнить' })).toBeVisible();
  // Лента реагирует на этап заявки: среди трёх новостей на главной — новость о дополнительных документах
  // (подробно — в feed.spec.ts).
  const titles = await feedTitles(page, false);
  expect(titles.some((t) => t.includes('банк запросил дополнительные документы'))).toBe(true);

  await page.goto(`/applications/${id}`);
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'vypiska.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% Выписка по счёту за полгода\n%%EOF\n'),
  });
  await expect(page.getByRole('heading', { name: 'Почему заявку смотрит специалист' })).toBeVisible();
  await expect(page.getByText(/выпиской/).first()).toBeVisible();

  const analyst = await session(browser, 'Мария Кредитова');
  await expect(analyst.getByRole('heading', { name: 'Очередь заявок' })).toBeVisible();
  await expect(analyst.getByRole('row', { name: /ИП Смирнова/ }).first()).toBeVisible();
  await analystDecides(analyst, id);

  await expect(page.getByRole('heading', { name: 'Банк готов выдать кредит' })).toBeVisible();
  await expect(page.getByTestId('offer-amount')).toContainText('500 000 ₽');
  await expect(page.getByTestId('offer-terms')).toContainText('22,9%');
});

test('vector: ручное рассмотрение, контрпредложение аналитика, условия выдачи', async ({ page, browser }) => {
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
  await expect(analyst.getByText('Грейд C', { exact: true }).first()).toBeVisible();
  const terms = analyst.locator('table').filter({ hasText: 'Конвейер предлагает' });
  await expect(terms.getByRole('row', { name: /^Сумма/ })).toContainText('19 500 000 ₽');
  await expect(terms.getByRole('row', { name: /^Срок/ })).toContainText('60 месяцев');
  await expect(terms.getByRole('row', { name: /^Ставка/ })).toContainText('23,5%');
  // Трасса правил и воспроизведение решения на сохранённых признаках.
  await expect(analyst.getByRole('heading', { name: 'Как принималось решение' })).toBeVisible();
  await analyst.getByRole('button', { name: 'Воспроизвести решение' }).click();
  await expect(analyst.getByText(/^Совпадает:/)).toBeVisible();
  await analystDecides(analyst, id, 'Контрпредложение');

  // Клиент видит контрпредложение сразу, без перезагрузки.
  await expect(page.getByRole('heading', { name: 'Банк готов выдать на других условиях' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Сравнение с заявкой' })).toContainText('19 500 000 ₽');
  await page.getByRole('button', { name: 'Принять предложение' }).click();
  await expect(page.getByRole('heading', { name: 'Условия выдачи' })).toBeVisible();
  await sign(page);
  await expect(page.getByText(/Деньги поступят, как только вы закроете условия выдачи/)).toBeVisible();

  await page.locator('input[type=file]').first().setInputFiles({
    name: 'zalog.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% Документы по залогу\n%%EOF\n'),
  });
  const guarantee = page.locator('.mantine-Paper-root').filter({ hasText: 'Подтвердите поручительство собственника' });
  await guarantee.locator('textarea').fill('Подтверждаю поручительство');
  await guarantee.getByRole('button', { name: 'Ответить' }).click();
  await expectIssued(page, '19 500 000 ₽', 60);
});

test('start: отказ с причинами и подсказками', async ({ page }) => {
  await login(page, 'Павел Быстров');
  await apply(page, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 2_000_000, term: 12 });
  await expect(page.getByRole('heading', { name: 'Почему банк отказал' })).toBeVisible();
  const reasons = page.getByRole('list', { name: 'Причины отказа' }).getByRole('listitem');
  await expect(reasons).toHaveCount(3);
  await expect(reasons.filter({ hasText: 'Были просрочки по кредитам больше двух месяцев' })).toHaveCount(1);
  await expect(reasons.filter({ hasText: 'Сейчас есть просроченный платёж по кредиту' })).toHaveCount(1);
  await expect(reasons.filter({ hasText: 'работает в убыток' })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Что можно сделать' })).toBeVisible();
});

test('zakat: отказ по стоп-фактору — компания ликвидируется', async ({ page }) => {
  await login(page, 'Сергей Закатов');
  await apply(page, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 1_000_000, term: 12 });
  await expect(page.getByRole('heading', { name: 'Почему банк отказал' })).toBeVisible();
  await expect(page.getByText(/ликвидац/i).first()).toBeVisible();
});

test('new: подключение компании по ИНН из ЕГРЮЛ и одобрение', async ({ page }) => {
  await login(page, 'Никита Новиков');
  await expect(page.getByRole('heading', { name: 'Расскажите о компании' })).toBeVisible();
  await page.getByLabel('ИНН компании или ИП').fill('0077070071');
  await page.getByRole('button', { name: 'Найти' }).click();
  await expect(page.getByText('ООО «Новые горизонты»')).toBeVisible();
  await page.getByRole('button', { name: 'Да, это моя компания' }).click();
  await expect(page.getByText(/^ООО «Новые горизонты», /)).toBeVisible();
  await apply(page, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 2_000_000, term: 12 });
  await expect(page.getByRole('heading', { name: 'Банк готов выдать кредит' })).toBeVisible();
  await expect(page.getByTestId('offer-amount')).toContainText('2 000 000 ₽');
  await expect(page.getByTestId('offer-terms')).toContainText('22,9%');
  // Руководитель по ЕГРЮЛ получил право подписи: может принять предложение сам.
  await expect(page.getByRole('button', { name: 'Принять предложение' })).toBeVisible();
});

test('лента новостей своя у каждой компании', async ({ browser }) => {
  const feeds = [];
  for (const name of ['Ольга Северова', 'Дмитрий Орлов', 'Игорь Волков']) {
    const page = await session(browser, name);
    feeds.push((await feedTitles(page)).join('\n'));
  }
  expect(new Set(feeds).size).toBe(3);
});

test('analyst: очередь и симулятор кредитной политики', async ({ page }) => {
  await login(page, 'Мария Кредитова');
  await expect(page.getByRole('heading', { name: 'Очередь заявок' })).toBeVisible();
  await page.getByText('Все', { exact: true }).click();
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  await page.getByText('Кредитная политика', { exact: true }).first().click();
  await expect(page).toHaveURL(/\/policy$/);
  // Жёстче порог нагрузки: 50% → 30%, часть решений по уже поданным заявкам меняется, сами заявки — нет.
  const dsr = page.getByRole('slider').first();
  await dsr.focus();
  for (let i = 0; i < 4; i++) await dsr.press('ArrowLeft');
  await expect(page.getByText('Максимальная нагрузка: 30% выручки на все кредитные платежи')).toBeVisible();
  await page.getByRole('button', { name: 'Рассчитать' }).click();
  await expect(page.getByText('Положительные решения').first()).toBeVisible();
  await expect(page.getByText(/^Изменится решение: [1-9]\d* из \d+$/)).toBeVisible();
});
