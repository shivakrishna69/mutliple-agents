/**
 * Browser tests (npm run test:e2e): the real frontend (Vite dev server) against the real backend on
 * a throwaway database, started by e2e/globalSetup.js. See "Browser tests" in frontend/README.md.
 */

import { defineConfig, devices } from '@playwright/test';

import { BACKEND_URL, FRONTEND_ORIGIN, FRONTEND_PORT } from './e2e/environment.js';

const isCi = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  // One worker: every test shares one backend, whose per-IP sign-up and login limits must not be exceeded.
  workers: 1,
  fullyParallel: false,
  forbidOnly: isCi,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: isCi ? [['github'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './e2e/globalSetup.js',
  use: {
    baseURL: FRONTEND_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run dev -- --port ${FRONTEND_PORT} --strictPort`,
    url: FRONTEND_ORIGIN,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { VITE_BACKEND_PROXY_TARGET: BACKEND_URL },
  },
});
