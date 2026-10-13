import { loadEnvConfig } from '@next/env';
import { defineConfig, devices } from '@playwright/test';

import { E2E_STORAGE_DIR } from './tests/e2e/helpers/upload';

// E2E runs the SAME `pnpm start` as production, on port 3411, against blog0_test.
// `pnpm build` must have run first. BLOG0_E2E_BASE_URL points at an already-running server instead.
// Uploaded media go to var/storage-e2e (wiped by global-setup.ts), never the dev server's var/storage.

loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });

const E2E_PORT = '3411';
const externalBaseUrl = (process.env.BLOG0_E2E_BASE_URL ?? '').trim();
const baseURL = externalBaseUrl || `http://localhost:${E2E_PORT}`;
const testDatabaseUrl = (process.env.BLOG0_TEST_DATABASE_URL ?? '').trim();

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  // Designer-mode E2E has its own config and server (pnpm test:e2e:design).
  testIgnore: '**/designer-mode.spec.ts',
  globalSetup: './tests/e2e/global-setup.ts',
  outputDir: 'test-results/playwright',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: process.env.CI === 'true',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  timeout: 60_000,
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  // The walks share one database and run in this order (each needs the state the previous one
  // leaves): tldr → reader → listen → smoke → newsletter. Project dependencies pin it.
  projects: [
    { name: 'tldr', testMatch: 'tldr.spec.ts', use: { ...devices['Desktop Chrome'] } },
    { name: 'reader', testMatch: 'reader.spec.ts', dependencies: ['tldr'], use: { ...devices['Desktop Chrome'] } },
    { name: 'listen', testMatch: 'listen.spec.ts', dependencies: ['reader'], use: { ...devices['Desktop Chrome'] } },
    { name: 'smoke', testMatch: 'smoke.spec.ts', dependencies: ['listen'], use: { ...devices['Desktop Chrome'] } },
    { name: 'newsletter', testMatch: 'newsletter.spec.ts', dependencies: ['smoke'], use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        // Inherits process.env (Playwright merges `env` over it), so BLOG0_DIST_DIR=.next-gate
        // pnpm test:e2e serves the matching gate build instead of `.next`.
        command: 'pnpm start',
        port: Number(E2E_PORT),
        env: {
          BLOG0_PORT: E2E_PORT,
          BLOG0_DATABASE_URL: testDatabaseUrl,
          BLOG0_PUBLIC_BASE_URL: `http://localhost:${E2E_PORT}`,
          BLOG0_LOG_FILE: 'test-results/e2e-server.log',
          BLOG0_STORAGE_DIR: E2E_STORAGE_DIR,
          // Newsletter: the recording stubs (capabilities newsletter-list / newsletter-issues) — an
          // already-set (even empty) variable is never overridden by .env, so a configured SMTP relay
          // or Listmonk in .env is never used by the suite.
          BLOG0_SMTP_HOST: '',
          BLOG0_NEWSLETTER_SENDER: 'stub',
        },
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
