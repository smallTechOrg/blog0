import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { e2eAdmin, originOf, signIn } from './helpers/admin';
import { audioFixtureMeta, expectRange206, uploadSampleMp3 } from './helpers/upload';
import { DESIGN_E2E_PORT, DESIGN_E2E_SERVER_LOG, DESIGN_E2E_STORAGE_DIR, DESIGNER_ENV } from './designer.global-setup';

// Designer mode end to end (spec/capabilities/designer-mode.md → Success Criteria): the site
// served by `pnpm dev:design` on embedded PGlite from a clean state, with no OpenRouter key and no
// session secret from .env. Runs only under playwright.design.config.ts (project "designer"): the
// main E2E config (`pnpm test:e2e`, Postgres, `pnpm start` on 3411) must not run it.

const SLUG = 'humans-are-software';
const TITLE = 'Humans are Software';
const SEED_TITLES = [
  'Humans are Software',
  'Before you become an AI company you will need to become a Tech company',
  'Artefact Driven Development',
  'AI Will Destroy the World',
  'AI is Expensive',
];
const EDITORS_DISCLOSURE = 'Lines selected by the editors, verbatim from the article.';
const NO_KEY_NOTICE = 'No OpenRouter key configured';
/** The upload round trip uses another seeded article, so the seeded sample on SLUG stays as seeded. */
const UPLOAD_SLUG = 'ai-is-expensive';

interface DeckFixture {
  slug: string;
  lines: { text: string }[];
}
const FIXTURE = JSON.parse(readFileSync(`src/server/seed/decks/${SLUG}.json`, 'utf8')) as DeckFixture;
const FIXTURE_LINES = FIXTURE.lines.map((l) => l.text);

/** The designer admin dev:design generated (handed over by designer.global-setup.ts). */
const designer = () => e2eAdmin(DESIGNER_ENV, 'Designer');

test.describe.configure({ mode: 'serial' });

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'designer', 'designer-mode E2E runs only via pnpm test:e2e:design');
});

