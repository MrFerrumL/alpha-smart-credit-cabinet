import { expect, type Browser, type Locator, type Page } from '@playwright/test';

export const PURPOSE = {
  workingCapital: 'Пополнить оборотные средства',
  equipment: 'Купить оборудование или транспорт',
} as const;

export interface ApplicationInput {
  purpose: string;
  product: string;
  amount: number;
  term: number;
  /** Выручку вводит клиент, если в налоговой нет данных (иначе подставится сама). */
  revenue?: number;
  collateral?: { kind: string; value: number };
}

/** Вход в один клик под демо-учёткой со страницы входа. */
export async function login(page: Page, fullName: string): Promise<void> {
  await page.goto('/login');
  await page.getByText(fullName, { exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

/** Отдельная вкладка-сессия: токен живёт в sessionStorage, как у второго экрана на демо. */
export async function session(browser: Browser, fullName: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await login(page, fullName);
  return page;
}

/** Как moneyShort во фронтенде: «3 млн ₽», «4,5 млн ₽», «500 тыс. ₽». */
export function moneyShort(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
  return `${Math.round(value / 1_000)} тыс. ₽`;
}

async function setSlider(slider: Locator, from: number, to: number, step: number): Promise<void> {
  await slider.focus();
  const key = to >= from ? 'ArrowRight' : 'ArrowLeft';
  for (let i = 0; i < Math.abs(to - from) / step; i++) await slider.press(key);
}

/** Подбор → анкета → «Отправить в банк». Возвращает номер заявки в URL. */
export async function apply(page: Page, input: ApplicationInput): Promise<string> {
  await page.goto('/match');
  await page.getByText(input.purpose, { exact: true }).click();
  await page.getByLabel('Сумма').fill(String(input.amount));
  // Срок на подборе — от 3 месяцев с шагом 3, по умолчанию 12.
  await setSlider(page.getByRole('slider').nth(1), 12, input.term, 3);
  const card = page.locator('.mantine-Card-root').filter({ has: page.getByRole('heading', { name: input.product, exact: true }) });
  // Подбор пересчитывается с задержкой — ждём, пока в карточке появятся введённые срок и сумма.
  await expect(card.getByText('Сумма', { exact: true }).locator('..')).toContainText(moneyShort(input.amount));
  await expect(card.getByText('Срок', { exact: true }).locator('..')).toContainText(`${input.term} мес`);
  await card.getByRole('button', { name: 'Оформить заявку' }).click();
  await expect(page).toHaveURL(/\/applications\/\d+\/edit$/);
  const id = page.url().match(/applications\/(\d+)/)![1];

  const next = page.getByRole('button', { name: 'Далее' });
  await expect(page.getByRole('heading', { name: 'Проверьте данные компании' })).toBeVisible();
  await next.click();
  await expect(page.getByRole('heading', { name: 'Какой кредит нужен' })).toBeVisible();
  await expect(page.getByText(`Срок: ${input.term} мес`)).toBeVisible();
  await next.click();
  await expect(page.getByRole('heading', { name: 'Финансы компании' })).toBeVisible();
  if (input.revenue !== undefined) {
    await page.getByLabel('Выручка в месяц').fill(String(input.revenue));
  } else {
    await expect(page.getByText(/Заполнили выручку и расходы по данным ФНС/)).toBeVisible();
  }
  await next.click();
  if (input.collateral) {
    await expect(page.getByRole('heading', { name: 'Обеспечение' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Что предлагаете в залог' }).click();
    await page.getByRole('option', { name: input.collateral.kind }).click();
    await page.getByLabel('Примерная стоимость').fill(String(input.collateral.value));
    await next.click();
  }
  await expect(page.getByRole('heading', { name: 'Документы' })).toBeVisible();
  await next.click();
  await expect(page.getByRole('heading', { name: 'Всё верно?' })).toBeVisible();
  await page.getByLabel(/Согласен на запрос кредитной истории/).check();
  await page.getByRole('button', { name: 'Отправить в банк' }).click();
  await expect(page).toHaveURL(new RegExp(`/applications/${id}$`));
  return id;
}

export const status = (page: Page) => page.locator('h3').first();

/** Подпись договора кодом из окна подписания. */
export async function sign(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Договор готов к подписанию' })).toBeVisible();
  await page.getByLabel(/Я ознакомился с договором/).check();
  await page.getByRole('button', { name: 'Подписать кодом' }).click();
  const dialog = page.getByRole('dialog', { name: 'Подписание договора' });
  const code = dialog.locator('.mantine-Text-root').filter({ hasText: /^\d{6}$/ });
  await expect(code).toBeVisible();
  await dialog.locator('input').first().click();
  await page.keyboard.type((await code.innerText()).trim());
}

/** Выдача: «Деньги на счёте!», кредит с графиком на нужное число платежей. */
export async function expectIssued(page: Page, amount: string, term: number): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Деньги на счёте!' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('link', { name: 'Кредит и график платежей' }).click();
  await expect(page).toHaveURL(/\/loans\/\d+$/);
  await expect(page.getByText('Сумма кредита').locator('..')).toContainText(amount);
  await expect(page.locator('table tbody tr')).toHaveCount(term);
  await page.goto('/loans');
  await expect(page.getByRole('heading', { name: 'Мои кредиты' })).toBeVisible();
}

/** Заголовки ленты «Новости для вас» на главной. */
export async function feedTitles(page: Page): Promise<string[]> {
  await page.goto('/');
  const card = page.locator('.mantine-Card-root').filter({ has: page.getByRole('heading', { name: 'Новости для вас' }) });
  const titles = card.locator('.mantine-Stack-root > div > p:first-child');
  await expect(titles.first()).toBeVisible();
  return titles.allInnerTexts();
}

/** Аналитик открывает заявку и сохраняет решение (исход по умолчанию — рекомендация конвейера). */
export async function analystDecides(page: Page, id: string, outcome?: string): Promise<void> {
  await page.goto(`/applications/${id}`);
  await expect(page.getByRole('heading', { name: 'Решение по заявке' })).toBeVisible();
  if (outcome) await page.getByText(outcome, { exact: true }).click();
  await page.getByLabel('Обоснование для журнала аудита').fill('Проверено по выписке и данным бюро, условия в рамках политики');
  await page.getByRole('button', { name: 'Сохранить решение' }).click();
  await expect(page.getByRole('heading', { name: 'Решение по заявке' })).toBeHidden();
}
