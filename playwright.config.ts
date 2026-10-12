import { loadEnvConfig } from '@next/env';
import { defineConfig, devices } from '@playwright/test';

// E2E runs the SAME `pnpm start` as production, on port 3411, against blog0_test.
// `pnpm build` must have run first. BLOG0_E2E_BASE_URL points at an already-running server instead.

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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: 'pnpm start',
        port: Number(E2E_PORT),
        env: {
          BLOG0_PORT: E2E_PORT,
          BLOG0_DATABASE_URL: testDatabaseUrl,
          BLOG0_PUBLIC_BASE_URL: `http://localhost:${E2E_PORT}`,
          BLOG0_LOG_FILE: 'test-results/e2e-server.log',
        },
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
