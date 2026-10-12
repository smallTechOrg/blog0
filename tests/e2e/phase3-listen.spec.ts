import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { signInThroughForm } from './helpers/admin';
import { withTestDb } from './helpers/db';
import { AUDIO_FIXTURE, IMAGE_FIXTURE, audioFixtureMeta, expectRange206, pngFixtureMeta } from './helpers/upload';

// Phase 3 Listen walk (spec/roadmap.md → Phase 3 "How the user tests it"; capabilities listen-audio,
// listen-sync, media-images): sign in → a fresh four-paragraph article (the words of the committed
// reading, tests/fixtures/audio/sample.json) → Listen tab: upload sample.mp3 → Needs sync → Start
// syncing → Space at each paragraph start (the position is driven deterministically through
// audio.currentTime) → Save sync → Synced → Write tab: Image uploads sample.png → `![…](/media/…)`
// at the cursor, figure in the preview → Publish → /p/<slug>: capsule "Listen · 1 min" → Listen
// view: player beside the text, highlight follows currentTime, the seek bar and a paragraph click
// jump it → /media/<key> answers 206 to a byte range → edit a synced paragraph + Save → Listen
// stale with the re-sync warning, publish blocked with "Go to Listen", the live page keeps the old
// Listen → home card Listen opens the compact overlay. Listen never calls the LLM: zero new
// ai_generation rows.
//
// Runs after phase1-tldr and phase2-reader (file order), so the home card and the Listen quick
// button for this article cannot disturb their assertions.

const AUDIO = audioFixtureMeta();
const PNG = pngFixtureMeta();
const TITLE = 'Listen walk: one text, three shapes';
const TOPIC = 'Notes';
const DEK = 'A spoken reading, synced paragraph by paragraph.';
/** The fixture reading's words, as four paragraphs (sample.json → text). */
const PARAS = [
  'blog0 is a small publishing platform for writers who want every article to reach readers in more than one shape.',
  'You write once in Markdown. The same text becomes a readable page, a short slide deck, and a spoken reading you can listen to.',
  'Nothing is generated behind your back; every format is reviewed before it is published.',
  'Readers pick the shape that fits their moment.',
];
const EDITED_PARA_1 = 'You write once in Markdown. The same words become a page, a deck, and a reading.';
/** Where each tap lands (ms) — inside the ~21 s reading, ≥ 4 s apart. */
const TAP_AT_MS = [500, 5_000, 10_500, 16_000];

interface Mark {
  pid: string;
  tMs: number;
}

interface Journey {
  context: BrowserContext;
  page: Page;
  origin: string;
  articleId: string;
  slug: string;
  aiRowsBefore: number;
  audio: { key: string; url: string; bytes: number };
  marks: Mark[];
  imageUrl: string;
}

const j: Partial<Journey> = {};
function journey(): Journey {
  return j as Journey;
}

async function aiGenerationCount(articleId?: string): Promise<number> {
  return withTestDb(async (sql) => {
    const rows = articleId
      ? await sql<{ n: number }[]>`select count(*)::int as n from ai_generation where article_id = ${articleId}`
      : await sql<{ n: number }[]>`select count(*)::int as n from ai_generation`;
    return rows[0].n;
  });
}

function clockToMs(text: string): number {
  const m = /^(\d+):(\d{2})\.(\d{3})$/.exec(text.trim());
  if (!m) throw new Error(`not an m:ss.mmm clock: ${JSON.stringify(text)}`);
  return Number(m[1]) * 60_000 + Number(m[2]) * 1000 + Number(m[3]);
}

/** Sets the Listen view's <audio> position (seconds). */
async function setReaderTime(page: Page, seconds: number): Promise<void> {
  await page.locator('section.listenview audio').evaluate((a: HTMLAudioElement, s: number) => {
    a.currentTime = s;
  }, seconds);
}

async function livePids(page: Page): Promise<string[]> {
  return page.locator('section.listenview .para.is-live').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.pid ?? ''));
}

