import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { createArticleApi, originOf, publishApi, signIn } from './helpers/admin';
import { withTestDb } from './helpers/db';
import {
  BRAND,
  SHARE_OPTIONS,
  SHARE_STATUS,
  clearClipboard,
  expectedParagraphText,
  grantClipboard,
  menuOptionLabels,
  nativeShareCalls,
  plainParagraphId,
  readClipboard,
  stubNativeShare,
} from './helpers/share';

// Reader walk (capabilities reader-site, article-reading, paragraph-share; full path): the public
// site under the brand blog0 with the 5 seeded design articles and their fixture decks (seeded by
// global-setup.ts — 0 LLM calls on this walk). Home (wordmark, About, Featured,
// Latest), card TLDR → deck over the list, Archive + topic filter, About, newsletter →
// Admin → Subscribers, Admin → Site → About text, paragraph / article / deck share (desktop menu
// and stubbed native sheet on mobile), deep links, theme persistence, legacy hash links, OG tags,
// sitemap, and Listen without a recording (disabled; the Listen walk is listen.spec.ts).
//
// tldr.spec.ts runs before this file (project dependencies in playwright.config.ts) and publishes
// one more Op-Ed article, so counts that
// depend on "every published article" are read from blog0_test rather than hard-coded.

const SEEDED = {
  humans: { slug: 'humans-are-software', title: 'Humans are Software', topic: 'Perspectives' },
  techFirst: {
    slug: 'tech-company-first',
    title: 'Before you become an AI company you will need to become a Tech company',
    topic: 'Op-Ed',
  },
  artefact: { slug: 'artefact-driven-development', title: 'Artefact Driven Development', topic: 'Educational' },
  destroy: { slug: 'ai-will-destroy-the-world', title: 'AI Will Destroy the World', topic: 'Op-Ed' },
  expensive: { slug: 'ai-is-expensive', title: 'AI is Expensive', topic: 'Analysis' },
} as const;
const SEEDED_SLUGS = Object.values(SEEDED).map((p) => p.slug);
/** Featured rank order (spec: design FEATURED_HITS — rank 1, 2, 3). */
const FEATURED_ORDER = [SEEDED.destroy.title, SEEDED.techFirst.title, SEEDED.humans.title];
const HUMANS_DEK =
  'A human is a collection of perceptions, feelings, thoughts and intentions — read through the Buddha’s account of how perception becomes proliferation.';
/** Stage A: the stub transport's honest signup copy (E2E always runs the stub). */
const NL_RECORDED = 'Signup recorded — this environment doesn’t send email.';

interface PublishedRow {
  slug: string;
  title: string;
  topic: string;
  is_featured: boolean;
}

/** Every published article in blog0_test (the server under test writes it). */
async function publishedArticles(): Promise<PublishedRow[]> {
  return withTestDb(
    (sql) => sql<PublishedRow[]>`
      select a.slug, r.title, a.topic, a.is_featured
      from article a join article_revision r on r.id = a.published_revision_id
      where a.status = 'published'
      order by a.first_published_at desc`,
  );
}

/** window.scrollY once it has held still for a few frames. */
async function settledScrollY(page: Page): Promise<number> {
  let last = -1;
  for (let i = 0; i < 40; i += 1) {
    const y = await page.evaluate(
      () => new Promise<number>((r) => setTimeout(() => requestAnimationFrame(() => r(window.scrollY)), 100)),
    );
    if (y === last) return y;
    last = y;
  }
  return last;
}

/** Whether the page typewriter still holds untyped text back (the blog0-untyped highlight). */
function typingNow(page: Page) {
  return page.evaluate(() => CSS.highlights.has('blog0-untyped'));
}

/** The page typed in: the typewriter was running, and then finished. */
async function typesIn(page: Page) {
  await expect.poll(() => typingNow(page), { timeout: 30_000 }).toBe(false);
}

