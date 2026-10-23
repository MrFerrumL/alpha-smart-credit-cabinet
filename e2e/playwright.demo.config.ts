import { defineConfig, devices } from '@playwright/test';

// Запись основного сценария на видео: npm run demo. Отдельный конфиг, чтобы запись не попадала в обычный прогон
// (npm run ui) и не влияла на его результаты. Видео лежит в demo-results/<тест>/video.webm.
//
// Сценарий меняет данные стенда так же, как bakery из personas.spec.ts, поэтому запускать его нужно на чистом стенде
// или хотя бы на таком, где «Северная пекарня» ещё может получить одобрение на 3 млн ₽.
export default defineConfig({
  testDir: './tests/demo',
  // Отдельная папка: Playwright очищает outputDir при запуске, а test-results принадлежит обычному прогону.
  outputDir: './demo-results',
  // Человеческий темп: пауза после каждого действия, плюс паузы на ключевых экранах и ожидание конвейера.
  timeout: 600_000,
  expect: { timeout: 60_000 },
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    launchOptions: { slowMo: 300 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } } }],
});
