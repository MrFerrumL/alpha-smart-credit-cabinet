import { expect, test, type Page } from '@playwright/test';

import { apply, declineOffer, login, PURPOSE, session } from './helpers';

const MOCKS_URL = process.env.E2E_MOCKS_URL ?? 'http://localhost:8001';
// Пауза предохранителя в воркере (BREAKER_COOLDOWN_S, 20 с) с запасом.
const BREAKER_PAUSE_MS = 21_000;
const SOURCES = ['egrul', 'fns', 'bki', 'abs'];

test.afterEach(async ({ request }) => {
  await request.post(`${MOCKS_URL}/admin/faults`, { data: { source: 'all', mode: 'none' } });
});

/**
 * Заявка пекарни уходит из конвейера, чтобы не задеть следующие сценарии: от предложения клиент отказывается, иначе
 * отзывает заявку.
 */
async function closeApplication(page: Page, id: string): Promise<void> {
  await page.goto(`/applications/${id}`);
  const decline = page.getByRole('button', { name: 'Отказаться от предложения' });
  // Сбой снят: пробный запрос к БКИ проходит, и конвейер доводит заявку до решения сам.
  const offered = await decline.waitFor({ timeout: 45_000 }).then(
    () => true,
    () => false,
  );
  if (offered) {
    await declineOffer(page);
    return;
  }
  // Заявка ещё в конвейере или ушла специалисту — отзываем её, как клиент.
  await page.getByRole('button', { name: 'Отозвать заявку' }).click();
  await page.getByRole('dialog', { name: 'Отозвать заявку?' }).getByRole('button', { name: 'Отозвать', exact: true }).click();
  await expect(page.getByText('Заявка отозвана').first()).toBeVisible();
  // Удачной пробы не было — предохранитель воркера, возможно, ещё на паузе. Ждём её конец, чтобы следующая заявка
  // пекарни не попала на паузу.
  await page.waitForTimeout(BREAKER_PAUSE_MS);
}

// Страница «Состояние системы» у аналитика: источники и очередь видны сразу, а серия сбоев БКИ ставит источник на паузу
// и попадает в «Последние повторы и сбои» — без перезагрузки страницы.
test('состояние системы: пауза БКИ после серии сбоев и повтор шага видны аналитику', async ({ page, browser, request }) => {
  test.setTimeout(300_000);
  await login(page, 'Мария Кредитова');
  await page.getByRole('link', { name: 'Состояние системы' }).first().click();
  await expect(page).toHaveURL(/\/system$/);
  await expect(page.getByRole('heading', { name: 'Состояние системы', level: 1 })).toBeVisible();
  await expect(page.getByTestId('system-version')).toHaveText(/^Версия \d+\.\d+\.\d+$/);
  await expect(page.getByText(/^Обновлено /)).toBeVisible();
  for (const source of SOURCES) await expect(page.getByTestId(`source-${source}`)).toContainText('работает');
  for (const figure of ['queue-pending', 'queue-running', 'queue-failed']) {
    await expect(page.getByTestId(figure)).toHaveText(/^\d+$/);
  }
  await expect(page.getByTestId('queue-oldest')).toHaveText(/^\d+\s(с|мин)/);

  // БКИ отвечает ошибкой, пока сбой не снят.
  const fault = await request.post(`${MOCKS_URL}/admin/faults`, { data: { source: 'bki', mode: 'error' } });
  expect(fault.ok()).toBeTruthy();
  const client = await session(browser, 'Ольга Северова');
  let id: string | undefined;
  try {
    id = await apply(client, { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 1_000_000, term: 12 });
    await page.bringToFront();

    // Пять сбоев подряд — воркер ставит БКИ на паузу; страница обновляется сама каждые 5 с.
    const bki = page.getByTestId('source-bki');
    await expect(bki).toContainText('на паузе', { timeout: 60_000 });
    await expect(bki).toContainText('Запросы приостановлены после серии сбоев, повторим автоматически');
    for (const source of ['egrul', 'fns', 'abs']) await expect(page.getByTestId(`source-${source}`)).toContainText('работает');
    // Отложенный повтор — в очереди.
    await expect(page.getByTestId('queue-pending')).not.toHaveText('0');

    const jobs = page.getByRole('region', { name: 'Последние повторы и сбои' });
    const row = jobs.getByRole('listitem').filter({ has: page.locator(`a[href="/applications/${id}"]`) });
    await expect(row.first()).toContainText('БКИ: запросы на паузе после серии сбоев');
    await expect(row.first()).toContainText('Запрос во внешние источники');
    await expect(row.first()).toContainText(/ждёт повтора|повторяем/);
    // ИНН компании на странице банка о сбоях не показывается.
    await expect(jobs).not.toContainText('0077010019');
  } finally {
    await request.post(`${MOCKS_URL}/admin/faults`, { data: { source: 'all', mode: 'none' } });
    // После паузы пробный запрос проходит — БКИ снова «работает».
    await expect(page.getByTestId('source-bki')).toContainText('работает', { timeout: 60_000 });
    if (id) await closeApplication(client, id);
  }
});
