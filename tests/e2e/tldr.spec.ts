import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { e2eAdmin, signInThroughForm } from './helpers/admin';
import { markdownPlainText, readE2eArticle } from './helpers/article-text';
import { generationRows } from './helpers/db';
import { jevKeyPlan, PENDING_KEY_TITLE } from './helpers/jev-key';
import { LOG_NOT_WIRED_REASON, apiRequests, logFileNotWired, readServerLog } from './helpers/logs';

// TLDR golden path (capability jev-tldr; spec/roadmap.md "How the user tests it"): sign in, paste
// an article, live preview, save, Generate with Jev (real OpenRouter call — or a visible PENDING
// KEY skip and the hand-pick fallback), hand-edit + preview + save the deck, publish, read it
// live, play the TLDR deck, then edit a deck sentence → stale, the live page keeps the old deck,
// nothing regenerates. Finally the server log carries the api.request / llm.call lines.
//
// One browser context is shared by the serial steps so the journey reads top to bottom.

const TITLE = 'Tech Company First — an E2E walk';
const DEK = 'Why the last 1% still needs people who understand the software.';
const TOPIC = 'Op-Ed';
const MARKDOWN = readE2eArticle();
const ARTICLE_TEXT = markdownPlainText(MARKDOWN);
const DISCLOSURE = {
  jev: 'Lines selected by Jev (AI)',
  editors: 'Lines selected by the editors, verbatim from the article.',
};

const keyPlan = jevKeyPlan();
const pendingKey = keyPlan !== 'real';

interface Journey {
  context: BrowserContext;
  page: Page;
  articleId: string;
  slug: string;
  /** True once the real Generate step produced a deck from Jev. */
  generatedByJev: boolean;
  /** Deck lines as published (in order). */
  publishedLines: string[];
  generationCount: number;
}

const j: Partial<Journey> = { generatedByJev: false };

function journey(): Journey {
  return j as Journey;
}

async function deckTexts(page: Page): Promise<string[]> {
  return page.locator('#panel-tldr .deck__text').allInnerTexts();
}

test.describe.configure({ mode: 'serial' });

