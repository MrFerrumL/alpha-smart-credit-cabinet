import { expect, test, type Locator, type Page } from '@playwright/test';

import { apply, pickPersona, PURPOSE, sign, type ApplyStep } from '../helpers';

// Основной сценарий на видео: тот же путь, что в тесте bakery (personas.spec.ts), но в человеческом темпе и с короткими
// подписями на экране, плюс кабинет аналитика. Запуск: npm run demo (конфиг playwright.demo.config.ts), в обычный
// прогон (npm run ui) этот файл не входит. Всё идёт в одной вкладке — получается одна запись.

const pause = (page: Page, ms = 2000) => page.waitForTimeout(ms);

/** Подпись внизу экрана. Элемент лежит в body вне корня приложения, поэтому переживает смену маршрута. */
async function caption(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    let el = document.getElementById('demo-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-caption';
      el.setAttribute('aria-hidden', 'true');
      Object.assign(el.style, {
        position: 'fixed',
        left: '300px',
        right: '24px',
        bottom: '24px',
        zIndex: '2147483647',
        pointerEvents: 'none',
        textAlign: 'center',
        font: '600 20px/1.35 system-ui, "Segoe UI", Roboto, sans-serif',
        color: '#fff',
        background: 'rgba(17, 24, 39, 0.9)',
        padding: '12px 22px',
        borderRadius: '14px',
        boxShadow: '0 6px 24px rgba(0, 0, 0, 0.3)',
      });
      document.body.appendChild(el);
    }
    el.textContent = value;
  }, text);
}

/** Подпись и остановка на экране, чтобы фразу успели прочитать. */
async function show(page: Page, text: string, ms = 2500): Promise<void> {
  await caption(page, text);
  await pause(page, ms);
}

/** Плавная прокрутка к блоку: на видео видно, куда смотреть, а не мгновенный скачок. */
async function reveal(target: Locator): Promise<void> {
  await target.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await pause(target.page(), 1000);
}

/** Точка-курсор: в записи Playwright указателя мыши нет, без него не видно, что нажимает сценарий. */
async function installCursor(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const dot = () => {
      let el = document.getElementById('demo-cursor');
      if (!el && document.body) {
        el = document.createElement('div');
        el.id = 'demo-cursor';
        el.setAttribute('aria-hidden', 'true');
        Object.assign(el.style, {
          position: 'fixed',
          left: '0',
          top: '0',
          width: '22px',
          height: '22px',
          margin: '-11px 0 0 -11px',
          borderRadius: '50%',
          background: 'rgba(239, 49, 36, 0.55)',
          border: '2px solid #ef3124',
          zIndex: '2147483646',
          pointerEvents: 'none',
          transition: 'transform 0.25s ease-out, scale 0.12s',
        });
        document.body.appendChild(el);
      }
      return el;
    };
    window.addEventListener(
      'mousemove',
      (e) => {
        const el = dot();
        if (el) el.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      },
      true,
    );
    window.addEventListener('mousedown', () => dot()?.style.setProperty('scale', '0.6'), true);
    window.addEventListener('mouseup', () => dot()?.style.setProperty('scale', '1'), true);
  });
}

const APPLY_CAPTIONS: Record<ApplyStep, [text: string, ms: number]> = {
  match: ['Подобрали продукт: платёж, ставка и условия видны до подачи заявки', 3000],
  company: ['Данные компании уже подставлены из ЕГРЮЛ — вводить их заново не нужно', 3000],
  loan: ['Сумма и срок перенесены из подбора', 1800],
  finance: ['Выручка и расходы подставлены из данных ФНС, вручную их вносить не пришлось', 3000],
  documents: ['Документы необязательны: с ними решение быстрее, но банк запросит их сам, если понадобятся', 2500],
  review: ['Последняя проверка данных перед отправкой', 1800],
  consent: ['Клиент даёт согласие на запрос кредитной истории и отправляет заявку', 2200],
};

