import { writeFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';

import { apply, pickPersona, PURPOSE, sign, type ApplyStep } from '../helpers';
import { beat, cinema, hold, hoverOn, installDirector, moveAndClick } from './director';

// Основной сценарий на видео: тот же путь, что в тесте bakery (personas.spec.ts), но в человеческом темпе и с короткими
// подписями на экране, плюс кабинет аналитика. Запуск: npm run demo (конфиг playwright.demo.config.ts), в обычный
// прогон (npm run ui) этот файл не входит. Всё идёт в одной вкладке — получается одна запись.
//
// Сценарий — последовательность тактов (beat): одна мысль на подпись, подпись держится столько, сколько нужно на
// чтение (dwell в director.ts). Каждое нажатие видно: точка-курсор долетает до элемента, и только потом нажимает.

/** Подписи шагов анкеты и блок, о котором каждая из них. */
function applySteps(page: Page): Record<ApplyStep, () => Promise<void>> {
  const heading = (name: string) => page.getByRole('heading', { name });
  return {
    match: () =>
      beat(page, 'Платёж и условия видны ещё до заявки', {
        focus: page.getByRole('article', { name: 'Экспресс-оборот', exact: true }),
      }),
    company: () => beat(page, 'Данные компании подставлены из ЕГРЮЛ', { focus: heading('Проверьте данные компании') }),
    loan: () => beat(page, 'Сумма и срок перенесены из подбора', { focus: heading('Какой кредит нужен') }),
    finance: () => beat(page, 'Выручка и расходы — из данных ФНС', { focus: page.getByText(/Заполнили выручку и расходы по данным ФНС/) }),
    documents: () => beat(page, 'Документы необязательны: банк запросит сам', { focus: heading('Документы') }),
    review: () => beat(page, 'Последняя проверка перед отправкой', { focus: heading('Всё верно?') }),
    consent: () => beat(page, 'Согласие на проверку кредитной истории', { focus: page.getByLabel(/Согласен на запрос кредитной истории/) }),
  };
}

async function scenario(page: Page): Promise<void> {
  // 1. Вход под демо-учёткой клиента: список профилей открыт, профиль подсвечен до выбора.
  await page.goto('/login');
  await expect(page.getByRole('combobox', { name: 'Почта' })).toBeVisible();
  await hold(page, 1000);
  await pickPersona(page, 'Ольга Северова', {
    ...cinema,
    hover: async (option) => {
      await hoverOn(option, { hold: 300 });
      await beat(page, 'Клиент — директор «Северной пекарни»');
    },
  });
  await expect(page).not.toHaveURL(/\/login$/);
  await beat(page, 'Главная: компания, заявки, кредиты и новости');

  // 2. Подбор кредита: цель, сумма и срок набираются на глазах.
  await moveAndClick(page.getByRole('navigation').getByRole('link', { name: 'Подобрать кредит' }));
  await expect(page).toHaveURL(/\/match$/);

  // 3. Анкета со значениями из подбора и подстановкой данных; на каждом шаге — подпись, затем «Далее».
  const steps = applySteps(page);
  const id = await apply(
    page,
    { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 3_000_000, term: 12 },
    (step) => steps[step](),
    cinema,
  );

  // 4. Этапы конвейера идут сами, страница обновляется без перезагрузки; подпись держится, пока не придёт решение.
  const decision = page.getByRole('heading', { name: 'Банк готов выдать кредит' });
  await beat(page, 'Конвейер: проверки и оценка идут сами', { until: decision });
  // Номер — в строке под заголовком: «Заявка 2026-000001, отправлена …».
  const number = (await page.getByText(/^Заявка \d{4}-\d{6},/).first().innerText()).match(/\d{4}-\d{6}/)![0];

  // 5. Решение с объяснением.
  await beat(page, 'Решение автоматическое: сумма, ставка, платёж', { focus: decision });
  await beat(page, 'Причины одобрения — простыми словами, а не баллами', { focus: page.getByText('Почему одобрено', { exact: true }) });

  // 6. Принять предложение, посмотреть договор и график.
  await moveAndClick(page.getByRole('button', { name: 'Принять предложение' }));
  await beat(page, 'Предложение принято, договор готов', {
    focus: page.getByRole('heading', { name: 'Договор готов к подписанию' }),
  });
  await moveAndClick(page.getByRole('link', { name: 'Открыть договор и график платежей' }));
  await expect(page.getByRole('heading', { name: /Кредитный договор №/ })).toBeVisible();
  await expect(page.getByText('Ждёт подписи')).toBeVisible();
  await expect(page.locator('table tbody tr')).toHaveCount(12);
  await beat(page, 'Договор и график на 12 платежей', { focus: page.locator('table').first() });
  await moveAndClick(page.getByRole('link', { name: 'К заявке' }));
  await expect(page).toHaveURL(new RegExp(`/applications/${id}$`));

  // 7. Подпись кодом из окна подписания: согласие, «Подписать кодом», код набирается по цифре.
  await beat(page, 'Подпись — одноразовым кодом', { focus: page.getByLabel(/Я ознакомился с договором/) });
  await sign(
    page,
    () => beat(page, 'Демо: в банке код пришёл бы в приложение', { focus: page.getByRole('dialog', { name: 'Подписание договора' }) }),
    cinema,
  );

  // 8. Выдача и кредит с графиком.
  const issued = page.getByRole('heading', { name: 'Деньги на счёте!' });
  await beat(page, 'Код принят, договор подписан', { until: issued, timeout: 60_000 });
  await beat(page, 'Деньги на счёте — выдача через эмулятор АБС', { focus: issued });
  await moveAndClick(page.getByRole('link', { name: 'Кредит и график платежей' }));
  await expect(page).toHaveURL(/\/loans\/\d+$/);
  await expect(page.getByText('Сумма кредита').locator('..')).toContainText('3 000 000 ₽');
  await expect(page.locator('table tbody tr')).toHaveCount(12);
  await beat(page, 'Кредит: сумма, ставка и график платежей');

  // 9. Смена роли: выход через меню профиля и вход аналитиком банка.
  await moveAndClick(page.getByRole('button', { name: /^Профиль/ }));
  const exit = page.getByRole('menuitem', { name: 'Выйти' });
  await hoverOn(exit, { hold: 500 });
  await moveAndClick(exit);
  await expect(page).toHaveURL(/\/login$/);
  await beat(page, 'Теперь — глазами аналитика банка', { focus: page.getByRole('combobox', { name: 'Почта' }) });
  await pickPersona(page, 'Мария Кредитова', { ...cinema, hover: (option) => hoverOn(option, { hold: 600 }) });
  await expect(page.getByRole('heading', { name: 'Очередь заявок' })).toBeVisible();

  // 10. Очередь и карточка заявки.
  await moveAndClick(page.getByText('Все', { exact: true }));
  const row = page.getByRole('row').filter({ hasText: number });
  await expect(row).toBeVisible();
  await beat(page, `Очередь: заявка ${number} пекарни`, { focus: row });
  await moveAndClick(row);
  const assessment = page.getByRole('heading', { name: 'Оценка', exact: true });
  await expect(assessment).toBeVisible();
  await beat(page, 'Оценка: балл, грейд, факторы и стоп-факторы', { focus: assessment });

  // 11. Трасса правил и воспроизведение решения.
  await expect(page.getByRole('heading', { name: 'Как принималось решение' })).toBeVisible();
  await moveAndClick(page.getByRole('button', { name: 'Воспроизвести решение' }));
  const replayed = page.getByText(/^Совпадает:/);
  await expect(replayed).toBeVisible();
  await beat(page, 'Решение воспроизведено: исход тот же', { focus: replayed });

  // 12. Симулятор кредитной политики: порог покрытия двигается с клавиатуры, по шагу.
  await moveAndClick(page.getByRole('navigation').getByRole('link', { name: 'Кредитная политика' }));
  await expect(page).toHaveURL(/\/policy$/);
  const coverage = page.getByRole('slider').nth(1);
  await hoverOn(coverage, { hold: 400 });
  await coverage.focus();
  await beat(page, 'Кредитная политика: порог покрытия ×1,2 → ×2,0', {
    focus: coverage,
    during: async () => {
      for (let i = 0; i < 8; i++) {
        await coverage.press('ArrowRight');
        await page.waitForTimeout(250);
      }
    },
  });
  await expect(page.getByText('Минимальное покрытие нового платежа прибылью: ×2,0')).toBeVisible();
  await moveAndClick(page.getByRole('button', { name: 'Рассчитать' }));
  const simulated = page.getByText('С новыми порогами', { exact: true }).first();
  await expect(simulated).toBeVisible();
  // Последний такт держится дольше: запись заканчивается на итоге пересчёта.
  await beat(page, 'Пересчёт по поданным заявкам — сами они не меняются', { focus: simulated, extra: 1500 });
}

test('основной сценарий: заявка пекарни от подбора до выдачи и проверка решения аналитиком', async ({ page }, testInfo) => {
  const director = await installDirector(page);
  try {
    await scenario(page);
  } finally {
    // Разметка записи — рядом с видео: такты с подписями и нажатия; по ней подбирается темп (PACE в director.ts).
    const timeline = { total: Date.now() - director.t0, entries: director.timeline };
    for (const [name, data] of [
      ['timeline.json', timeline],
      ['presses.json', director.presses],
    ] as const) {
      const path = testInfo.outputPath(name);
      await writeFile(path, JSON.stringify(data, null, 2));
      await testInfo.attach(name, { path, contentType: 'application/json' });
    }
  }

  // Каждое нажатие — после перелёта точки-курсора к элементу, и точка стоит там, куда пришлось нажатие.
  expect(director.presses.length).toBeGreaterThan(20);
  expect(director.presses.filter((p) => !p.glided)).toEqual([]);
  expect(director.presses.filter((p) => Math.hypot(p.x - p.cursorX, p.y - p.cursorY) > 2)).toEqual([]);
});
