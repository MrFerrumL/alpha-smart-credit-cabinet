import { expect, test, type Locator, type Page } from '@playwright/test';

import { apply, PURPOSE, session } from './helpers';

// Лента «Новости для вас» на главной своя у каждой компании и говорит, по чему подобрана. Первой стоит новость по
// этапу главной заявки — с меткой «По вашей заявке» и ссылкой на заявку со следующим шагом клиента.

/** Лента на главной: три новости, что видны сразу, — в порядке сервера. */
async function homeFeed(page: Page): Promise<Locator> {
  await page.goto('/');
  const feed = page.getByRole('region', { name: 'Новости для вас' });
  await expect(feed.getByTestId('news-title')).toHaveCount(3);
  return feed;
}

/** Сколько строк занимает текст элемента (по высоте и межстрочному интервалу). */
const lines = (target: Locator) =>
  target.evaluate((el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));

test('лента на главной: своя у пекарни и у Смирновой, первой — новость по этапу заявки со ссылкой', async ({ browser }) => {
  // Пекарня: заявка одобрена — первой новость о договоре, ссылка ведёт к предложению банка.
  const bakery = await session(browser, 'Ольга Северова');
  const bakeryId = await apply(bakery, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 3_000_000, term: 12 });
  await expect(bakery.getByRole('heading', { name: 'Банк готов выдать кредит' })).toBeVisible();
  const bakeryFeed = await homeFeed(bakery);
  await expect(
    bakeryFeed.getByText(/^Подобрано для ООО\s«Северная\sпекарня»:\sпроизводство\s·\sЭкспресс-оборот\s·\sодобрено$/),
  ).toBeVisible();
  const bakeryTop = bakeryFeed.getByRole('listitem').first();
  await expect(bakeryTop.getByTestId('news-title')).toHaveText(/^Что проверить в договоре перед подписью кодом/);
  await expect(bakeryTop.getByText('По вашей заявке', { exact: true })).toBeVisible();
  await expect(bakeryTop.getByRole('link', { name: 'Открыть предложение' })).toHaveAttribute('href', `/applications/${bakeryId}`);
  // Пересказ читается целиком — в несколько строк, а не обрезан до одной.
  const summary = bakeryTop.getByTestId('news-summary');
  await expect(summary).not.toHaveCSS('white-space', 'nowrap');
  expect(await lines(summary)).toBeGreaterThan(1.5);
  const bakeryTitles = await bakeryFeed.getByTestId('news-title').allInnerTexts();

  // Смирнова: банк попросил выписку — первой новость о дополнительных документах, ссылка «Загрузить выписку».
  const smirnova = await session(browser, 'Анна Смирнова');
  const smirnovaId = await apply(smirnova, {
    purpose: PURPOSE.workingCapital,
    product: 'Экспресс-оборот',
    amount: 500_000,
    term: 12,
    revenue: 600_000,
  });
  await expect(smirnova.getByRole('heading', { name: 'Банк просит уточнить' })).toBeVisible();
  const smirnovaFeed = await homeFeed(smirnova);
  await expect(
    smirnovaFeed.getByText(/^Подобрано для ИП\sСмирнова\sА\.\sВ\.:\sуслуги\sнаселению\s·\sЭкспресс-оборот\s·\sнужна\sинформация$/),
  ).toBeVisible();
  const smirnovaTop = smirnovaFeed.getByRole('listitem').first();
  await expect(smirnovaTop.getByTestId('news-title')).toHaveText(/^Что делать, если банк запросил дополнительные документы/);
  await expect(smirnovaTop.getByText('По вашей заявке', { exact: true })).toBeVisible();
  const upload = smirnovaTop.getByRole('link', { name: 'Загрузить выписку' });
  await expect(upload).toHaveAttribute('href', `/applications/${smirnovaId}`);
  const smirnovaTitles = await smirnovaFeed.getByTestId('news-title').allInnerTexts();

  // У пекарни и у Смирновой разные отрасли и этапы — и три новости на главной разные.
  expect(smirnovaTitles.filter((t) => bakeryTitles.includes(t)).length).toBeLessThanOrEqual(1);
  expect(smirnovaTitles[0]).not.toBe(bakeryTitles[0]);

  // Ссылка из новости ведёт к запросу банка в заявке.
  await upload.click();
  await expect(smirnova).toHaveURL(new RegExp(`/applications/${smirnovaId}$`));
  await expect(smirnova.getByRole('heading', { name: 'Банк просит уточнить' })).toBeVisible();
});
