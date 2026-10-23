import { expect, type Browser, type Page } from '@playwright/test';

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

/** Выбор демо-профиля в выпадающем списке поля «Почта» и вход. */
export async function pickPersona(page: Page, fullName: string): Promise<void> {
  await page.getByRole('combobox', { name: 'Почта' }).click();
  await page.getByRole('option', { name: new RegExp(`^${fullName}`) }).click();
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
}

/** Вход под демо-учёткой со страницы входа. */
export async function login(page: Page, fullName: string): Promise<void> {
  await page.goto('/login');
  await pickPersona(page, fullName);
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

/** Остановки по ходу подачи заявки: запись демо ставит на них подписи и паузы, обычные тесты хук не передают. */
export type ApplyStep = 'match' | 'company' | 'loan' | 'finance' | 'documents' | 'review' | 'consent';
export type ApplyHook = (step: ApplyStep) => Promise<void>;

/** Подбор → анкета → «Отправить в банк». Возвращает номер заявки в URL. */
export async function apply(page: Page, input: ApplicationInput, onStep?: ApplyHook): Promise<string> {
  // Запись демо открывает подбор через меню сама, остальные тесты приходят сюда с другой страницы.
  if (!/\/match$/.test(page.url())) await page.goto('/match');
  await page.getByText(input.purpose, { exact: true }).click();
  await page.getByLabel('Сумма', { exact: true }).fill(String(input.amount));
  // Срок вводится в поле «Срок» (рядом — быстрые значения и слайдер).
  await page.getByLabel('Срок', { exact: true }).fill(String(input.term));
  const card = page.locator('.mantine-Card-root').filter({ has: page.getByRole('heading', { name: input.product, exact: true }) });
  // Подбор пересчитывается с задержкой — ждём, пока в карточке появятся введённые срок и сумма.
  await expect(card.getByText('Сумма', { exact: true }).locator('..')).toContainText(moneyShort(input.amount));
  await expect(card.getByText('Срок', { exact: true }).locator('..')).toContainText(`${input.term} мес`);
  await onStep?.('match');
  await card.getByRole('button', { name: 'Оформить заявку' }).click();
  await expect(page).toHaveURL(/\/applications\/\d+\/edit$/);
  const id = page.url().match(/applications\/(\d+)/)![1];

  const next = page.getByRole('button', { name: 'Далее' });
  await expect(page.getByRole('heading', { name: 'Проверьте данные компании' })).toBeVisible();
  await onStep?.('company');
  await next.click();
  await expect(page.getByRole('heading', { name: 'Какой кредит нужен' })).toBeVisible();
  await expect(page.getByLabel('Срок', { exact: true })).toHaveValue(String(input.term));
  await onStep?.('loan');
  await next.click();
  await expect(page.getByRole('heading', { name: 'Финансы компании' })).toBeVisible();
  if (input.revenue !== undefined) {
    await page.getByLabel('Выручка в месяц').fill(String(input.revenue));
  } else {
    await expect(page.getByText(/Заполнили выручку и расходы по данным ФНС/)).toBeVisible();
  }
  await onStep?.('finance');
  await next.click();
  if (input.collateral) {
    await expect(page.getByRole('heading', { name: 'Обеспечение' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Что предлагаете в залог' }).click();
    await page.getByRole('option', { name: input.collateral.kind }).click();
    await page.getByLabel('Примерная стоимость').fill(String(input.collateral.value));
    await next.click();
  }
  await expect(page.getByRole('heading', { name: 'Документы' })).toBeVisible();
  await onStep?.('documents');
  await next.click();
  await expect(page.getByRole('heading', { name: 'Всё верно?' })).toBeVisible();
  await onStep?.('review');
  await page.getByLabel(/Согласен на запрос кредитной истории/).check();
  await onStep?.('consent');
  await page.getByRole('button', { name: 'Отправить в банк' }).click();
  await expect(page).toHaveURL(new RegExp(`/applications/${id}$`));
  return id;
}

export const status = (page: Page) => page.locator('h3').first();

/** Подпись договора кодом из окна подписания. Хук вызывается, когда код уже показан, а ввод ещё не начат. */
export async function sign(page: Page, onCodeShown?: () => Promise<void>): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Договор готов к подписанию' })).toBeVisible();
  await page.getByLabel(/Я ознакомился с договором/).check();
  await page.getByRole('button', { name: 'Подписать кодом' }).click();
  const dialog = page.getByRole('dialog', { name: 'Подписание договора' });
  const code = dialog.locator('.mantine-Text-root').filter({ hasText: /^\d{6}$/ });
  await expect(code).toBeVisible();
  await onCodeShown?.();
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
  const feed = page.getByRole('region', { name: 'Новости для вас' });
  const titles = feed.getByTestId('news-title');
  await expect(titles.first()).toBeVisible();
  // На главной видны 3 новости — раскрываем все, чтобы сравнивать ленту целиком.
  const more = feed.getByRole('button', { name: 'Все новости' });
  if (await more.isVisible()) await more.click();
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
