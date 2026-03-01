import { defineConfig } from '@playwright/test';

const PORT = Number(process.env['PLAYWRIGHT_PORT'] ?? '3100');
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? `http://127.0.0.1:${PORT}`;
const PROCESS_ENV_STRINGS = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ),
);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  reporter: 'list',
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec next dev --port ${PORT} --hostname 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
    env: {
      ...PROCESS_ENV_STRINGS,
      ARCHI_NAVI_CHAT_MOCK: '1',
      NEXT_DISABLE_GOOGLE_FONTS: '1',
      HOME: '/Users/spark',
      PGLITE_DATA_DIR: '.archi-navi/e2e-data',
      MIGRATIONS_FOLDER: '../../packages/db/src/migrations',
    },
  },
});