test.describe('designer mode: pnpm dev:design on embedded PGlite, no .env values', () => {
  test('health answers db ok on the pglite engine; the boot log names pglite and no Jev key', async ({ request }) => {
    const res = await request.get('/api/health');

    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: { status: 'ok', db: 'ok', dbEngine: 'pglite' } });

    const boots = readFileSync(DESIGN_E2E_SERVER_LOG, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.event === 'app.boot');
    expect(boots.length).toBeGreaterThan(0);
    expect(boots.at(-1)).toMatchObject({ db_engine: 'pglite', port: DESIGN_E2E_PORT });
    // Exactly one designer credentials line in the whole console (printed once, at first boot).
    const serverConsole = readFileSync(DESIGN_E2E_SERVER_LOG, 'utf8');
    expect(serverConsole.match(/^designer admin: designer@blog0\.local \/ /gm)).toHaveLength(1);
    expect(serverConsole).toMatch(/^5 posts: 5 created$/m);
    expect(serverConsole).toMatch(/^decks: 5 seeded \(0 calls\)$/m);
    expect(serverConsole).toMatch(/^listen: sample recording seeded on humans-are-software \(estimated timing\)$/m);
    // The banner: URL, admin login, the (only) credentials line, how to start over.
    expect(serverConsole).toMatch(new RegExp(`^site: +http://localhost:${DESIGN_E2E_PORT}$`, 'm'));
    expect(serverConsole).toMatch(/^designer admin: designer@blog0\.local \/ \S+ +\(new — shown once; also saved in var\/pglite-e2e\.designer-admin\.txt\)$/m);
    // …naming THIS run's dirs (the designer's defaults are var/pglite var/storage …).
    expect(serverConsole).toMatch(/^start over: +.*rm -rf var\/pglite-e2e var\/storage-design-e2e var\/pglite-session-secret var\/pglite-e2e\.designer-admin\.txt$/m);
  });

  test('home shows Featured Editorial and the 5 seeded articles', async ({ page }) => {
    const res = await page.goto('/');

    expect(res?.status()).toBe(200);
    // Designer mode is `next dev`: the nonce CSP is production-only (src/proxy.ts) — none here.
    expect(res!.headers()['content-security-policy']).toBeUndefined();
    await expect(page.getByRole('heading', { name: 'Featured Editorial', exact: true })).toBeVisible();
    for (const title of SEED_TITLES) {
      await expect(page.getByRole('link', { name: title }).first()).toBeAttached();
    }
  });

  test('an article renders in Read view with every fixture deck line verbatim in its body', async ({ page }) => {
    const res = await page.goto(`/p/${SLUG}`);

    expect(res?.status()).toBe(200);
    await expect(page.locator('.readhead')).toContainText(TITLE);
    const body = page.locator('.readbody');
    await expect(body).toBeVisible();
    const text = (await body.innerText()).replace(/\s+/g, ' ');
    for (const line of FIXTURE_LINES) expect(text).toContain(line);
  });

  test('/p/<slug>/tldr plays the fixture deck (4–8 verbatim lines) with the editors disclosure', async ({ page }) => {
    expect(FIXTURE_LINES.length).toBeGreaterThanOrEqual(4);
    expect(FIXTURE_LINES.length).toBeLessThanOrEqual(8);

    await page.goto(`/p/${SLUG}/tldr`);

    const deck = page.locator('.tdeck');
    await expect(deck).toBeVisible();
    await expect(deck.locator('.tdeck__big')).toHaveText(TITLE);
    await expect(deck.locator('.tdeck__note')).toHaveText(EDITORS_DISCLOSURE);
    const segs = deck.locator('.tdeck__seg');
    await expect(segs).toHaveCount(FIXTURE_LINES.length + 1);
    await expect(segs.nth(0)).toHaveAttribute('aria-selected', 'true');
    // It plays on its own: the intro holds a few seconds, then advances to the first line.
    await expect(segs.nth(1)).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });
    await expect(deck.locator('.tdeck__slide[aria-hidden="false"]')).toContainText(FIXTURE_LINES[0]);
    await deck.getByRole('button', { name: 'Pause the summary' }).click();
    for (let i = 1; i < FIXTURE_LINES.length; i += 1) {
      await page.keyboard.press('ArrowRight');
      await expect(segs.nth(i + 1)).toHaveAttribute('aria-selected', 'true');
      await expect(deck.locator('.tdeck__slide[aria-hidden="false"]')).toContainText(FIXTURE_LINES[i]);
    }
  });

  test('the seeded sample recording plays: /p/<slug>/listen shows the player, /media answers 206 (estimated timing)', async ({ page }) => {
    const audioMeta = audioFixtureMeta();
    const api = await page.request.get(`/api/public/articles/${SLUG}/listen`);
    expect(api.status()).toBe(200);
    const listen = ((await api.json()) as { data: { audio: { url: string; durationMs: number }; timing: string; marks: unknown[] } }).data;
    expect(listen.timing).toBe('estimated');
    expect(listen.marks.length).toBeGreaterThan(0);
    expect(Math.abs(listen.audio.durationMs - audioMeta.mp3.durationMs)).toBeLessThanOrEqual(500);
    const key = listen.audio.url.replace(/^\/media\//, '');
    expect(existsSync(path.join(DESIGN_E2E_STORAGE_DIR, key)), 'seeded file in the storage dir').toBe(true);
    await expectRange206(page.request, listen.audio.url, audioMeta.mp3.bytes);

    const res = await page.goto(`/p/${SLUG}/listen`);
    expect(res?.status()).toBe(200);
    const view = page.locator('section.listenview');
    await expect(view.locator('.audio')).toBeVisible();
    await expect(view.locator('audio source')).toHaveAttribute('src', listen.audio.url);
    await view.getByRole('button', { name: 'Play' }).click();
    await expect.poll(() => view.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.3);
    await expect(view.locator('.para.is-live')).toHaveCount(1);
  });

  test('the generated designer admin signs in; the desk lists 5 published articles with TLDR ready', async ({ page }) => {
    await signIn(page, designer());

    const rows = page.locator('.admin-table tbody tr');
    await expect(rows).toHaveCount(5);
    await expect(page.locator('.admin-table .spill--published')).toHaveCount(5);
    await expect(page.locator('.admin-table .fchip[data-kind="tldr"][data-status="ready"]')).toHaveCount(5);
  });

  test('a wrong password is refused for the designer admin', async ({ page }) => {
    await page.goto('/admin/login');
    await page.getByLabel('Email').fill(designer().email);
    await page.getByLabel('Password').fill('not-the-designer-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.locator('#admin-login-error')).toHaveText('Email or password is incorrect.');
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test('with no OpenRouter key the TLDR tab shows the notice and Generate is disabled; the API refuses', async ({ page }, testInfo) => {
    await signIn(page, designer());
    await page.getByRole('link', { name: TITLE }).click();
    await expect(page).toHaveURL(/\/admin\/articles\/[^/]+$/);
    const articleId = new URL(page.url()).pathname.split('/').pop()!;

    await page.getByRole('tab', { name: /^TLDR/ }).click();

    const panel = page.locator('#panel-tldr');
    await expect(panel.getByTestId('jev-no-key')).toContainText(NO_KEY_NOTICE);
    await expect(panel.getByTestId('jev-no-key')).toContainText('BLOG0_OPENROUTER_API_KEY');
    // The primary Generate button ("Generate with Jev", or "Regenerate" once a deck exists) is disabled.
    const generate = panel.locator('.tldrtab__head').getByRole('button', { name: /^(Generate with Jev|Regenerate)$/ });
    await expect(generate).toBeDisabled();
    await expect(generate).toHaveAttribute('title', NO_KEY_NOTICE);
    await expect(page.locator('#tab-tldr .tabchip')).toHaveText('ready');

    // The server refuses too, before any AI call or generation row (README: 503 LLM_NOT_CONFIGURED).
    const origin = { origin: originOf(testInfo) };
    const detail = await page.request.get(`/api/admin/articles/${articleId}`);
    expect(detail.status()).toBe(200);
    const revisionId = ((await detail.json()) as { data: { article: { currentRevision: { id: string } } } }).data.article
      .currentRevision.id;
    const res = await page.request.post(`/api/admin/articles/${articleId}/tldr/generate`, {
      headers: origin,
      data: { revisionId },
    });
    expect(res.status()).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: 'LLM_NOT_CONFIGURED' } });
  });

  test('an mp3 upload streams back from /media/<key> (206) on PGlite; the file lands in the storage dir and Remove deletes it', async ({ page }, testInfo) => {
    const origin = originOf(testInfo);
    const audioMeta = audioFixtureMeta();
    await signIn(page, designer());
    const list = await page.request.get('/api/admin/articles');
    expect(list.status()).toBe(200);
    const articles = ((await list.json()) as { data: { articles: { id: string; slug: string }[] } }).data.articles;
    const article = articles.find((a) => a.slug === UPLOAD_SLUG);
    expect(article, `seeded article ${UPLOAD_SLUG}`).toBeTruthy();

    const uploaded = await uploadSampleMp3(page.request, article!.id, origin);

    expect(uploaded.status).toBe('ready');
    expect(uploaded.audio).toMatchObject({ mimeType: 'audio/mpeg', bytes: audioMeta.mp3.bytes, url: `/media/${uploaded.audio.key}` });
    expect(Math.abs(uploaded.audio.durationMs - audioMeta.mp3.durationMs)).toBeLessThanOrEqual(500);
    const stored = path.join(DESIGN_E2E_STORAGE_DIR, uploaded.audio.key);
    expect(existsSync(stored), `${stored} exists`).toBe(true);
    const head = await expectRange206(page.request, uploaded.audio.url, audioMeta.mp3.bytes);
    expect(head.equals(readFileSync(stored).subarray(0, 2))).toBe(true);

    // Removing the (never published) recording deletes the file.
    const removed = await page.request.delete(`/api/admin/articles/${article!.id}/audio`, { headers: { origin } });
    expect(removed.status(), await removed.text()).toBe(200);
    expect(((await removed.json()) as { data: { listen: { status: string } } }).data.listen.status).toBe('missing');
    expect(existsSync(stored)).toBe(false);
    expect((await page.request.get(uploaded.audio.url)).status()).toBe(404);
  });
});