test.describe('golden path: paste → TLDR → publish → read', () => {
  test.beforeAll(async ({ browser }, testInfo) => {
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    j.context = context;
    j.page = await context.newPage();
  });

  test.afterAll(async () => {
    await j.context?.close();
  });

  test('an unauthenticated request to an admin API answers 401 UNAUTHENTICATED', async ({ playwright }, testInfo) => {
    const anon = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });

    const res = await anon.get('/api/admin/articles');

    expect(res.status()).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    await anon.dispose();
  });

  test('/admin redirects to sign-in; signing in lands on the desk (the 5 seeded posts from global setup)', async () => {
    const { page } = journey();

    await page.goto('/admin');

    await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin$/);
    await signInThroughForm(page);
    // Global setup seeds the 5 design articles (seedPosts) before this walk.
    await expect(page.locator('.admin-table tbody tr')).toHaveCount(5);
    await expect(page.locator('.admin-table__title', { hasText: 'Humans are Software' })).toBeVisible();
  });

  test('New article → paste Markdown → the editor shows "Saved · rev 1" and a live Read preview', async () => {
    const { page } = journey();
    await page.getByRole('link', { name: 'New article' }).click();
    await expect(page.getByRole('heading', { name: 'New article' })).toBeVisible();

    await page.getByLabel('Title').fill(TITLE);
    await page.getByLabel('Topic').fill(TOPIC);
    await page.getByLabel('Dek').fill(DEK);
    await page.getByLabel(/^Markdown/).fill(MARKDOWN);
    await page.getByRole('button', { name: 'Create' }).click();

    await expect(page).toHaveURL(/\/admin\/articles\/[0-9a-f-]{36}$/);
    j.articleId = page.url().split('/').pop()!;
    await expect(page.locator('.pubbar__state')).toHaveText('Saved · rev 1');
    await expect(page.getByLabel('Markdown', { exact: true })).toHaveValue(MARKDOWN);
    const preview = page.getByRole('region', { name: 'Live preview' });
    await expect(preview.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
    await expect(preview.locator('.prose').getByRole('heading', { name: 'The 1% in practice' })).toBeVisible();
    await expect(preview.locator('.prose table')).toBeVisible();
    await expect(preview.locator('.prose table td', { hasText: 'Debugging a production outage' })).toBeVisible();
    // Shiki: a highlighted <pre> with per-token coloured spans (dual-theme CSS variables).
    const code = preview.locator('.prose pre.shiki');
    await expect(code).toContainText('export function share');
    expect(await code.locator('span[style*="--shiki-light"]').count()).toBeGreaterThan(3);
    await expect(preview.locator('.footnotes')).toContainText('Notes');
    await expect(preview.locator('.footnotes')).toContainText('Production is where the 1% problems live');
    await expect(preview.locator('figure.fig')).toHaveCount(2);
    await expect(preview.locator('figure.fig .fig__k', { hasText: 'Two companies, same market' })).toBeVisible();
    await expect(preview.locator('.preview__stats')).toContainText(/eligible sentences/);

    const res = await page.request.get(`/api/admin/articles/${j.articleId}`);
    j.slug = (await res.json()).data.article.slug as string;
    expect(j.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test('the draft article URL answers 404 before publishing', async () => {
    const { page, slug } = journey();

    const res = await page.request.get(`/p/${slug}`);

    expect(res.status()).toBe(404);
    expect(await res.text()).toContain('That article isn’t here.');
  });

  test(`Generate with Jev (real OpenRouter call)${pendingKey ? ` — ${PENDING_KEY_TITLE}` : ''}`, async () => {
    test.skip(keyPlan === 'pending-skip', PENDING_KEY_TITLE);
    expect(keyPlan, 'CI=true requires a real BLOG0_OPENROUTER_API_KEY (PENDING KEY is a failure under CI)').toBe('real');
    test.setTimeout(180_000);
    const { page, articleId } = journey();
    await page.getByRole('tab', { name: /^TLDR/ }).click();
    await expect(page.locator('#panel-tldr .tldrtab__empty')).toContainText('No deck yet.');

    await page.getByRole('button', { name: 'Generate with Jev' }).click();

    await expect(page.locator('#panel-tldr .admin-ok')).toContainText(/Jev picked \d+ lines/, { timeout: 150_000 });
    const lines = await deckTexts(page);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.length).toBeLessThanOrEqual(8);
    const articleLines = await page.locator('#panel-tldr .picker__line span').allInnerTexts();
    for (const line of lines) {
      expect(articleLines, `deck line is one of the article's sentences: ${line}`).toContain(line);
      expect(ARTICLE_TEXT, 'deck line is verbatim from the article').toContain(line);
    }
    const reasons = await page.locator('#panel-tldr .deck__reason').allInnerTexts();
    expect(reasons).toHaveLength(lines.length);
    for (const reason of reasons) expect(reason).toMatch(/^Jev: \S.{3,}/);
    await expect(page.locator('#panel-tldr .tldrtab__meta')).toHaveText(
      /^Jev · \S+ · \S+ · [\d,]+ tokens · (\$\d+\.\d{4}|cost n\/a) · /,
    );
    const rows = await generationRows(articleId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'succeeded' });
    expect(rows[0].total_tokens).toBeGreaterThan(0);
    j.generatedByJev = true;
  });

  test('hand-edit the deck (remove, add from the article, move up), preview it, save it', async () => {
    const { page } = journey();
    const panel = page.locator('#panel-tldr');
    if (!(await panel.isVisible())) await page.getByRole('tab', { name: /^TLDR/ }).click();
    const picker = panel.locator('.picker input[type="checkbox"]');
    await expect(picker.first()).toBeVisible();
    const total = await picker.count();
    expect(total).toBeGreaterThan(8);

    if (!j.generatedByJev) {
      // Hand-pick fallback (spec/agent.md §6): five lines spread through the article.
      for (const i of [0, 3, 6, 9, 12]) await picker.nth(i).check();
      await expect(panel.locator('.deck__item')).toHaveCount(5);
      for (const reason of await panel.locator('.deck__reason').allInnerTexts()) expect(reason).toBe('Added by you');
    }
    const before = await deckTexts(page);

    // Remove one.
    await panel.getByRole('button', { name: 'Remove line 2' }).click();
    await expect(panel.locator('.deck__item')).toHaveCount(before.length - 1);
    expect(await deckTexts(page)).not.toContain(before[1]);
    // Add one from the article lines (the last unchecked sentence).
    const unchecked = panel.locator('.picker__line:not(.is-on)');
    const added = (await unchecked.last().locator('span').innerText()).trim();
    await unchecked.last().locator('input').check();
    await expect(panel.locator('.deck__item')).toHaveCount(before.length);
    const afterAdd = await deckTexts(page);
    expect(afterAdd).toContain(added);
    await expect(panel.locator('.deck__item', { hasText: added }).locator('.deck__reason')).toHaveText('Added by you');
    // Move one up.
    await panel.getByRole('button', { name: 'Move line 3 up' }).click();
    const afterMove = await deckTexts(page);
    expect(afterMove[1]).toBe(afterAdd[2]);
    expect(afterMove[2]).toBe(afterAdd[1]);
    for (const line of afterMove) expect(ARTICLE_TEXT).toContain(line);

    // Preview deck: the real TldrDeck plays the unsaved draft.
    await panel.getByRole('button', { name: 'Preview deck' }).click();
    const deck = page.locator('.tdeck');
    await expect(deck).toBeVisible();
    await expect(deck.locator('.tdeck__big')).toHaveText(TITLE);
    await expect(deck.locator('.tdeck__note')).toContainText(j.generatedByJev ? DISCLOSURE.jev : DISCLOSURE.editors);
    await expect(deck.locator('.tdeck__seg')).toHaveCount(afterMove.length + 1);
    await page.keyboard.press('ArrowRight');
    await expect(deck.locator('.tdeck__slide[aria-hidden="false"]')).toContainText(afterMove[0]);
    await page.keyboard.press('Escape');
    await expect(deck).toBeHidden();

    await panel.getByRole('button', { name: 'Save deck' }).click();
    await expect(panel.getByText('Deck saved.')).toBeVisible();
    expect(await deckTexts(page)).toEqual(afterMove);
    await expect(page.locator('#tab-tldr .tabchip')).toHaveText('ready');
    j.publishedLines = afterMove;
  });

  test('Publish → View live shows the Read view with title, body and published line', async () => {
    const { page, context, slug } = journey();

    await page.getByRole('button', { name: 'Publish', exact: true }).click();

    const viewLive = page.getByRole('link', { name: 'View live ↗' });
    await expect(viewLive).toBeVisible();
    const [live] = await Promise.all([context.waitForEvent('page'), viewLive.click()]);
    await live.waitForLoadState();
    await expect(live).toHaveURL(new RegExp(`/p/${slug}$`));
    await expect(live.locator('.readhead h1')).toHaveAttribute('aria-label', TITLE);
    await expect(live.locator('.readhead .dek')).toHaveText(DEK);
    await expect(live.locator('.readhead__by')).toContainText(e2eAdmin().displayName);
    await expect(live.locator('.readhead__by')).toContainText(/\d{1,2} [A-Z][a-z]{2} \d{4}/);
    await expect(live.locator('.readbody')).toContainText('Humans are creatures of convenience.');
    await expect(live.locator('.readbody table')).toBeVisible();
    await live.close();
  });

  test('the article page links non-empty stylesheets that carry the deck styles', async () => {
    const { page, slug } = journey();
    await page.goto(`/p/${slug}`);

    const hrefs = await page
      .locator('link[rel="stylesheet"]')
      .evaluateAll((links) => links.map((l) => (l as HTMLLinkElement).href));

    expect(hrefs.length).toBeGreaterThan(0);
    const bodies: string[] = [];
    for (const href of hrefs) {
      const css = await page.request.get(href);
      expect(css.status(), href).toBe(200);
      const text = await css.text();
      expect(text.trim().length, href).toBeGreaterThan(0);
      bodies.push(text);
    }
    expect(bodies.some((b) => b.includes('.tdeck__track'))).toBe(true);
    expect(bodies.some((b) => b.includes('.modedock'))).toBe(true);
  });

  test('TLDR in the capsule plays the published deck at /p/<slug>/tldr; reload keeps it; Esc closes', async () => {
    const { page, slug, publishedLines } = journey();
    await page.goto(`/p/${slug}`);

    await page.locator('.modedock').getByRole('tab', { name: /^TLDR — \d+ min$/ }).click();

    await expect(page).toHaveURL(new RegExp(`/p/${slug}/tldr$`));
    const deck = page.locator('.tdeck');
    await expect(deck).toBeVisible();
    await expect(deck.locator('.tdeck__big')).toHaveText(TITLE);
    await expect(deck.locator('.tdeck__note')).toContainText(j.generatedByJev ? DISCLOSURE.jev : DISCLOSURE.editors);
    const segs = deck.locator('.tdeck__seg');
    await expect(segs).toHaveCount(publishedLines.length + 1);
    await expect(segs.nth(0)).toHaveAttribute('aria-selected', 'true');
    // The deck's own mode switcher is the capsule: no recording → Listen disabled with its copy.
    const deckListen = deck.locator('.tdeck__foot').getByRole('tab', { name: 'Listen — no recording yet' });
    await expect(deckListen).toBeDisabled();
    await expect(deckListen).toHaveAttribute('title', 'No recording yet');
    // Auto-advance: the intro holds 3.8 s, then the deck moves on with no input.
    await expect(segs.nth(1)).toHaveAttribute('aria-selected', 'true', { timeout: 8_000 });
    await expect(deck.locator('.tdeck__slide[aria-hidden="false"]')).toContainText(publishedLines[0]);
    await deck.getByRole('button', { name: 'Pause the summary' }).click();
    await page.keyboard.press('ArrowRight');
    await expect(segs.nth(2)).toHaveAttribute('aria-selected', 'true');
    await expect(deck.locator('.tdeck__slide[aria-hidden="false"]')).toContainText(publishedLines[1]);

    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/p/${slug}/tldr$`));
    await expect(page.locator('.tdeck')).toBeVisible();
    await expect(page.locator('.tdeck .tdeck__big')).toHaveText(TITLE);

    await page.keyboard.press('Escape');
    await expect(page.locator('.tdeck')).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/p/${slug}$`));
    await expect(page.locator('.modedock')).toBeVisible();
  });

  test('editing a deck sentence makes TLDR stale; the live page keeps the old deck; nothing regenerates', async () => {
    const { page, articleId, slug, publishedLines } = journey();
    const generationsBefore = (await generationRows(articleId)).length;
    expect(generationsBefore).toBe(j.generatedByJev ? 1 : 0);
    await page.goto(`/admin/articles/${articleId}`);
    const editor = page.getByLabel('Markdown', { exact: true });
    await expect(editor).toHaveValue(MARKDOWN);
    const target = publishedLines.find((l) => MARKDOWN.includes(l));
    expect(target, 'some deck line appears verbatim in the Markdown source').toBeTruthy();
    const edited = target!.replace(/(\w+)(\W*)$/, 'nowadays$2');
    expect(edited).not.toBe(target);

    await editor.fill(MARKDOWN.replace(target!, edited));
    await expect(page.locator('.pubbar__state')).toHaveText('Unsaved changes');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(page.locator('.pubbar__state')).toHaveText('Saved · rev 2');
    await expect(page.locator('#tab-tldr .tabchip')).toHaveText('stale');
    await page.getByRole('tab', { name: /^TLDR/ }).click();
    await expect(page.locator('#panel-tldr .tldrtab__stale')).toBeVisible();
    // sid = pid + '-s' + k and pid hashes the paragraph text (spec/architecture.md §4), so the edited
    // line — and any deck line sharing its paragraph — is flagged.
    await expect(
      page.locator('#panel-tldr .deck__item', { hasText: target! }).locator('.deck__missing'),
    ).toHaveText('No longer in the article');
    const live = await page.context().newPage();
    await live.goto(`/p/${slug}/tldr`);
    const deck = live.locator('.tdeck');
    await expect(deck).toBeVisible();
    await expect(deck.locator('.tdeck__seg')).toHaveCount(publishedLines.length + 1);
    await expect(deck.locator('.tdeck__slide').filter({ hasText: target! })).toHaveCount(1);
    await expect(deck.locator('.tdeck__slide').filter({ hasText: edited })).toHaveCount(0);
    await expect(live.locator('.readbody')).toContainText(target!);
    await live.close();
    expect((await generationRows(articleId)).length).toBe(generationsBefore);
  });

  test('the server log has api.request lines for save, publish (and generate + llm.call when Jev ran)', async () => {
    test.skip(logFileNotWired(), LOG_NOT_WIRED_REASON);
    const { articleId } = journey();

    const lines = readServerLog();

    expect(apiRequests(lines, 'POST', '/api/admin/articles').some((l) => l.status === 201 || l.status === 200)).toBe(true);
    expect(apiRequests(lines, 'PATCH', `/api/admin/articles/${articleId}`)).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 200, latency_ms: expect.any(Number) })]),
    );
    expect(apiRequests(lines, 'PUT', `/api/admin/articles/${articleId}/tldr`)).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 200 })]),
    );
    expect(apiRequests(lines, 'POST', `/api/admin/articles/${articleId}/publish`)).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 200, user_id: expect.any(String) })]),
    );
    const generate = apiRequests(lines, 'POST', `/api/admin/articles/${articleId}/tldr/generate`);
    if (!j.generatedByJev) {
      expect(generate).toHaveLength(0);
      return;
    }
    expect(generate).toHaveLength(1);
    expect(generate[0]).toMatchObject({ status: 200 });
    const calls = lines.filter((l) => l.event === 'llm.call' && l.request_id === generate[0].request_id);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.at(-1)).toMatchObject({
      model: expect.any(String),
      prompt_version: expect.any(String),
      latency_ms: expect.any(Number),
      outcome: 'ok',
    });
  });
});
