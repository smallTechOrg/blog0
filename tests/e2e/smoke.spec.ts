import { existsSync, readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

// Smoke: the production server (`pnpm start` on 3411 against blog0_test) renders the home page
// (Phase 1: the "Latest" list) with its stylesheet and answers the health check.

test('home page renders the Latest list with a non-empty linked stylesheet', async ({ page, request }) => {
  const response = await page.goto('/');

  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Latest', exact: true })).toBeVisible();
  const hrefs = await page.locator('link[rel="stylesheet"]').evaluateAll((links) =>
    links.map((l) => (l as HTMLLinkElement).href),
  );
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of hrefs) {
    const css = await request.get(href);
    expect(css.status()).toBe(200);
    const text = await css.text();
    expect(text.trim().length).toBeGreaterThan(0);
  }
});

test('health endpoint reports the test database as reachable', async ({ request }) => {
  const response = await request.get('/api/health');

  expect(response.status()).toBe(200);
  expect(response.headers()['x-request-id']).toBeTruthy();
  const body = await response.json();
  expect(body).toMatchObject({ ok: true, data: { status: 'ok', db: 'ok', version: '0.1.0' } });
  expect(typeof body.data.dbLatencyMs).toBe('number');
  expect(typeof body.data.uptimeSec).toBe('number');
});

test('the server writes a structured api.request log line for the health request', async ({ request }) => {
  test.skip(Boolean(process.env.BLOG0_E2E_BASE_URL), 'log file is only wired for the locally started server');
  const response = await request.get('/api/health');
  const requestId = response.headers()['x-request-id'];

  const logFile = 'test-results/e2e-server.log';
  await expect.poll(() => existsSync(logFile)).toBe(true);
  const lines = readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  // The web server starts before global setup and the file is appended across runs: use the latest boot.
  expect(lines.findLast((l) => l.event === 'app.boot')).toMatchObject({ level: 'info', port: 3411, site_slug: 'blog0' });
  expect(lines.find((l) => l.event === 'api.request' && l.request_id === requestId)).toMatchObject({
    method: 'GET',
    path: '/api/health',
    status: 200,
  });
});