/** WCAG contrast of two `rgb(…)` colours. */
function contrastOf(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test.describe.configure({ mode: 'serial' });

test.describe('reader site (blog0)', () => {
  test('global setup seeded the 5 design articles, each with a published fixture deck and 0 AI calls', async () => {
    const rows = await withTestDb(
      (sql) => sql<Array<{ slug: string; status: string; deck: boolean }>>`
        select a.slug, a.status, (f.published_payload is not null) as deck
        from article a left join article_format f on f.article_id = a.id and f.kind = 'tldr'
        where a.slug in ${sql(SEEDED_SLUGS)}`,
    );
    expect(rows.map((r) => r.slug).sort()).toEqual([...SEEDED_SLUGS].sort());
    for (const r of rows) {
      expect(r.status, r.slug).toBe('published');
      expect(r.deck, `${r.slug} has a published deck`).toBe(true);
    }
    const generations = await withTestDb(
      (sql) => sql<Array<{ n: number }>>`
        select count(*)::int as n from ai_generation g join article a on a.id = g.article_id
        where a.slug in ${sql(SEEDED_SLUGS)}`,
    );
    expect(generations[0].n).toBe(0);
  });

  test('home: wordmark blog0, no boot strip, no whole-word log0, title, footer brand without "> end of"', async ({ page, request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain('blog0');
    expect(html.match(/\blog0\b/g), 'the whole word "log0" appears nowhere in the home HTML').toBeNull();
    expect(html).toContain('Featured Editorial');

    await page.goto('/');
    await expect(page).toHaveTitle('blog0');
    // The boot strip is gone (UI review 2026-10-20): nothing above the masthead, no "> start of".
    await expect(page.locator('.boot, .boot__in')).toHaveCount(0);
    expect(html).not.toContain('&gt; start of');
    expect(html).not.toContain('> start of');
    // The typed text is plain text: read once, no .sr / aria-hidden copies.
    await expect(page.locator('.sitehead .wordmark')).toHaveText('blog0');
    await expect(page.locator('.sitehead .wordmark .sr, .sitehead .tagline .sr')).toHaveCount(0);
    await expect(page.locator('.sitehead .wordmark__o')).toHaveText('0');

    await page.locator('.site-footer').scrollIntoViewIfNeeded();
    await expect(page.locator('.ft-copy')).toContainText(/© 2026\s+blog0/);
    // The footer's "> end of blog0" line is gone with the strip.
    await expect(page.locator('.ft-eof, .ft-us')).toHaveCount(0);
    expect(html).not.toContain('end of blog0');
    // No RSS anywhere (div. 12).
    await expect(page.locator('a[href*="rss"], a[href*="feed.xml"], link[type="application/rss+xml"]')).toHaveCount(0);
  });

  test('the page typewriter types the whole of Home, Archive and About on every arrival, nothing else', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-typing', '1');
      await expect(page.locator('html')).toHaveAttribute('data-typer', '');
      expect(await typingNow(page), 'Home types in').toBe(true);
      await typesIn(page);

      // Reload: types again.
      await page.reload();
      expect(await typingNow(page)).toBe(true);
      await typesIn(page);

      // Client navigation to the Archive: the whole page types, the text was in the HTML all along.
      await page.locator('.sitehead').getByRole('link', { name: 'Archive' }).click();
      await expect(page).toHaveURL(/\/archive$/);
      await expect(page.locator('html')).toHaveAttribute('data-typing', '1');
      expect(await typingNow(page), 'Archive types in').toBe(true);
      await expect(page.getByRole('heading', { level: 1, name: 'Archive' })).toBeAttached();
      await typesIn(page);

      // Home again, then a document load of /about: both type.
      await page.locator('.sitehead .brandlink').click();
      await expect(page).toHaveURL(/\/$/);
      expect(await typingNow(page)).toBe(true);
      await page.goto('/about');
      await expect(page.locator('html')).toHaveAttribute('data-typing', '1');
      expect(await typingNow(page), 'About types in').toBe(true);
      await typesIn(page);

      // An article never types.
      await page.goto(`/p/${SEEDED.humans.slug}`);
      expect(await page.evaluate(() => document.documentElement.dataset.typing ?? null)).toBeNull();
      expect(await typingNow(page)).toBe(false);
    } finally {
      await ctx.close();
    }

    // First paint without scripts: nothing is marked, so the server HTML shows complete text.
    const noJs = await browser.newContext({ javaScriptEnabled: false });
    try {
      const raw = await noJs.newPage();
      await raw.goto('/archive');
      expect(await raw.evaluate(() => document.documentElement.hasAttribute('data-typing'))).toBe(false);
      expect(await raw.locator('.sitehead .wordmark').evaluate((el) => getComputedStyle(el).color)).not.toBe('rgba(0, 0, 0, 0)');
    } finally {
      await noJs.close();
    }
  });

  test('--faint text meets 4.5:1 against the page background in light and dark', async ({ page }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`/p/${SEEDED.humans.slug}`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      const { fg, bg } = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.textContent = 'faint';
        probe.style.color = 'var(--faint)';
        document.body.appendChild(probe);
        const out = { fg: getComputedStyle(probe).color, bg: getComputedStyle(document.body).backgroundColor };
        probe.remove();
        return out;
      });
      const real = await page.locator('.readhead__by span').first().evaluate((el) => getComputedStyle(el).color);
      expect(real, 'a design --faint element uses the overridden token').toBe(fg);
      expect(contrastOf(fg, bg), `${scheme}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('home: About, Featured Editorial (3 seeded, rank order), Latest newest first with See More / View all', async ({ page }) => {
    await page.goto('/');

    const about = page.locator('section#about');
    await expect(about.getByRole('heading', { name: 'About Us' })).toBeVisible();
    const strap = await about.locator('.abt__strap').textContent();
    expect(strap?.trim().length ?? 0).toBeGreaterThan(5);
    expect(await about.locator('.abt__body p').count()).toBeGreaterThan(0);

    const featured = page.locator('section[aria-labelledby="feat-h"]');
    await expect(featured.getByRole('heading', { name: 'Featured Editorial' })).toBeVisible();
    const featuredTitles = await featured.locator('.fcard h3').evaluateAll((hs) => hs.map((h) => h.getAttribute('aria-label')));
    expect(featuredTitles).toEqual(FEATURED_ORDER);

    const published = await publishedArticles();
    const latestExpected = published.filter((p) => !p.is_featured).map((p) => p.title);
    const latest = page.locator('section[aria-labelledby="feed-h"]');
    await expect(latest.getByRole('heading', { name: 'Latest', exact: true })).toBeVisible();
    const latestTitles = await latest.locator('.post h3').evaluateAll((hs) => hs.map((h) => h.getAttribute('aria-label')));
    expect(latestTitles).toEqual(latestExpected.slice(0, 5));
    for (const t of FEATURED_ORDER) expect(latestTitles).not.toContain(t);
    // Seeded non-featured posts, newest first.
    expect(latestTitles.indexOf(SEEDED.expensive.title)).toBeLessThan(latestTitles.indexOf(SEEDED.artefact.title));
    // The in-progress badge on "AI is Expensive".
    await expect(latest.locator('.post', { hasText: SEEDED.expensive.title }).locator('.tag--draft')).toHaveText('Draft');

    if (latestExpected.length > 5) {
      await latest.getByRole('button', { name: 'See more articles' }).click();
      await expect(latest.locator('.post')).toHaveCount(Math.min(latestExpected.length, 10));
    } else {
      await expect(latest.locator('.feed__status')).toHaveText('That’s everything in the feed.');
    }
    // Listen quick buttons stay hidden until a recording is published.
    await expect(page.getByRole('button', { name: /^Listen to / })).toHaveCount(0);

    await latest.getByRole('link', { name: 'View all articles' }).click();
    await expect(page).toHaveURL(/\/archive$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Archive' })).toBeVisible();
  });

  test('a card’s TLDR opens the deck over the home page; Escape closes it at the same scroll position', async ({ page }) => {
    await page.goto('/');
    const card = page.locator('section[aria-labelledby="feed-h"] .post', { hasText: SEEDED.expensive.title });
    const tldr = card.getByRole('button', { name: new RegExp(`^Summary of ${SEEDED.expensive.title} — \\d+ min$`) });
    await tldr.scrollIntoViewIfNeeded();
    await expect(tldr).toBeVisible();
    // The masthead compacts once the page scrolls (and scroll anchoring follows it): measure only
    // after the position has settled.
    const scrollBefore = await settledScrollY(page);

    await tldr.click();

    const deck = page.locator('.tdeck');
    await expect(deck).toBeVisible();
    await expect(deck.locator('.tdeck__big')).toHaveText(SEEDED.expensive.title);
    await expect(deck.locator('.tdeck__note')).toContainText('Lines selected by the editors, verbatim from the article.');
    expect(await deck.locator('.tdeck__seg').count()).toBeGreaterThanOrEqual(5);
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.locator('section[aria-labelledby="feed-h"]')).toBeAttached();

    await page.keyboard.press('Escape');
    await expect(deck).toBeHidden();
    expect(new URL(page.url()).pathname).toBe('/');
    expect(Math.abs((await settledScrollY(page)) - scrollBefore)).toBeLessThanOrEqual(2);
  });

  test('Archive: masthead nav types the wordmark again, month groups, topic filter, opening a row stops the typing', async ({ page }) => {
    const published = await publishedArticles();
    const opEd = published.filter((p) => p.topic === 'Op-Ed');
    await page.goto('/');

    await page.locator('.sitehead').getByRole('link', { name: 'Archive' }).click();

    await expect(page).toHaveURL(/\/archive$/);
    await expect(page.locator('html')).toHaveAttribute('data-typing', '1');
    await typesIn(page);
    await expect(page).toHaveTitle('Archive — blog0');
    await expect(page.locator('.pagehead p')).toHaveText(`${published.length} articles, newest first.`);
    await expect(page.locator('.archive-month', { hasText: 'September 2026' })).toBeVisible();
    for (const p of Object.values(SEEDED)) await expect(page.locator('.archive-row .t', { hasText: p.title })).toBeVisible();
    // Month groups newest first, rows newest first.
    const rowTitles = await page.locator('.archive-row .t').allInnerTexts();
    expect(rowTitles).toEqual(published.map((p) => p.title));

    const filter = page.getByRole('group', { name: 'Filter by topic' });
    await filter.getByRole('button', { name: 'Op-Ed', exact: true }).click();
    await expect(page).toHaveURL(/\/archive\?topic=Op-Ed$/);
    await expect(filter.getByRole('button', { name: 'Op-Ed', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.pagehead p')).toHaveText(`${opEd.length} articles in Op-Ed, newest first.`);
    await expect(page.locator('.archive-row')).toHaveCount(opEd.length);
    await expect(page.locator('.archive-row .t', { hasText: SEEDED.techFirst.title })).toBeVisible();
    await expect(page.locator('.archive-row .t', { hasText: SEEDED.destroy.title })).toBeVisible();

    await filter.getByRole('button', { name: 'All topics' }).click();
    await expect(page.locator('.archive-row')).toHaveCount(published.length);

    await page.locator('.archive-row__link', { hasText: SEEDED.humans.title }).click();
    await expect(page).toHaveURL(new RegExp(`/p/${SEEDED.humans.slug}$`));
    await expect(page.locator('html')).not.toHaveAttribute('data-typing', '1');
    expect(await typingNow(page)).toBe(false);
    await expect(page.locator('.readhead h1')).toHaveAttribute('aria-label', SEEDED.humans.title);
  });

  test('a footer topic lands on the Archive pre-filtered', async ({ page }) => {
    await page.goto('/');
    const topics = page.getByRole('navigation', { name: 'Footer topics' });
    await topics.scrollIntoViewIfNeeded();

    await topics.getByRole('button', { name: 'Op-Ed', exact: true }).click();

    await expect(page).toHaveURL(/\/archive\?topic=Op-Ed$/);
    await expect(
      page.getByRole('group', { name: 'Filter by topic' }).getByRole('button', { name: 'Op-Ed', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.pagehead p')).toHaveText(/ in Op-Ed, newest first\.$/);
    await expect(page.locator('.archive-row .t', { hasText: SEEDED.artefact.title })).toHaveCount(0);
  });

  test('About page shows the site’s About texts', async ({ page }) => {
    await page.goto('/about');
    await expect(page).toHaveTitle('About — blog0');
    await expect(page.getByRole('heading', { level: 1, name: 'About blog0' })).toBeVisible();
    const strap = (await page.locator('.pagehead .abt__strap').innerText()).trim();
    expect(strap.length).toBeGreaterThan(5);
    expect(await page.locator('main').locator('p').count()).toBeGreaterThan(2);
  });

  test('newsletter: subscribe in the footer → "Signup recorded…" (stub), the address is in Admin → Subscribers and its CSV', async ({ page }) => {
    const email = `reader-${Date.now()}@example.test`;
    await page.goto('/');
    const form = page.locator('#newsletter');
    await form.scrollIntoViewIfNeeded();

    // Invalid address: the design's message, no request.
    let posts = 0;
    page.on('request', (r) => {
      if (r.url().endsWith('/api/newsletter') && r.method() === 'POST') posts += 1;
    });
    await form.getByLabel('Email').fill('not-an-email');
    await form.getByRole('button', { name: 'Subscribe' }).click();
    await expect(form.locator('#nl-st')).toHaveText('Enter a valid email, like you@company.com.');
    expect(posts).toBe(0);

    await form.getByLabel('Name (optional)').fill('E2E Reader');
    await form.getByLabel('Email').fill(`  ${email.toUpperCase()} `);
    await page.waitForTimeout(2_100); // Stage A bot check: humans take ≥ 2 s
    await form.getByRole('button', { name: 'Subscribe' }).click();
    await expect(form.getByRole('status')).toHaveText(NL_RECORDED);
    expect(posts).toBe(1);

    const stored = await withTestDb(
      (sql) => sql<Array<{ email: string; name: string | null }>>`select email, name from newsletter_subscriber where email = ${email}`,
    );
    expect(stored).toEqual([{ email, name: 'E2E Reader' }]);

    await signIn(page);
    await page.getByRole('navigation', { name: 'Desk' }).getByRole('link', { name: 'Subscribers' }).click();
    await expect(page).toHaveURL(/\/admin\/subscribers$/);
    const row = page.locator('.admin-table tbody tr', { hasText: email });
    await expect(row).toBeVisible();
    await expect(row).toContainText('E2E Reader');
    await expect(row).toContainText('Pending'); // double opt-in: confirmed only after the emailed link (Phase 7)

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export CSV' }).click()]);
    const csv = readFileSync(await download.path(), 'utf8');
    const [header, ...lines] = csv.trim().split(/\r?\n/);
    expect(header.toLowerCase()).toContain('email');
    expect(lines.some((l) => l.includes(email))).toBe(true);
  });

  test('Admin → Site: editing the About strap changes home and /about (restored afterwards)', async ({ page }, testInfo) => {
    const base = originOf(testInfo);
    await signIn(page);
    await page.getByRole('navigation', { name: 'Desk' }).getByRole('link', { name: 'Site' }).click();
    await expect(page).toHaveURL(/\/admin\/site$/);
    const strapField = page.getByLabel('About strap');
    await expect(strapField).toBeEnabled();
    const original = await strapField.inputValue();
    const edited = `E2E strap ${Date.now()} — written on the desk.`;

    try {
      await strapField.fill(edited);
      await expect(page.getByText('Unsaved changes')).toBeVisible();
      // The Site page also holds the Newsletter settings card (its own Save); scope to the site form.
      await page.getByRole('form', { name: 'Site settings' }).getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Saved — the home page and /about show it on the next load.')).toBeVisible();

      await page.goto('/');
      await expect(page.locator('section#about .abt__strap')).toHaveText(edited);
      await page.goto('/about');
      await expect(page.locator('.pagehead .abt__strap')).toHaveText(edited);
    } finally {
      const res = await page.request.patch('/api/admin/site', { data: { aboutStrap: original }, headers: { origin: base } });
      expect(res.status()).toBe(200);
    }
    await page.goto('/about');
    await expect(page.locator('.pagehead .abt__strap')).toHaveText(original.trim());
  });

  test('paragraph share (desktop): highlight, clipboard = quote + link, six options; Escape closes only the menu', async ({ page, context }, testInfo) => {
    const base = originOf(testInfo);
    await grantClipboard(context, base);
    await page.goto(`/p/${SEEDED.humans.slug}`);
    await clearClipboard(page);
    const pid = await plainParagraphId(page);
    const para = page.locator(`#${pid}`);
    const expectedText = await expectedParagraphText(para);
    const link = `${base}/p/${SEEDED.humans.slug}#${pid}`;

    await para.click();

    await expect(para).toHaveClass(/\bis-hl\b/);
    const menu = page.locator('.hlmenu');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('aria-label', 'Share this passage');
    await expect(menu.locator('.hlmenu__status')).toHaveText(SHARE_STATUS.passage);
    expect(await menuOptionLabels(menu)).toEqual([...SHARE_OPTIONS]);
    await expect.poll(() => readClipboard(page)).toBe(`${expectedText}\n${link}`);
    expect(expectedText.endsWith('” — blog0')).toBe(true);
    expect(new URL(page.url()).hash).toBe(`#${pid}`);
    // Target URLs carry the text and link (one source: share-links.ts).
    await expect(menu.getByRole('link', { name: 'X' })).toHaveAttribute(
      'href',
      `https://x.com/intent/tweet?text=${encodeURIComponent(expectedText)}&url=${encodeURIComponent(link)}`,
    );
    await expect(menu.getByRole('link', { name: 'LinkedIn' })).toHaveAttribute(
      'href',
      `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(link)}`,
    );

    // Copy link copies the link only.
    await menu.getByRole('button', { name: 'Copy link' }).click();
    await expect(menu.getByRole('button', { name: 'Link copied' })).toBeVisible();
    await expect.poll(() => readClipboard(page)).toBe(link);

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(para).toHaveClass(/\bis-hl\b/);
    await expect(page.locator('.para.is-hl')).toHaveCount(1);

    // Clicking the lit paragraph again clears it.
    await para.click();
    await expect(para).not.toHaveClass(/\bis-hl\b/);
    await expect(page.locator('.hlmenu')).toHaveCount(0);
  });

  test('a link inside a paragraph is not a share: no highlight, no menu', async ({ page }) => {
    await page.goto(`/p/${SEEDED.humans.slug}`);
    const anchor = page.locator('.readbody .para a[href]:not([data-footnote-ref])').first();
    expect(await anchor.count(), 'the seeded article has inline links').toBeGreaterThan(0);
    await anchor.evaluate((a) => a.addEventListener('click', (e) => e.preventDefault()));
    await anchor.click();
    await expect(page.locator('.para.is-hl')).toHaveCount(0);
    await expect(page.locator('.hlmenu')).toHaveCount(0);
  });

  test('Share article copies "<title> — blog0" + the article URL and opens the menu', async ({ page, context }, testInfo) => {
    const base = originOf(testInfo);
    await grantClipboard(context, base);
    await page.goto(`/p/${SEEDED.humans.slug}`);
    await clearClipboard(page);
    const button = page.getByRole('button', { name: 'Share article' });
    await button.scrollIntoViewIfNeeded();

    await button.click();

    const menu = page.locator('.hlmenu');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('aria-label', 'Share this article');
    await expect(menu.locator('.hlmenu__status')).toHaveText(SHARE_STATUS.titleAndLink);
    expect(await menuOptionLabels(menu)).toEqual([...SHARE_OPTIONS]);
    await expect.poll(() => readClipboard(page)).toBe(`${SEEDED.humans.title} — ${BRAND}\n${base}/p/${SEEDED.humans.slug}`);
    await expect(page.locator('.para.is-hl')).toHaveCount(0);
  });

  test('deck end slide Share copies the deck text + link; the menu opens inside the deck; Escape closes only the menu', async ({ page, context }, testInfo) => {
    const base = originOf(testInfo);
    await grantClipboard(context, base);
    await page.goto(`/p/${SEEDED.humans.slug}/tldr`);
    const deck = page.locator('.tdeck');
    await expect(deck).toBeVisible();
    await clearClipboard(page);
    await deck.getByRole('button', { name: 'Pause the summary' }).click();

    await page.keyboard.press('End');
    await expect(deck.getByRole('button', { name: 'Read the full article' })).toBeVisible();
    await deck.getByRole('button', { name: 'Share this summary' }).click();

    const menu = deck.locator('.hlmenu');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('aria-label', 'Share this summary');
    expect(await menuOptionLabels(menu)).toEqual([...SHARE_OPTIONS]);
    await expect
      .poll(() => readClipboard(page))
      .toBe(`${SEEDED.humans.title} — TLDR — ${BRAND}\n${base}/p/${SEEDED.humans.slug}/tldr`);

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(deck).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(`/p/${SEEDED.humans.slug}/tldr`);
  });

  test('opening a #p-<id> link scrolls to that paragraph and highlights it, with no menu open', async ({ page }) => {
    await page.goto(`/p/${SEEDED.humans.slug}`);
    const paras = page.locator('.readbody p.para[id]');
    const count = await paras.count();
    expect(count).toBeGreaterThan(6);
    // A paragraph well below the fold.
    const pid = await paras.nth(count - 2).getAttribute('id');
    expect(pid).toMatch(/^p-[0-9a-f]{8}(-\d+)?$/);

    const fresh = await page.context().newPage();
    await fresh.goto(`/p/${SEEDED.humans.slug}#${pid}`);

    const target = fresh.locator(`#${pid}`);
    await expect(target).toHaveClass(/\bis-hl\b/);
    await expect(target).toBeInViewport();
    expect(await fresh.evaluate(() => window.scrollY)).toBeGreaterThan(200);
    await expect(fresh.locator('.hlmenu')).toHaveCount(0);
    await fresh.close();
  });

  test('mobile (390 px, touch) with navigator.share: tapping a paragraph opens the native sheet, no menu', async ({ browser }, testInfo) => {
    const base = originOf(testInfo);
    const context = await browser.newContext({
      baseURL: base,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      await stubNativeShare(context, 'resolve');
      const page = await context.newPage();
      await page.goto(`/p/${SEEDED.humans.slug}`);
      const pid = await plainParagraphId(page);
      const para = page.locator(`#${pid}`);
      const expectedText = await expectedParagraphText(para);

      await para.tap();

      await expect.poll(async () => (await nativeShareCalls(page)).length).toBe(1);
      expect(await nativeShareCalls(page)).toEqual([
        { title: BRAND, text: expectedText, url: `${base}/p/${SEEDED.humans.slug}#${pid}` },
      ]);
      await expect(para).toHaveClass(/\bis-hl\b/);
      await page.waitForTimeout(300);
      await expect(page.locator('.hlmenu')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('mobile: when navigator.share rejects (not AbortError) the share menu opens instead', async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      baseURL: originOf(testInfo),
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      await stubNativeShare(context, 'reject');
      const page = await context.newPage();
      await page.goto(`/p/${SEEDED.humans.slug}`);
      const para = page.locator(`#${await plainParagraphId(page)}`);

      await para.tap();

      await expect.poll(async () => (await nativeShareCalls(page)).length).toBe(1);
      const menu = page.locator('.hlmenu');
      await expect(menu).toBeVisible();
      expect(await menuOptionLabels(menu)).toEqual([...SHARE_OPTIONS]);
    } finally {
      await context.close();
    }
  });

  test('dark mode persists across a reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
    // The attribute is not the point — the page must actually repaint: body's computed background.
    const bodyBg = (): Promise<string> => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const lightBg = await bodyBg();
    expect(lightBg).toMatch(/^rgba?\(/);

    await page.getByRole('button', { name: 'Switch to dark mode' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(bodyBg).not.toBe(lightBg);
    const darkBg = await bodyBg();

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('button', { name: 'Switch to light mode' })).toBeVisible();
    await expect.poll(bodyBg).toBe(darkBg);
    await page.goto('/archive');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.getByRole('button', { name: 'Switch to light mode' }).click();
    await expect.poll(bodyBg).toBe(lightBg);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(bodyBg).toBe(lightBg);
  });

  test('prefers-reduced-motion: the page is complete at first paint and still; deck slides change without transition', async ({ browser, page }) => {
    // First paint = the server HTML before any script: with JS off the nought has no animation.
    const noJs = await browser.newContext({ javaScriptEnabled: false, reducedMotion: 'reduce' });
    try {
      const raw = await noJs.newPage();
      await raw.goto('/');
      await expect(raw.locator('.sitehead .wordmark')).toHaveText('blog0');
      expect(await raw.locator('.sitehead .wordmark__o').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    } finally {
      await noJs.close();
    }

    // Hydrated: still complete, and the nought never runs an animation.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    expect(await page.evaluate(() => document.documentElement.dataset.typing ?? null)).toBeNull();
    expect(await typingNow(page)).toBe(false);
    const nought = page.locator('.sitehead .wordmark__o');
    await expect(nought).toHaveClass(/\bis-spin\b/);
    expect(await nought.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    expect(await nought.evaluate((el) => el.getAnimations().length)).toBe(0);

    // Deck: the track carries no transition, and its transform jumps straight from slide 0 to
    // slide 1 — every frame sampled across the change is one of the two end positions.
    await page.goto(`/p/${SEEDED.humans.slug}/tldr`);
    const deck = page.locator('.tdeck');
    await expect(deck).toBeVisible();
    const track = deck.locator('.tdeck__track');
    expect(await track.evaluate((el) => getComputedStyle(el).transitionProperty)).toBe('none');
    const before = await track.evaluate((el) => getComputedStyle(el).transform);
    await track.evaluate((el) => {
      const w = window as unknown as { __trackFrames: string[]; __trackStop: boolean };
      w.__trackFrames = [];
      w.__trackStop = false;
      const sample = () => {
        w.__trackFrames.push(getComputedStyle(el).transform);
        if (!w.__trackStop) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.keyboard.press('ArrowRight');
    await expect(deck.locator('.tdeck__seg').nth(1)).toHaveClass(/\bis-live\b/);
    await page.waitForTimeout(300);
    const frames = await page.evaluate(() => {
      const w = window as unknown as { __trackFrames: string[]; __trackStop: boolean };
      w.__trackStop = true;
      return w.__trackFrames;
    });
    const after = await track.evaluate((el) => getComputedStyle(el).transform);
    expect(after).not.toBe(before);
    expect(frames.length).toBeGreaterThan(2);
    expect([...new Set(frames)].filter((t) => t !== before && t !== after)).toEqual([]);
    expect(await track.evaluate((el) => getComputedStyle(el).transitionProperty)).toBe('none');
    expect(await track.evaluate((el) => el.getAnimations().length)).toBe(0);
  });

  test('legacy /#<slug>/tldr lands on /p/<slug>/tldr with the deck open', async ({ page }) => {
    await page.goto(`/#${SEEDED.techFirst.slug}/tldr`);

    await expect(page).toHaveURL(new RegExp(`/p/${SEEDED.techFirst.slug}/tldr$`));
    await expect(page.locator('.tdeck')).toBeVisible();
    await expect(page.locator('.tdeck .tdeck__big')).toHaveText(SEEDED.techFirst.title);
  });

  test('an article carries its title, OG / Twitter tags with the large card image, icons and one Article JSON-LD', async ({ page, request }, testInfo) => {
    const base = originOf(testInfo);
    const res = await request.get(`/p/${SEEDED.humans.slug}`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    for (const tag of ['og:title', 'og:description', 'og:url', 'og:type', 'twitter:card']) expect(html, tag).toContain(tag);

    await page.goto(`/p/${SEEDED.humans.slug}`);
    await expect(page).toHaveTitle(`${SEEDED.humans.title} — blog0`);
    const meta = (sel: string) => page.locator(sel).first().getAttribute('content');
    expect(await meta('meta[property="og:title"]')).toContain(SEEDED.humans.title);
    expect(await meta('meta[property="og:description"]')).toBe(HUMANS_DEK);
    expect(await meta('meta[name="description"]')).toBe(HUMANS_DEK);
    expect(await meta('meta[property="og:url"]')).toBe(`${base}/p/${SEEDED.humans.slug}`);
    expect(await meta('meta[property="og:type"]')).toBe('article');
    expect(await meta('meta[name="twitter:card"]')).toBe('summary_large_image');
    expect(await meta('meta[property="og:image"]')).toBe(`${base}/og-default.png`);
    expect(await meta('meta[property="og:image:width"]')).toBe('1200');
    expect(await meta('meta[property="og:image:height"]')).toBe('630');
    expect(await meta('meta[name="twitter:image"]')).toBe(`${base}/og-default.png`);
    await expect(page.locator('link[rel="icon"][href="/favicon.svg"]')).toHaveAttribute('type', 'image/svg+xml');
    await expect(page.locator('link[rel="icon"][href="/favicon-32.png"]')).toHaveAttribute('sizes', '32x32');

    // Structured data: exactly one block, valid JSON, never a raw "<" inside.
    const blocks = page.locator('script[type="application/ld+json"]');
    await expect(blocks).toHaveCount(1);
    const raw = await blocks.first().evaluate((el) => el.textContent ?? '');
    expect(raw).not.toContain('<');
    const ld = JSON.parse(raw) as Record<string, unknown>;
    expect(ld).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: SEEDED.humans.title,
      description: HUMANS_DEK,
      url: `${base}/p/${SEEDED.humans.slug}`,
      mainEntityOfPage: `${base}/p/${SEEDED.humans.slug}`,
      image: `${base}/og-default.png`,
      publisher: { '@type': 'Organization', name: 'blog0', logo: `${base}/logo.png` },
    });
    expect((ld.author as Record<string, unknown>)['@type']).toBe('Person');
    expect(Date.parse(ld.datePublished as string)).not.toBeNaN();
    expect(Date.parse(ld.dateModified as string)).toBeGreaterThanOrEqual(Date.parse(ld.datePublished as string));
  });

  test('home carries one Organization + WebSite JSON-LD and the large card; the share/icon files are served', async ({ page, request }, testInfo) => {
    const base = originOf(testInfo);
    await page.goto('/');
    const blocks = page.locator('script[type="application/ld+json"]');
    await expect(blocks).toHaveCount(1);
    const ld = JSON.parse((await blocks.first().textContent()) ?? '') as { '@graph': Array<Record<string, unknown>> };
    expect(ld['@graph'].map((n) => n['@type'])).toEqual(['Organization', 'WebSite']);
    expect(ld['@graph'][0]).toMatchObject({ name: 'blog0', url: `${base}/`, logo: `${base}/logo.png` });
    expect(await page.locator('meta[name="twitter:card"]').first().getAttribute('content')).toBe('summary_large_image');
    expect(await page.locator('meta[property="og:image"]').first().getAttribute('content')).toBe(`${base}/og-default.png`);

    for (const [file, type] of [
      ['/favicon.svg', 'image/svg+xml'],
      ['/favicon-32.png', 'image/png'],
      ['/favicon.ico', 'image/'],
      ['/og-default.png', 'image/png'],
      ['/logo.png', 'image/png'],
    ] as const) {
      const res = await request.get(file);
      expect(res.status(), file).toBe(200);
      expect(res.headers()['content-type'], file).toContain(type);
    }
  });

  test('/sitemap.xml lists every published article (the 5 seeded included) plus /, /archive, /about, /privacy', async ({ request }, testInfo) => {
    const base = originOf(testInfo);
    const res = await request.get('/sitemap.xml');
    expect(res.status()).toBe(200);
    const xml = await res.text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());

    for (const slug of SEEDED_SLUGS) expect(locs).toContain(`${base}/p/${slug}`);
    const published = await publishedArticles();
    expect(locs.filter((l) => l.includes('/p/')).sort()).toEqual(published.map((p) => `${base}/p/${p.slug}`).sort());
    expect(locs).toEqual(expect.arrayContaining([`${base}/archive`, `${base}/about`, `${base}/privacy`]));
    expect(locs.some((l) => l === base || l === `${base}/`)).toBe(true);
    expect(locs).toHaveLength(published.length + 4);
  });

  // A seeded article has no recording: Listen is disabled with its reason (in the capsule and in the
  // deck's switcher alike), and /listen falls back to Read. The Listen walk is listen.spec.ts.
  test('without a recording the capsule’s Listen is disabled ("No recording yet") and /listen falls back to Read', async ({ page }) => {
    await page.goto(`/p/${SEEDED.humans.slug}`);
    const listen = page.locator('.modedock').getByRole('tab', { name: 'Listen — no recording yet' });
    await expect(listen).toBeVisible();
    await expect(listen).toBeDisabled();
    await expect(listen).toHaveAttribute('title', 'No recording yet');
    await page.locator('.modedock').getByRole('tab', { name: /^TLDR — \d+ min$/ }).click();
    const deckListen = page.locator('.tdeck__foot').getByRole('tab', { name: 'Listen — no recording yet' });
    await expect(deckListen).toBeDisabled();
    await expect(deckListen).toHaveAttribute('title', 'No recording yet');

    await page.goto(`/p/${SEEDED.humans.slug}/listen`);

    await expect(page).toHaveURL(new RegExp(`/p/${SEEDED.humans.slug}$`));
    await expect(page.locator('.listenview')).toHaveCount(0);
    await expect(page.locator('.readbody')).toBeVisible();
  });

  test('See More: with more than 5 non-featured posts, Latest shows 5, then all of them', async ({ page }, testInfo) => {
    const base = originOf(testInfo);
    await signIn(page);
    const nonFeatured = (await publishedArticles()).filter((p) => !p.is_featured).length;
    for (let i = nonFeatured; i < 7; i += 1) {
      const article = await createArticleApi(page.request, base, {
        title: `Feed filler ${i + 1}`,
        topic: 'Notes',
        dek: 'A short post that pads the Latest feed past one batch.',
        bodyMd: `A short post that pads the Latest feed past one batch, number ${i + 1}.\n\nIt has a second paragraph so it reads like an article.\n`,
      });
      await publishApi(page.request, base, article.id, article.currentRevision.id);
    }
    const expected = (await publishedArticles()).filter((p) => !p.is_featured).map((p) => p.title);
    expect(expected.length).toBeGreaterThanOrEqual(7);

    await page.goto('/');
    const latest = page.locator('section[aria-labelledby="feed-h"]');
    await expect(latest.locator('.post')).toHaveCount(5);
    await latest.getByRole('button', { name: 'See more articles' }).click();
    await expect(latest.locator('.post')).toHaveCount(Math.min(expected.length, 10));
    const titles = await latest.locator('.post h3').evaluateAll((hs) => hs.map((h) => h.getAttribute('aria-label')));
    expect(titles).toEqual(expected.slice(0, 10));
    if (expected.length <= 10) await expect(latest.locator('.feed__status')).toHaveText('That’s everything in the feed.');
  });
});
