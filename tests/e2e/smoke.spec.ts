import { expect, test, type Page } from '@playwright/test';

import { signIn } from './helpers/admin';
import { withTestDb } from './helpers/db';
import { LOG_NOT_WIRED_REASON, e2eLogFile, isExternalServer, logFileNotWired, readServerLog } from './helpers/logs';

// Smoke: the production server (`pnpm start` on 3411 against blog0_test, or the container of
// `pnpm test:container` via BLOG0_E2E_BASE_URL) renders the home page (the "Latest" list) with its
// stylesheet, answers the health check, logs structured lines, and sends the Phase 5 browser
// hardening (capability abuse-protection): a per-request nonce CSP that the pages actually satisfy
// (no CSP console message anywhere on the walk) and the static security headers on API + media.
// Runs last (after the listen walk), so a published article with an uploaded recording exists.

const SEEDED_ARTICLE = 'humans-are-software';

const STATIC_SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
} as const;

function nonceOf(csp: string | undefined): string {
  const m = /'nonce-([^']+)'/.exec(csp ?? '');
  expect(m, `CSP has a nonce source: ${csp}`).not.toBeNull();
  return m![1];
}

/** The newest uploaded recording (the listen walk's) and the slug of its article. */
async function latestRecording(): Promise<{ slug: string; key: string }> {
  const rows = await withTestDb(
    (sql) => sql<{ slug: string; key: string }[]>`
      select a.slug, m.storage_key as key
      from media_asset m join article a on a.id = m.article_id
      where m.kind = 'audio' and a.status = 'published'
      order by m.created_at desc limit 1`,
  );
  expect(rows, 'the listen walk left a published article with a recording').toHaveLength(1);
  return rows[0];
}

function collectCspMessages(page: Page): string[] {
  const messages: string[] = [];
  page.on('console', (msg) => {
    if (msg.text().includes('Content Security Policy')) messages.push(`${page.url()}: ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    if (err.message.includes('Content Security Policy')) messages.push(`${page.url()}: ${err.message}`);
  });
  return messages;
}

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

test('GET / carries a per-request nonce CSP (no HSTS over http) and the theme script runs with that nonce', async ({
  page,
  request,
}) => {
  const first = await request.get('/');
  const second = await request.get('/');
  const csp1 = first.headers()['content-security-policy'];
  const csp2 = second.headers()['content-security-policy'];
  expect(csp1).toContain("default-src 'self'");
  expect(csp1).toContain("script-src 'self' 'nonce-");
  expect(csp1).toContain("frame-ancestors 'none'");
  expect(nonceOf(csp1)).not.toBe(nonceOf(csp2));
  // The E2E servers run over http: HSTS and upgrade-insecure-requests are https-only.
  expect(first.headers()['strict-transport-security']).toBeUndefined();
  expect(csp1).not.toContain('upgrade-insecure-requests');
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) expect(first.headers()[name]).toBe(value);

  const response = await page.goto('/');
  const nonce = nonceOf(response?.headers()['content-security-policy']);
  const scriptNonce = await page.evaluate(
    () =>
      [...document.querySelectorAll<HTMLScriptElement>('script:not([src])')].find((s) => s.textContent?.includes('blog0.theme'))
        ?.nonce ?? null,
  );
  expect(scriptNonce).toBe(nonce);
  await expect(page.locator('html')).toHaveAttribute('data-theme', /^(light|dark)$/);
});

test('no Content Security Policy console message across home, article, deck, Listen, sign-in and the desk', async ({
  page,
}) => {
  const recording = await latestRecording();
  const messages = collectCspMessages(page);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Latest', exact: true })).toBeVisible();
  await page.goto(`/p/${SEEDED_ARTICLE}`);
  await expect(page.locator('.readbody')).toBeVisible();
  await page.goto(`/p/${SEEDED_ARTICLE}/tldr`);
  await expect(page.locator('.tdeck__slide').first()).toBeAttached();
  await page.goto(`/p/${recording.slug}/listen`);
  await expect(page.locator('section.listenview .audio')).toBeVisible();
  await signIn(page); // /admin/login → the desk
  await page.waitForLoadState('networkidle');

  expect(messages).toEqual([]);
});

test('/api/health and /media/<key> carry the static security headers; media keeps its range + cache headers', async ({
  request,
}) => {
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) expect(health.headers()[name]).toBe(value);

  const { key } = await latestRecording();
  const media = await request.get(`/media/${key}`);
  expect(media.status()).toBe(200);
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) expect(media.headers()[name]).toBe(value);
  expect(media.headers()['accept-ranges']).toBe('bytes');
  expect(media.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
});

test('the server writes a structured api.request log line for the health request', async ({ request }) => {
  test.skip(logFileNotWired(), LOG_NOT_WIRED_REASON);
  const response = await request.get('/api/health');
  const requestId = response.headers()['x-request-id'];
  const logFile = e2eLogFile();

  await expect
    .poll(() => readServerLog(logFile).some((l) => l.event === 'api.request' && l.request_id === requestId), {
      message: `api.request line for ${requestId} in ${logFile}`,
    })
    .toBe(true);
  const lines = readServerLog(logFile);

  // The server starts before global setup and the file is appended across runs: use the latest
  // boot. Locally Playwright starts it on 3411; an external server (the container listens on 3410
  // behind its port mapping) may use any port.
  expect(lines.findLast((l) => l.event === 'app.boot')).toMatchObject({
    level: 'info',
    port: isExternalServer() ? expect.any(Number) : Number(process.env.BLOG0_E2E_PORT) || 3411,
    site_slug: 'blog0',
  });
  expect(lines.find((l) => l.event === 'api.request' && l.request_id === requestId)).toMatchObject({
    method: 'GET',
    path: '/api/health',
    status: 200,
  });
});
