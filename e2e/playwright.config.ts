import { defineConfig, devices } from '@playwright/test';

// Сценарии демо-персон из README на поднятом стенде (по умолчанию — docker compose, nginx на :8080).
// Тесты идут по одному: сбой БКИ из сценария отказоустойчивости не должен задеть чужую заявку.
export default defineConfig({
  testDir: './tests',
  // Запись демо на видео и пояснение решения (стенд с включённой функцией) идут своими конфигами:
  // playwright.demo.config.ts (npm run demo) и playwright.llm.config.ts (npm run ui:llm).
  testIgnore: ['**/demo/**', '**/llm/**'],
  timeout: 180_000,
  expect: { timeout: 45_000 },
  workers: 1,
  // Без повторов: сценарии меняют данные стенда, повтор упавшего теста шёл бы уже по другим данным.
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    // Проверки — без анимаций, чтобы не ждать появления блоков; видео демо пишется своим конфигом, с движением.
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } }],
});
