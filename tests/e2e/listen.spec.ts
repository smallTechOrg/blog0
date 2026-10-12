import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';

import { countWords, estimateMarks } from '@/lib/listen/estimate';

import { createArticleApi, originOf, signIn } from './helpers/admin';
import { withTestDb } from './helpers/db';
import { AUDIO_FIXTURE, IMAGE_FIXTURE, audioFixtureMeta, expectRange206, pngFixtureMeta } from './helpers/upload';

// Listen walk (capabilities listen-audio, listen-sync, media-images; spec/roadmap.md "How the user
// tests it"): sign in → a fresh four-paragraph article (the words of the committed reading,
// tests/fixtures/audio/sample.json) → Listen tab: upload sample.mp3 → Ready at once (preview player
// + estimated-timing note, no tap-along controls) → Write tab: Image uploads sample.png →
// `![…](/media/…)` at the cursor → Publish (never blocked by Listen) → /p/<slug>: capsule
// "Listen · 1 min" → Listen view: the soft highlight follows currentTime on the server-estimated
// marks; a wheel scroll pauses following and shows Follow audio; seeking while paused leaves the
// page where it is; Follow audio scrolls back and resumes; PageDown with ▶ focused pauses again;
// a paragraph click seeks and resumes → /media/<key> answers 206 → upload is locked while the
// text is unsaved → edit a paragraph + Save → "text changed" warning, Publish changes still works
// and the live Listen follows the new text → home card Listen opens the player-only overlay →
// reverting the paragraph clears the warning → ← Desk confirms with unsaved text. Listen never
// calls the LLM: zero new ai_generation rows.
//
// Runs after tldr.spec.ts and reader.spec.ts (project dependencies in playwright.config.ts), so
// the home card and the Listen quick button for this article cannot disturb their assertions.

const AUDIO = audioFixtureMeta();
const PNG = pngFixtureMeta();
const TITLE = 'Listen walk: one text, three shapes';
const TOPIC = 'Notes';
const DEK = 'A spoken reading that the text follows along with.';
/** The fixture reading's words, as four paragraphs (sample.json → text). */
const PARAS = [
  'blog0 is a small publishing platform for writers who want every article to reach readers in more than one shape.',
  'You write once in Markdown. The same text becomes a readable page, a short slide deck, and a spoken reading you can listen to.',
  'Nothing is generated behind your back; every format is reviewed before it is published.',
  'Readers pick the shape that fits their moment.',
];
const EDITED_PARA_1 = 'You write once in Markdown. The same words become a page, a deck, and a reading.';
/**
 * Test-only spacing between the Listen view's paragraphs: the four short paragraphs of the reading
 * would otherwise all fit in the viewport, and following / pausing would never need to scroll.
 */
const SPREAD_PARAS_CSS = '.listenview__text .para[data-pid] { margin-bottom: 520px !important; }';

interface Mark {
  pid: string;
  tMs: number;
}

interface PublicListen {
  audio: { url: string; durationMs: number };
  marks: Mark[];
  timing: 'synced' | 'estimated';
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

/** The marks the reader must get for these paragraphs: estimateMarks over countWords, by value. */
function expectedMarks(pids: string[], paras: string[], durationMs: number): Mark[] {
  expect(pids).toHaveLength(paras.length);
  return estimateMarks(
    pids.map((pid, i) => ({ pid, words: countWords(paras[i]) })),
    durationMs,
  );
}

async function publicListen(page: Page, slug: string): Promise<PublicListen> {
  const res = await page.request.get(`/api/public/articles/${slug}/listen`);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).data as PublicListen;
}

async function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY);
}

