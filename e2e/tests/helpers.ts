import { expect, type Browser, type Locator, type Page } from '@playwright/test';

/**
 * Как сценарий нажимает, отмечает и вводит. Обычные тесты идут быстрым способом (fast) — как всегда; запись демо
 * передаёт свой: курсор плавно подводится к элементу, текст набирается по знакам.
 */
export interface Actor {
  click(target: Locator): Promise<void>;
  check(target: Locator): Promise<void>;
  fill(target: Locator, value: string): Promise<void>;
  /** Ввод с клавиатуры в поле, где уже стоит фокус. */
  type(page: Page, text: string): Promise<void>;
  /** Навести указатель на вариант перед выбором (список демо-профилей); быстрому способу не нужно. */
  hover?(target: Locator): Promise<void>;
}

export const fast: Actor = {
  click: (target) => target.click(),
  check: (target) => target.check(),
  fill: (target, value) => target.fill(value),
  type: (page, text) => page.keyboard.type(text),
};

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
export async function pickPersona(page: Page, fullName: string, actor: Actor = fast): Promise<void> {
  await actor.click(page.getByRole('combobox', { name: 'Почта' }));
  const option = page.getByRole('option', { name: new RegExp(`^${fullName}`) });
  await actor.hover?.(option);
  await actor.click(option);
  await actor.click(page.getByRole('button', { name: 'Войти', exact: true }));
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

/** Как money во фронтенде: «3 000 000 ₽» (пробелы сравниваются без учёта вида — обычный или неразрывный). */
export function money(value: number): string {
  return `${value.toLocaleString('ru-RU').replace(/\s/g, ' ')} ₽`;
}

/** Остановки по ходу подачи заявки: запись демо ставит на них подписи и паузы, обычные тесты хук не передают. */
export type ApplyStep = 'match' | 'company' | 'loan' | 'finance' | 'documents' | 'review' | 'consent';
export type ApplyHook = (step: ApplyStep) => Promise<void>;

/** Подбор → «Оформить заявку»: открыт первый шаг анкеты нового черновика. Возвращает номер заявки в URL. */
export async function startDraft(page: Page, input: ApplicationInput, onStep?: ApplyHook, actor: Actor = fast): Promise<string> {
  // Запись демо открывает подбор через меню сама, остальные тесты приходят сюда с другой страницы.
  if (!/\/match$/.test(page.url())) await page.goto('/match');
  await actor.click(page.getByText(input.purpose, { exact: true }));
  await actor.fill(page.getByLabel('Сумма', { exact: true }), String(input.amount));
  // Срок вводится в поле «Срок» (рядом — быстрые значения и слайдер).
  await actor.fill(page.getByLabel('Срок', { exact: true }), String(input.term));
  const card = page.getByRole('article', { name: input.product, exact: true });
  // Подбор пересчитывается с задержкой — ждём, пока в варианте появятся введённые срок и сумма.
  await expect(card.getByTestId('match-terms')).toContainText(money(input.amount));
  await expect(card.getByTestId('match-terms')).toContainText(`на ${input.term} мес`);
  await onStep?.('match');
  await actor.click(card.getByRole('button', { name: 'Оформить заявку' }));
  await expect(page).toHaveURL(/\/applications\/\d+\/edit$/);
  await expect(page.getByRole('heading', { name: 'Проверьте данные компании' })).toBeVisible();
  return page.url().match(/applications\/(\d+)/)![1];
}

/** Подбор → анкета → «Отправить в банк». Возвращает номер заявки в URL. */
export async function apply(page: Page, input: ApplicationInput, onStep?: ApplyHook, actor: Actor = fast): Promise<string> {
  const id = await startDraft(page, input, onStep, actor);
  const next = page.getByRole('button', { name: 'Далее' });
  await onStep?.('company');
  await actor.click(next);
  await expect(page.getByRole('heading', { name: 'Какой кредит нужен' })).toBeVisible();
  await expect(page.getByLabel('Срок', { exact: true })).toHaveValue(String(input.term));
  await onStep?.('loan');
  await actor.click(next);
  await expect(page.getByRole('heading', { name: 'Финансы компании' })).toBeVisible();
  if (input.revenue !== undefined) {
    await actor.fill(page.getByLabel('Выручка в месяц'), String(input.revenue));
  } else {
    await expect(page.getByText(/Заполнили выручку и расходы по данным ФНС/)).toBeVisible();
  }
  await onStep?.('finance');
  await actor.click(next);
  if (input.collateral) {
    await expect(page.getByRole('heading', { name: 'Обеспечение' })).toBeVisible();
    await actor.click(page.getByRole('textbox', { name: 'Что предлагаете в залог' }));
    await actor.click(page.getByRole('option', { name: input.collateral.kind }));
    await actor.fill(page.getByLabel('Примерная стоимость'), String(input.collateral.value));
    await actor.click(next);
  }
  await expect(page.getByRole('heading', { name: 'Документы' })).toBeVisible();
  await onStep?.('documents');
  await actor.click(next);
  await expect(page.getByRole('heading', { name: 'Всё верно?' })).toBeVisible();
  await onStep?.('review');
  await actor.check(page.getByLabel(/Согласен на запрос кредитной истории/));
  await onStep?.('consent');
  await actor.click(page.getByRole('button', { name: 'Отправить в банк' }));
  await expect(page).toHaveURL(new RegExp(`/applications/${id}$`));
  return id;
}

export const status = (page: Page) => page.locator('h3').first();

/** Подпись договора кодом из окна подписания. Хук вызывается, когда код уже показан, а ввод ещё не начат. */
export async function sign(page: Page, onCodeShown?: () => Promise<void>, actor: Actor = fast): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Договор готов к подписанию' })).toBeVisible();
  await actor.check(page.getByLabel(/Я ознакомился с договором/));
  await actor.click(page.getByRole('button', { name: 'Подписать кодом' }));
  const dialog = page.getByRole('dialog', { name: 'Подписание договора' });
  const code = dialog.locator('.mantine-Text-root').filter({ hasText: /^\d{6}$/ });
  await expect(code).toBeVisible();
  await onCodeShown?.();
  await actor.click(dialog.locator('input').first());
  await actor.type(page, (await code.innerText()).trim());
}

/** Клиент отказывается от предложения банка: заявка закрывается и не меняет этап компании для следующих тестов. */
export async function declineOffer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Отказаться от предложения' }).click();
  const dialog = page.getByRole('dialog', { name: 'Отказаться от предложения?' });
  await dialog.getByRole('button', { name: 'Отказаться', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Отказаться от предложения' })).toBeHidden();
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

/** Заголовки ленты «Новости для вас» на главной: все (all) или только три, что видны сразу. */
export async function feedTitles(page: Page, all = true): Promise<string[]> {
  await page.goto('/');
  const feed = page.getByRole('region', { name: 'Новости для вас' });
  const titles = feed.getByTestId('news-title');
  await expect(titles.first()).toBeVisible();
  // На главной видны 3 новости — раскрываем все, чтобы сравнивать ленту целиком.
  const more = feed.getByRole('button', { name: 'Все новости' });
  if (all && (await more.isVisible())) await more.click();
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