test.describe.configure({ mode: 'serial' });

test.describe('Phase 3 Listen walk: upload → tap-sync → image → publish → listen → stale', () => {
  test.beforeAll(async ({ browser }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL as string;
    j.origin = new URL(baseURL).origin;
    j.context = await browser.newContext({ baseURL });
    j.page = await j.context.newPage();
    j.aiRowsBefore = await aiGenerationCount();
  });

  test.afterAll(async () => {
    await j.context?.close();
  });

  test('sign in and create a four-paragraph article (the reading’s words)', async () => {
    const { page, origin } = journey();
    await page.goto('/admin/login?next=%2Fadmin');
    await signInThroughForm(page);

    const created = await page.request.post('/api/admin/articles', {
      headers: { origin },
      data: { title: TITLE, topic: TOPIC, dek: DEK, bodyMd: PARAS.join('\n\n') + '\n' },
    });
    expect(created.status(), await created.text()).toBe(201);
    const article = (await created.json()).data.article as { id: string; slug: string };
    j.articleId = article.id;
    j.slug = article.slug;
    expect(AUDIO.text).toBe(PARAS.join(' '));
  });

  test('Listen tab: upload sample.mp3 → Needs sync; Start syncing + Space per paragraph → Save sync → Synced', async () => {
    const { page, articleId } = journey();
    await page.goto(`/admin/articles/${articleId}`);
    await expect(page.locator('.pubbar__state')).toHaveText('Saved · rev 1');

    await page.getByRole('tab', { name: /^Listen/ }).click();
    const panel = page.locator('#panel-listen');
    const status = panel.getByTestId('listen-status');
    await expect(status).toHaveText('Listen · No recording');
    await expect(panel.locator('.dropzone')).toContainText('mp3 or m4a · up to');

    await panel.getByTestId('audio-file-input').setInputFiles(AUDIO_FIXTURE.mp3);

    await expect(status).toHaveText('Listen · Needs sync');
    await expect(page.getByTestId('listen-tabchip')).toHaveText('needs sync');
    const player = panel.getByTestId('listen-audio');
    await expect(player).toHaveAttribute('src', /^\/media\/.+\.mp3$/);
    await expect(panel.locator('.recording__file')).toContainText('sample.mp3');
    await expect(panel.locator('.marklist__row')).toHaveCount(PARAS.length);
    // Chromium decodes the mp3: metadata (duration) is known before syncing starts.
    await expect
      .poll(() => player.evaluate((a: HTMLAudioElement) => (a.readyState >= 1 ? Math.round(a.duration * 1000) : -1)))
      .toBeGreaterThan(AUDIO.mp3.durationMs - 1000);

    await panel.getByTestId('start-syncing').click();
    await expect(panel.locator('.syncpanel__next')).toHaveText(`Next: paragraph 1 of ${PARAS.length}`);
    await expect(panel.locator('.marklist__row').first()).toHaveClass(/is-next/);
    for (let k = 0; k < PARAS.length; k += 1) {
      // The audio plays; its position is pinned right before each tap so the marks are deterministic.
      await player.evaluate((a: HTMLAudioElement, s: number) => {
        a.currentTime = s;
      }, TAP_AT_MS[k] / 1000);
      await page.keyboard.press('Space');
      await expect(panel.locator('.marklist__row').nth(k)).toHaveClass(/is-marked/);
      await page.waitForTimeout(400); // taps ≥ 400 ms apart (debounce is 300 ms)
    }
    await expect(panel.locator('.syncpanel__notice')).toContainText(`All ${PARAS.length} paragraphs marked`);

    const times = (await panel.getByTestId('mark-time').allInnerTexts()).map(clockToMs);
    expect(times).toHaveLength(PARAS.length);
    for (let k = 0; k < times.length; k += 1) {
      expect(Math.abs(times[k] - TAP_AT_MS[k])).toBeLessThan(1500);
      if (k > 0) expect(times[k]).toBeGreaterThan(times[k - 1]);
    }

    await panel.getByTestId('save-sync').click();
    await expect(status).toHaveText('Listen · Synced');
    await expect(panel.getByText(`Sync saved — ${PARAS.length} paragraphs marked.`)).toBeVisible();
    await expect(page.getByTestId('listen-tabchip')).toHaveText('ready');

    const res = await page.request.get(`/api/admin/articles/${articleId}/listen`);
    expect(res.status()).toBe(200);
    const listen = (await res.json()).data as {
      status: string;
      marks: Mark[];
      paragraphs: { pid: string }[];
      audio: { key: string; url: string; bytes: number; mimeType: string };
    };
    expect(listen.status).toBe('ready');
    expect(listen.marks.map((m) => m.pid)).toEqual(listen.paragraphs.map((p) => p.pid));
    expect(listen.marks.map((m) => m.tMs)).toEqual(times);
    expect(listen.audio).toMatchObject({ mimeType: 'audio/mpeg', bytes: AUDIO.mp3.bytes });
    j.audio = { key: listen.audio.key, url: listen.audio.url, bytes: listen.audio.bytes };
    j.marks = listen.marks;
  });

  test('Write tab: Image uploads sample.png → ![…](/media/….png) at the cursor, the preview shows the figure; Save keeps Listen synced', async () => {
    const { page } = journey();
    await page.getByRole('tab', { name: 'Write' }).click();
    const textarea = page.getByLabel('Markdown', { exact: true });
    await expect(textarea).toBeVisible();
    // Caret at the end of the body.
    await textarea.evaluate((ta: HTMLTextAreaElement) => {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });

    await page.getByTestId('image-file-input').setInputFiles(IMAGE_FIXTURE.png);
    const dialog = page.getByRole('dialog', { name: 'Add image' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('image-alt')).toHaveValue('sample');
    await dialog.getByTestId('image-alt').fill('A sample chart');
    await dialog.getByTestId('image-insert').click();
    await expect(dialog).toBeHidden();

    await expect(textarea).toHaveValue(/!\[A sample chart\]\(\/media\/[^)\s]+\.png\)\n?$/);
    const value = await textarea.inputValue();
    expect(value.startsWith(PARAS.join('\n\n'))).toBe(true);
    j.imageUrl = /!\[A sample chart\]\((\/media\/[^)\s]+\.png)\)/.exec(value)![1];

    const preview = page.getByRole('region', { name: 'Live preview' });
    const img = preview.locator('figure.mdfig img');
    await expect(img).toHaveAttribute('src', j.imageUrl);
    await img.scrollIntoViewIfNeeded(); // loading="lazy"
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(PNG.width);

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.pubbar__state')).toHaveText('Saved · rev 2');
    // An image alone is not a paragraph: the sync still matches the text.
    await expect(page.getByTestId('listen-tabchip')).toHaveText('ready');
  });

  test('Publish → the public article: capsule reads Listen · 1 min; the figure is served', async () => {
    const { page, slug } = journey();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByRole('link', { name: 'View live ↗' })).toBeVisible();

    await page.goto(`/p/${slug}`);
    const capsule = page.locator('.modedock');
    const listenTab = capsule.getByRole('tab', { name: 'Listen — 1 min' });
    await expect(listenTab).toBeEnabled();
    await expect(listenTab.locator('.mode__t')).toHaveText('Listen');
    await expect(listenTab.locator('.mode__d')).toHaveText('1 min');
    const img = page.locator('.readbody figure.mdfig img');
    await expect(img).toHaveAttribute('src', j.imageUrl!);
    await img.scrollIntoViewIfNeeded(); // loading="lazy"
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(PNG.width);
  });

  test('Listen view: player beside the text; currentTime drives the highlight; seek bar and paragraph click jump it', async () => {
    const { page, slug, marks, audio } = journey();
    await page.locator('.modedock').getByRole('tab', { name: 'Listen — 1 min' }).click();

    await expect(page).toHaveURL(new RegExp(`/p/${slug}/listen$`));
    const view = page.locator('section.listenview');
    await expect(view).toBeVisible();
    const lead = view.locator('.listenview__lead');
    const text = view.locator('.listenview__text');
    await expect(lead.locator('.audio')).toBeVisible();
    await expect(text.locator('.para[data-pid]')).toHaveCount(PARAS.length);
    // Side by side on a desktop viewport: the player column ends where the text column begins.
    const [leadBox, textBox] = [await lead.boundingBox(), await text.boundingBox()];
    expect(leadBox && textBox).toBeTruthy();
    expect(leadBox!.x + leadBox!.width).toBeLessThanOrEqual(textBox!.x + 1);
    await expect(view.locator('audio source')).toHaveAttribute('src', audio.url);
    await expect(view.locator('audio source')).toHaveAttribute('src', /\.mp3$/);

    // ▶ plays: the position passes 1 s within 3 s.
    await view.getByRole('button', { name: 'Play' }).click();
    await expect.poll(() => view.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime), { timeout: 3_000 }).toBeGreaterThan(1);
    await view.getByRole('button', { name: 'Pause' }).click();

    for (const k of [0, 2, marks.length - 1]) {
      await setReaderTime(page, (marks[k].tMs + 50) / 1000);
      await expect.poll(() => livePids(page)).toEqual([marks[k].pid]);
      await expect(text.locator(`.para[data-pid="${marks[k].pid}"]`)).toBeInViewport();
    }

    // The seek bar: drag to just after paragraph 2's mark → the highlight jumps there.
    const seekS = Math.ceil((marks[1].tMs + 50) / 250) * 0.25;
    expect(seekS * 1000).toBeLessThan(marks[2].tMs);
    await view.getByRole('slider', { name: 'Seek' }).fill(String(seekS));
    await expect.poll(() => livePids(page)).toEqual([marks[1].pid]);
    await expect.poll(() => view.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime)).toBeCloseTo(seekS, 1);

    // A paragraph click seeks the audio to its mark.
    await setReaderTime(page, (marks[3].tMs + 50) / 1000);
    await expect.poll(() => livePids(page)).toEqual([marks[3].pid]);
    await text.locator(`.para[data-pid="${marks[1].pid}"]`).click();
    await expect
      .poll(() => view.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime))
      .toBeGreaterThanOrEqual(marks[1].tMs / 1000 - 0.05);
    const t = await view.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime);
    expect(Math.abs(t - marks[1].tMs / 1000)).toBeLessThanOrEqual(0.05);
    await expect.poll(() => livePids(page)).toEqual([marks[1].pid]);

    // Reload keeps Listen open.
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/p/${slug}/listen$`));
    await expect(page.locator('section.listenview .audio')).toBeVisible();
  });

  test('GET /media/<key> with Range: bytes=0-1 answers 206 with the first two bytes', async ({ request }) => {
    const { audio } = journey();
    expect(audio.url).toBe(`/media/${audio.key}`);
    const head = await expectRange206(request, audio.url, AUDIO.mp3.bytes);
    const full = await request.get(audio.url);
    expect(full.status()).toBe(200);
    expect(full.headers()['content-type']).toMatch(/^audio\/mpeg/);
    expect((await full.body()).subarray(0, 2).equals(head)).toBe(true);
  });

  test('editing a synced paragraph → Listen stale with the re-sync warning; publish blocked → Go to Listen; the live page keeps the old Listen', async () => {
    const { page, articleId, slug, marks, audio, origin } = journey();
    await page.goto(`/admin/articles/${articleId}`);
    const textarea = page.getByLabel('Markdown', { exact: true });
    const before = await textarea.inputValue();
    expect(before).toContain(PARAS[1]);
    await textarea.fill(before.replace(PARAS[1], EDITED_PARA_1));
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.pubbar__state')).toHaveText('Saved · rev 3');
    await expect(page.getByTestId('listen-tabchip')).toHaveText('stale');

    await page.getByRole('tab', { name: /^Listen/ }).click();
    const panel = page.locator('#panel-listen');
    await expect(panel.getByTestId('listen-status')).toHaveText('Listen · Text changed — re-sync');
    const warning = panel.locator('.listentab__stale');
    await expect(warning).toContainText('1 paragraph is new or edited and has no mark');
    await expect(warning).toContainText('1 mark belongs to paragraphs that were removed');
    await expect(warning).toContainText('the recording no longer matches — upload a new reading');
    const editedRow = panel.locator('.marklist__row', { hasText: 'The same words become a page' });
    await expect(editedRow.locator('.marklist__badge')).toHaveText('no mark');

    // Nothing re-synced by itself: the draft marks are the saved ones, the old pid now an orphan.
    const state = (await (await page.request.get(`/api/admin/articles/${articleId}/listen`)).json()).data as {
      status: string;
      marks: Mark[];
      orphanPids: string[];
      missingPids: string[];
    };
    expect(state.status).toBe('stale');
    expect(state.marks).toEqual(marks);
    expect(state.orphanPids).toEqual([marks[1].pid]);
    expect(state.missingPids).toHaveLength(1);

    await page.getByRole('tab', { name: 'Write' }).click();
    await page.getByRole('button', { name: 'Publish changes' }).click();
    const popover = page.getByRole('alertdialog', { name: 'Can’t publish yet' });
    await expect(popover).toBeVisible();
    await expect(popover).toContainText('re-sync the changed paragraphs in the Listen tab');
    await popover.getByRole('button', { name: 'Go to Listen' }).click();
    await expect(popover).toBeHidden();
    await expect(page.getByRole('tab', { name: /^Listen/ })).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toBeVisible();

    // The live page still plays the previously published reading with its marks and old text.
    const live = await page.request.get(`/api/public/articles/${slug}/listen`, { headers: { origin } });
    expect(live.status()).toBe(200);
    expect((await live.json()).data).toMatchObject({ audio: { url: audio.url }, marks });
    await page.goto(`/p/${slug}/listen`);
    const view = page.locator('section.listenview');
    await expect(view.locator('audio source')).toHaveAttribute('src', audio.url);
    await expect(view.locator('.listenview__text')).toContainText(PARAS[1]);
    await expect(view.locator('.listenview__text')).not.toContainText(EDITED_PARA_1);
    await setReaderTime(page, (marks[1].tMs + 50) / 1000);
    await expect.poll(() => livePids(page)).toEqual([marks[1].pid]);
  });

  test('home card: Listen opens the compact player overlay (no text column); the address is unchanged', async () => {
    const { page, audio } = journey();
    await page.goto('/');
    const quick = page.getByRole('button', { name: `Listen to ${TITLE} — 1 min`, exact: true });
    await expect(quick).toBeVisible();

    await quick.click();

    const overlay = page.locator('.sheetfull');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.modebar__mode')).toHaveText('Listen');
    await expect(overlay.locator('.modebar__title')).toHaveText(TITLE);
    await expect(overlay.locator('.listenview .audio')).toBeVisible();
    await expect(overlay.locator('.listenview audio source')).toHaveAttribute('src', audio.url);
    await expect(overlay.locator('.listenview__text, .para')).toHaveCount(0);
    await expect(overlay.locator('.modedock').getByRole('tab', { name: 'Listen — 1 min' })).toHaveAttribute('aria-selected', 'true');
    expect(new URL(page.url()).pathname).toBe('/');

    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden();
  });

  test('Listen never calls the LLM: zero ai_generation rows for this article and none added overall', async () => {
    const { articleId, aiRowsBefore } = journey();
    expect(await aiGenerationCount(articleId)).toBe(0);
    expect(await aiGenerationCount()).toBe(aiRowsBefore);
  });
});