/** No tap-along control anywhere on the page (timing is estimated, never tapped). */
async function expectNoTapAlong(scope: Locator): Promise<void> {
  await expect(scope.getByRole('button', { name: /start syncing|save sync|tap|nudge|redo|undo|discard changes/i })).toHaveCount(0);
  await expect(scope.getByText(/Start syncing|Save sync|Needs sync|paragraph \d+ starts now/)).toHaveCount(0);
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

test.describe('Listen walk: upload → ready → image → publish → follow along → text changed', () => {
  test.beforeAll(async ({ browser }, testInfo) => {
    j.origin = originOf(testInfo);
    j.context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    j.page = await j.context.newPage();
    j.aiRowsBefore = await aiGenerationCount();
  });

  test.afterAll(async () => {
    await j.context?.close();
  });

  test('sign in and create a four-paragraph article (the reading’s words)', async () => {
    const { page, origin } = journey();
    await signIn(page);

    const article = await createArticleApi(page.request, origin, { title: TITLE, topic: TOPIC, dek: DEK, bodyMd: PARAS.join('\n\n') + '\n' });
    j.articleId = article.id;
    j.slug = article.slug;
    expect(AUDIO.text).toBe(PARAS.join(' '));
  });

  test('Listen tab: upload sample.mp3 → Ready at once, with the preview player and the estimated-timing note; no tap-along', async () => {
    const { page, articleId } = journey();
    await page.goto(`/admin/articles/${articleId}`);
    await expect(page.locator('.pubbar__state')).toHaveText('Saved · rev 1');

    await page.getByRole('tab', { name: /^Listen/ }).click();
    const panel = page.locator('#panel-listen');
    const status = panel.getByTestId('listen-status');
    await expect(status).toHaveText('Listen · No recording');
    await expect(panel.locator('.dropzone')).toContainText('mp3 or m4a · up to');
    await expect(panel.getByText('Readers get it on the next publish.')).toBeVisible();

    await panel.getByTestId('audio-file-input').setInputFiles(AUDIO_FIXTURE.mp3);

    await expect(status).toHaveText('Listen · Ready');
    await expect(page.getByTestId('listen-tabchip')).toHaveText('ready');
    await expect(panel.getByText(/^Recording ready · uploaded .+ by .+\. Readers get it on the next publish\.$/)).toBeVisible();
    const preview = panel.getByTestId('listen-preview');
    await expect(preview.locator('.audio .audio__play')).toBeVisible();
    await expect(preview.locator('audio source')).toHaveAttribute('src', /^\/media\/.+\.mp3$/);
    await expect(preview.locator('.audio__note')).toContainText('min');
    await expect(panel.locator('.recording__file')).toContainText('sample.mp3');
    await expect(panel.getByTestId('listen-timing')).toContainText('estimated timing');
    await expect(panel.getByTestId('listen-timing')).toHaveAttribute('data-timing', 'estimated');
    await expect(panel.getByRole('button', { name: 'Replace…' })).toBeEnabled();
    await expect(panel.getByTestId('listen-text-changed')).toHaveCount(0);
    await expectNoTapAlong(page.locator('body'));
    // Chromium decodes the mp3 in the preview player.
    await expect
      .poll(() => preview.locator('audio').evaluate((a: HTMLAudioElement) => (a.readyState >= 1 ? Math.round(a.duration * 1000) : -1)))
      .toBeGreaterThan(AUDIO.mp3.durationMs - 1000);

    const res = await page.request.get(`/api/admin/articles/${articleId}/listen`);
    expect(res.status()).toBe(200);
    const listen = (await res.json()).data as {
      status: string;
      marks: Mark[];
      timing: string | null;
      textChangedSinceUpload: boolean;
      uploadFingerprint: string | null;
      audio: { key: string; url: string; bytes: number; mimeType: string };
    };
    expect(listen).toMatchObject({ status: 'ready', marks: [], timing: 'estimated', textChangedSinceUpload: false });
    expect(listen.uploadFingerprint).toBeTruthy();
    expect(listen.audio).toMatchObject({ mimeType: 'audio/mpeg', bytes: AUDIO.mp3.bytes });
    j.audio = { key: listen.audio.key, url: listen.audio.url, bytes: listen.audio.bytes };
  });

  test('Write tab: Image uploads sample.png → ![…](/media/….png) at the cursor, the preview shows the figure; Save keeps Listen ready', async () => {
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
    // An image alone is not a paragraph: the recording still matches the text.
    await expect(page.getByTestId('listen-tabchip')).toHaveText('ready');
  });

  test('Publish (no block) → the public article: capsule reads Listen · 1 min; the figure is served; estimated marks by value', async () => {
    const { page, slug } = journey();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByRole('link', { name: 'View live ↗' })).toBeVisible();
    await expect(page.getByRole('alertdialog', { name: 'Can’t publish yet' })).toHaveCount(0);

    const live = await publicListen(page, slug);
    expect(live.timing).toBe('estimated');
    expect(live.audio.url).toBe(j.audio!.url);
    expect(live.marks).toEqual(expectedMarks(live.marks.map((m) => m.pid), PARAS, live.audio.durationMs));
    expect(live.marks[0].tMs).toBe(0);
    for (let k = 1; k < live.marks.length; k += 1) expect(live.marks[k].tMs).toBeGreaterThan(live.marks[k - 1].tMs);
    j.marks = live.marks;

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
    await page.evaluate(() => window.scrollTo(0, 0));
  });

  test('Listen view: the soft highlight follows currentTime; wheel pauses following + shows Follow audio; Follow audio resumes; paragraph click seeks', async () => {
    const { page, slug, marks, audio } = journey();
    await page.locator('.modedock').getByRole('tab', { name: 'Listen — 1 min' }).click();

    await expect(page).toHaveURL(new RegExp(`/p/${slug}/listen$`));
    const view = page.locator('section.listenview');
    await expect(view).toBeVisible();
    const lead = view.locator('.listenview__lead');
    const text = view.locator('.listenview__text');
    // Located by class: while hidden it is outside the accessibility tree.
    const follow = view.locator('button.listenview__follow');
    await expect(lead.locator('.audio')).toBeVisible();
    await expect(text.locator('.para[data-pid]')).toHaveCount(PARAS.length);
    expect(await text.locator('.para[data-pid]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.pid))).toEqual(
      marks.map((m) => m.pid),
    );
    // Side by side on a desktop viewport: the player column ends where the text column begins.
    const [leadBox, textBox] = [await lead.boundingBox(), await text.boundingBox()];
    expect(leadBox && textBox).toBeTruthy();
    expect(leadBox!.x + leadBox!.width).toBeLessThanOrEqual(textBox!.x + 1);
    await expect(view.locator('audio source')).toHaveAttribute('src', audio.url);
    await expect(view.locator('audio source')).toHaveAttribute('src', /\.mp3$/);
    await expect(follow).toHaveText('Follow audio');
    await expect(follow).toBeHidden(); // following when the view opens
    await expect(follow).toHaveAttribute('aria-controls', (await text.getAttribute('id'))!);
    // Estimated marks start at 0: paragraph 1 is live while paused at 0.
    await expect.poll(() => livePids(page)).toEqual([marks[0].pid]);

    // ▶ plays: the position passes 1 s within 3 s.
    await view.getByRole('button', { name: 'Play' }).click();
    await expect.poll(() => view.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime), { timeout: 3_000 }).toBeGreaterThan(1);
    await view.getByRole('button', { name: 'Pause' }).click();

    // The highlight is SOFT: --listen-live-bg (= --accent-softer), not the share highlight's --accent-soft.
    const colors = await view.evaluate((section) => {
      const probe = (v: string) => {
        const el = document.createElement('div');
        el.style.background = v;
        section.appendChild(el);
        const c = getComputedStyle(el).backgroundColor;
        el.remove();
        return c;
      };
      const liveEl = section.querySelector('.para.is-live');
      return { live: liveEl ? getComputedStyle(liveEl).backgroundColor : null, softer: probe('var(--accent-softer)'), share: probe('var(--accent-soft)') };
    });
    expect(colors.live).toBe(colors.softer);
    expect(colors.live).not.toBe(colors.share);

    // Spread the paragraphs out so following really has to scroll.
    await page.addStyleTag({ content: SPREAD_PARAS_CSS });
    for (const k of [0, 2, marks.length - 1]) {
      await setReaderTime(page, (marks[k].tMs + 50) / 1000);
      await expect.poll(() => livePids(page)).toEqual([marks[k].pid]);
      await expect(text.locator(`.para[data-pid="${marks[k].pid}"]`)).toBeInViewport();
    }
    await expect(follow).toBeHidden();

    // A wheel scroll (1 200 px up, over the text) pauses following: Follow audio appears.
    const lastPara = text.locator(`.para[data-pid="${marks[marks.length - 1].pid}"]`);
    await page.waitForTimeout(800); // let the last smooth scroll settle
    const followedAt = await scrollY(page);
    const textX = (await text.boundingBox())!;
    await page.mouse.move(textX.x + textX.width / 2, 360);
    await page.mouse.wheel(0, -1200);
    await expect(follow).toBeVisible();
    await expect.poll(() => scrollY(page)).toBeLessThan(followedAt - 600);
    await page.waitForTimeout(400);
    const pausedAt = await scrollY(page);
    await expect(lastPara).not.toBeInViewport();

    // Seeking while paused moves the highlight but never the page.
    await setReaderTime(page, (marks[2].tMs + 50) / 1000);
    await expect.poll(() => livePids(page)).toEqual([marks[2].pid]);
    await setReaderTime(page, (marks[marks.length - 1].tMs + 50) / 1000);
    await expect.poll(() => livePids(page)).toEqual([marks[marks.length - 1].pid]);
    await page.waitForTimeout(800); // a smooth scroll would have started by now
    expect(Math.abs((await scrollY(page)) - pausedAt)).toBeLessThanOrEqual(2);
    await expect(lastPara).not.toBeInViewport();

    // Follow audio: hidden again, the live paragraph is brought into view at once, focus moves to ▶.
    await follow.click();
    await expect(follow).toBeHidden();
    await expect(lastPara).toBeInViewport({ timeout: 2_000 });
    await expect(view.locator('.audio__play')).toBeFocused();

    // PageDown with ▶ focused is a manual scroll too: following pauses, Follow audio is back.
    await page.keyboard.press('PageDown');
    await expect(follow).toBeVisible();
    await follow.click();
    await expect(follow).toBeHidden();

    // A paragraph click seeks the audio to its estimated start and resumes following.
    await page.mouse.move(textX.x + textX.width / 2, 360);
    await page.mouse.wheel(0, -1200);
    await expect(follow).toBeVisible();
    await text.locator(`.para[data-pid="${marks[1].pid}"]`).click();
    await expect
      .poll(() => view.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime))
      .toBeGreaterThanOrEqual(marks[1].tMs / 1000 - 0.05);
    const t = await view.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime);
    expect(Math.abs(t - marks[1].tMs / 1000)).toBeLessThanOrEqual(0.05);
    await expect.poll(() => livePids(page)).toEqual([marks[1].pid]);
    await expect(follow).toBeHidden();

    // The seek bar: drag to just after paragraph 3's mark → the highlight jumps there.
    const seekS = Math.ceil((marks[2].tMs + 50) / 250) * 0.25;
    expect(seekS * 1000).toBeLessThan(marks[3].tMs);
    await view.getByRole('slider', { name: 'Seek' }).fill(String(seekS));
    await expect.poll(() => livePids(page)).toEqual([marks[2].pid]);
    await expect.poll(() => view.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime)).toBeCloseTo(seekS, 1);

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

  test('upload is locked while the text is unsaved; editing a paragraph → text changed warning; Publish changes is not blocked and the live Listen follows the new text', async () => {
    const { page, articleId, slug, audio, marks } = journey();
    await page.goto(`/admin/articles/${articleId}`);
    const textarea = page.getByLabel('Markdown', { exact: true });
    const before = await textarea.inputValue();
    expect(before).toContain(PARAS[1]);
    await textarea.fill(before.replace(PARAS[1], EDITED_PARA_1));
    await expect(page.locator('.pubbar__state')).toHaveText('Unsaved changes');

    // Unsaved text: the Listen tab locks uploading with the save-first hint.
    await page.getByRole('tab', { name: /^Listen/ }).click();
    const panel = page.locator('#panel-listen');
    await expect(panel.getByTestId('listen-status')).toHaveText('Listen · Ready');
    await expect(panel.getByTestId('upload-locked')).toHaveText(
      'Save your text changes first — the recording is matched against the saved article.',
    );
    await expect(panel.getByRole('button', { name: 'Replace…' })).toBeDisabled();

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.pubbar__state')).toHaveText('Saved · rev 3');
    await expect(page.getByTestId('listen-tabchip')).toHaveText('text changed');
    await expect(panel.getByTestId('listen-status')).toHaveText('Listen · Text changed');
    const warning = panel.getByTestId('listen-text-changed');
    await expect(warning).toContainText('The recording may no longer match the text');
    await expect(warning).toContainText('Publishing is not blocked.');
    await expect(panel.getByTestId('upload-locked')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Replace…' })).toBeEnabled();
    await warning.getByRole('button', { name: 'Upload a new recording' }).click();
    await expect(panel.getByRole('button', { name: 'Replace…' })).toBeFocused();
    await expectNoTapAlong(page.locator('body'));

    const state = (await (await page.request.get(`/api/admin/articles/${articleId}/listen`)).json()).data as {
      status: string;
      textChangedSinceUpload: boolean;
      marks: Mark[];
    };
    expect(state).toMatchObject({ status: 'text_changed', textChangedSinceUpload: true, marks: [] });

    // Publish changes: no block, no popover.
    await page.getByRole('button', { name: 'Publish changes' }).click();
    await expect(page.getByRole('alertdialog', { name: 'Can’t publish yet' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Publish changes' })).toBeDisabled();
    // The warning persists after publishing (only a re-upload or a revert clears it).
    await expect(page.getByTestId('listen-tabchip')).toHaveText('text changed');

    // The live Listen: same audio, re-estimated over the new text (new pid for the edited paragraph).
    const live = await publicListen(page, slug);
    const newParas = [PARAS[0], EDITED_PARA_1, PARAS[2], PARAS[3]];
    expect(live.audio.url).toBe(audio.url);
    expect(live.timing).toBe('estimated');
    expect(live.marks).toEqual(expectedMarks(live.marks.map((m) => m.pid), newParas, live.audio.durationMs));
    expect(live.marks.map((m) => m.pid)).not.toContain(marks[1].pid);
    expect(live.marks[0].pid).toBe(marks[0].pid);

    await page.goto(`/p/${slug}/listen`);
    const view = page.locator('section.listenview');
    await expect(view.locator('audio source')).toHaveAttribute('src', audio.url);
    await expect(view.locator('.listenview__text')).toContainText(EDITED_PARA_1);
    await expect(view.locator('.listenview__text')).not.toContainText(PARAS[1]);
    await setReaderTime(page, (live.marks[1].tMs + 50) / 1000);
    await expect.poll(() => livePids(page)).toEqual([live.marks[1].pid]);
  });

  test('home card: Listen opens the player-only overlay (no text, no highlight); the address is unchanged', async () => {
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
    await expect(overlay.locator('.listenview__text, .para, .listenview__follow')).toHaveCount(0);
    await expect(overlay.locator('.modedock').getByRole('tab', { name: 'Listen — 1 min' })).toHaveAttribute('aria-selected', 'true');
    expect(new URL(page.url()).pathname).toBe('/');

    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden();
  });

  test('reverting the paragraph clears the warning → Ready', async () => {
    const { page, articleId } = journey();
    await page.goto(`/admin/articles/${articleId}`);
    const textarea = page.getByLabel('Markdown', { exact: true });
    await textarea.fill((await textarea.inputValue()).replace(EDITED_PARA_1, PARAS[1]));
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.pubbar__state')).toHaveText('Saved · rev 4');
    await expect(page.getByTestId('listen-tabchip')).toHaveText('ready');
    await page.getByRole('tab', { name: /^Listen/ }).click();
    const panel = page.locator('#panel-listen');
    await expect(panel.getByTestId('listen-status')).toHaveText('Listen · Ready');
    await expect(panel.getByTestId('listen-text-changed')).toHaveCount(0);
  });

  test('← Desk asks before leaving with unsaved text; cancel stays in the editor', async () => {
    const { page, articleId } = journey();
    await page.goto(`/admin/articles/${articleId}`);
    const textarea = page.getByLabel('Markdown', { exact: true });
    await textarea.fill((await textarea.inputValue()) + '\nunsaved words');
    await expect(page.locator('.pubbar__state')).toHaveText('Unsaved changes');
    const dialogs: string[] = [];
    page.once('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await page.getByRole('link', { name: '← Desk' }).click();
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toContain('unsaved changes');
    await expect(page).toHaveURL(new RegExp(`/admin/articles/${articleId}$`));
    await expect(textarea).toHaveValue(/unsaved words$/);
  });

  test('Listen never calls the LLM: zero ai_generation rows for this article and none added overall', async () => {
    const { articleId, aiRowsBefore } = journey();
    expect(await aiGenerationCount(articleId)).toBe(0);
    expect(await aiGenerationCount()).toBe(aiRowsBefore);
  });
});
