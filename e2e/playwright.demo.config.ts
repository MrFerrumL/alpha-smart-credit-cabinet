import { defineConfig, devices } from '@playwright/test';

// Запись основного сценария на видео: npm run demo. Отдельный конфиг, чтобы запись не попадала в обычный прогон
// (npm run ui) и не влияла на его результаты. Видео лежит в demo-results/<тест>/video.webm, рядом — timeline.json
// (такты с подписями) и presses.json (нажатия).
//
// Сценарий меняет данные стенда так же, как bakery из personas.spec.ts, поэтому запускать его нужно на чистом стенде
// или хотя бы на таком, где «Северная пекарня» ещё может получить одобрение на 3 млн ₽.
export default defineConfig({
  testDir: './tests/demo',
  // Отдельная папка: Playwright очищает outputDir при запуске, а test-results принадлежит обычному прогону.
  outputDir: './demo-results',
  // Человеческий темп задаёт сам сценарий (PACE в tests/demo/director.ts): курсор подлетает к элементу до нажатия,
  // подписи держатся по длине текста. slowMo не нужен — он добавлял паузу после действия, а не до него.
  timeout: 600_000,
  expect: { timeout: 60_000 },
  workers: 1,
  // Без повторов: сценарий меняет данные стенда, повтор шёл бы по другим данным и дал бы вторую запись.
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    // На видео анимации интерфейса нужны: появление блоков, плавная прокрутка.
    reducedMotion: 'no-preference',
    video: { mode: 'on', size: { width: 1280, height: 720 } },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } } }],
});