test('основной сценарий: заявка пекарни от подбора до выдачи и проверка решения аналитиком', async ({ page }) => {
  await installCursor(page);

  // 1. Вход под демо-учёткой клиента.
  await page.goto('/login');
  await show(page, 'Демо-профили — в списке поля «Почта». Клиент — директор «Северной пекарни» Ольга Северова', 3000);
  await pickPersona(page, 'Ольга Северова');
  await expect(page).not.toHaveURL(/\/login$/);
  await show(page, 'Главная клиента: компания, заявки, кредиты и новости, подобранные под неё', 3000);

  // 2. Подбор кредита.
  await page.getByRole('navigation').getByRole('link', { name: 'Подобрать кредит' }).click();
  await expect(page).toHaveURL(/\/match$/);
  await show(page, 'Подбор кредита: клиент выбирает цель, вводит сумму и срок', 2000);

  // 3. Анкета со значениями из подбора и подстановкой данных; на каждом шаге — подпись и пауза.
  const id = await apply(
    page,
    { purpose: PURPOSE.workingCapital, product: 'Экспресс-оборот', amount: 3_000_000, term: 12 },
    async (step) => {
      // Подпись лежит внизу экрана — нужный блок прокручиваем в середину, чтобы она его не закрывала.
      if (step === 'match') {
        await reveal(page.getByRole('article', { name: 'Экспресс-оборот', exact: true }));
      }
      if (step === 'review') await reveal(page.getByLabel(/Согласен на запрос кредитной истории/));
      await show(page, ...APPLY_CAPTIONS[step]);
    },
  );

  // 4. Этапы конвейера идут сами, страница обновляется без перезагрузки.
  await caption(page, 'Заявка в конвейере: проверка компании, оценка, решение — этапы меняются на глазах');
  const decision = page.getByRole('heading', { name: 'Банк готов выдать кредит' });
  await expect(decision).toBeVisible({ timeout: 90_000 });
  const number = (await page.locator('h2').filter({ hasText: /^Заявка №/ }).innerText()).replace(/^Заявка №\s*/, '').trim();

  // 5. Решение с объяснением.
  await show(page, 'Решение принято автоматически: сумма, срок, ставка и платёж в месяц', 3000);
  await reveal(page.getByText('Почему одобрено', { exact: true }));
  await show(page, 'Причины одобрения — простыми словами, а не баллами', 3000);

  // 6. Принять предложение, посмотреть договор и график.
  const accept = page.getByRole('button', { name: 'Принять и перейти к договору' });
  await reveal(accept);
  await show(page, 'Клиент принимает предложение банка', 1800);
  await accept.click();
  await page.getByRole('link', { name: 'Открыть договор и график платежей' }).click();
  await expect(page.getByRole('heading', { name: /Кредитный договор №/ })).toBeVisible();
  await expect(page.getByText('Ждёт подписи')).toBeVisible();
  await expect(page.locator('table tbody tr')).toHaveCount(12);
  await show(page, 'Кредитный договор: стороны, условия и сумма — до подписания', 2500);
  await reveal(page.locator('table').first());
  await show(page, 'График платежей на 12 месяцев: основной долг и проценты по каждому платежу', 3000);
  await page.getByRole('link', { name: 'К заявке' }).click();
  await expect(page).toHaveURL(new RegExp(`/applications/${id}$`));

  // 7. Подпись кодом из окна подписания.
  await caption(page, 'Договор подписывается одноразовым кодом — это смоделированная простая электронная подпись');
  await sign(page, async () => show(page, 'Код показан прямо в окне: в банке он пришёл бы в мобильное приложение', 3000));

  // 8. Выдача и кредит с графиком.
  const issued = page.getByRole('heading', { name: 'Деньги на счёте!' });
  await expect(issued).toBeVisible({ timeout: 60_000 });
  await reveal(issued);
  await show(page, 'Деньги на счёте: кредит выдан через эмулятор АБС', 3000);
  await page.getByRole('link', { name: 'Кредит и график платежей' }).click();
  await expect(page).toHaveURL(/\/loans\/\d+$/);
  await expect(page.getByText('Сумма кредита').locator('..')).toContainText('3 000 000 ₽');
  await expect(page.locator('table tbody tr')).toHaveCount(12);
  await show(page, 'Страница кредита: сумма, ставка и график платежей', 2500);
  await reveal(page.locator('table').first());
  await pause(page, 2500);

  // 9. Смена роли: выход и вход аналитиком банка.
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await show(page, 'Теперь та же заявка глазами кредитного аналитика банка', 2500);
  await pickPersona(page, 'Мария Кредитова');
  await expect(page.getByRole('heading', { name: 'Очередь заявок' })).toBeVisible();

  // 10. Очередь и карточка заявки.
  await show(page, 'Очередь заявок: все отправленные клиентами заявки и их статусы', 2500);
  await page.getByText('Все', { exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: `№ ${number}` });
  await expect(row).toBeVisible();
  await reveal(row);
  await show(page, `Находим заявку № ${number} пекарни`, 1800);
  await caption(page, 'Открываем карточку заявки');
  await row.click();
  await expect(page.getByRole('heading', { name: 'Оценка заявки' })).toBeVisible();
  await show(page, 'Карточка оценки: балл, грейд, факторы, стоп-факторы, нагрузка и покрытие платежа прибылью', 3500);

  // 11. Трасса правил и воспроизведение решения.
  const trace = page.getByRole('heading', { name: 'Как принималось решение' });
  await reveal(trace);
  await show(page, 'Трасса правил: какие проверки прошла заявка и в каком порядке', 3000);
  await page.getByRole('button', { name: 'Воспроизвести решение' }).click();
  await expect(page.getByText(/^Совпадает:/)).toBeVisible();
  await show(page, 'Решение воспроизводится на сохранённых признаках — исход тот же', 3500);

  // 12. Симулятор кредитной политики.
  await page.getByRole('navigation').getByRole('link', { name: 'Кредитная политика' }).click();
  await expect(page).toHaveURL(/\/policy$/);
  await show(page, 'Кредитная политика: что будет с решениями, если изменить пороги', 2500);
  const coverage = page.getByRole('slider').nth(1);
  await coverage.focus();
  await caption(page, 'Поднимаем порог покрытия платежа прибылью: ×1,2 → ×2,0');
  for (let i = 0; i < 8; i++) await coverage.press('ArrowRight');
  await expect(page.getByText('Минимальное покрытие нового платежа прибылью: ×2,0')).toBeVisible();
  await pause(page, 1500);
  await page.getByRole('button', { name: 'Рассчитать' }).click();
  const simulated = page.getByText('С новыми порогами', { exact: true }).first();
  await expect(simulated).toBeVisible();
  await reveal(simulated);
  await show(page, 'Пересчёт по сохранённым заявкам: что изменилось бы при новых порогах, сами заявки не затронуты', 4500);
  await show(page, 'Сценарий завершён: от подбора кредита до выдачи и проверки решения', 2500);
});
