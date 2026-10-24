import { defineConfig, devices } from '@playwright/test';

// Пояснение решения простыми словами: npm run ui:llm. Нужен стенд с включённой функцией и фейковой моделью из
// эмулятора (LLM_ENABLED=true, LLM_BASE_URL=http://mocks:8001/llm/v1 — так делает CI). Отдельный конфиг, как у записи
// демо: обычный прогон (npm run ui) идёт с выключенной функцией и эти тесты не берёт.
export default defineConfig({
  testDir: './tests/llm',
  // Свои папки: Playwright очищает outputDir при запуске, а test-results и playwright-report — у обычного прогона.
  outputDir: './llm-results',
  timeout: 180_000,
  expect: { timeout: 45_000 },
  workers: 1,
  // Без повторов: сценарии меняют данные стенда и включают сбои модели в общем эмуляторе.
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'llm-report' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } }],
});
