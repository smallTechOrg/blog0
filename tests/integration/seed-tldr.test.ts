// Seed decks (S2.7, `pnpm seed:tldr`) against real blog0_test Postgres:
//   - fixture path (no AI): 5 published decks from src/server/seed/decks/*.json, every line verbatim
//     in its article, editors' disclosure, 0 ai_generation rows; a mangled fixture line is dropped
//     with a logged warning and the deck still publishes; idempotent; never publishes a writer's
//     unpublished edits.
//   - real-key path: 5 real Jev calls once (normal Generate: ai_generation rows, cost, prompt
//     version), 5 published Jev decks, then 0 calls; --write-fixture captures them.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { updateArticle } from '@/server/articles/service';
import { renderArticle } from '@/server/content';
import { closeDb, getDb } from '@/server/db/client';
import { aiGeneration, article, articleFormat, type SiteRow } from '@/server/db/schema';
import { readTldrPayload, type TldrPayload } from '@/server/formats';
import { JEV_PROMPT_VERSION } from '@/server/jev/prompt';
import { resetLlmClientForTests } from '@/server/llm';
import { openRouterKeyStatus, PENDING_KEY_REASON } from '@/server/llm/key';
import { getPublishedArticle } from '@/server/public/articles';
import { DECKS_DIR, loadDeckFixture } from '@/server/seed/decks';
import { loadSeedPosts, SEED_POSTS } from '@/server/seed/posts';
import { seedPosts } from '@/server/seed/seed-posts';
import { formatSeedTldrSummary, SeedTldrError, seedTldr } from '@/server/seed/seed-tldr';
import { resetCurrentSiteForTests } from '@/server/site/current';

import { resetDb } from '../helpers/db';
import { captureLogs, type CapturedLogs } from '../helpers/logs';
import { loginAs, type TestLogin } from '../helpers/session';

const ALL_SLUGS = SEED_POSTS.map((p) => p.slug);
const EDITORS = 'Lines selected by the editors, verbatim from the article.';
const JEV_ONLY = 'Lines selected by Jev (AI), verbatim from the article.';

const keyStatus = openRouterKeyStatus(process.env.BLOG0_OPENROUTER_API_KEY);
const pendingKey = keyStatus !== 'real';
const ci = process.env.CI === 'true';
if (pendingKey && !ci) console.warn(`[seed-tldr] ${PENDING_KEY_REASON} (key ${keyStatus}); the real-key seed suite is skipped.`);

describe.runIf(pendingKey && ci)('seed:tldr real-key requirement under CI', () => {
  it(`fails: ${PENDING_KEY_REASON} (CI=true requires a real key)`, () => {
    throw new Error(`${PENDING_KEY_REASON} (key ${keyStatus}) — CI=true requires a real OpenRouter key; this is a failure, not a skip.`);
  });
});

let siteRow: SiteRow;
let admin: TestLogin;
let logs: CapturedLogs;
let tmp: string | null = null;

beforeEach(async () => {
  siteRow = await resetDb();
  resetCurrentSiteForTests();
  resetLlmClientForTests();
  admin = await loginAs({ displayName: 'Seed Admin' });
  await seedPosts(getDb(), siteRow.id, admin.user.id);
  logs = captureLogs();
});

afterEach(() => {
  logs.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

/** A temp copy of the committed fixtures (so a test can mangle one without touching the repo). */
function fixtureCopy(): string {
  tmp = mkdtempSync(path.join(tmpdir(), 'blog0-seed-decks-'));
  for (const slug of ALL_SLUGS) cpSync(path.join(DECKS_DIR, `${slug}.json`), path.join(tmp, `${slug}.json`));
  return tmp;
}

async function decksBySlug(): Promise<Map<string, { articleId: string; publishedRevisionId: string | null; published: TldrPayload | null; draft: TldrPayload | null; formatPublishedRevisionId: string | null }>> {
  const rows = await getDb()
    .select({ slug: article.slug, articleId: article.id, publishedRevisionId: article.publishedRevisionId, format: articleFormat })
    .from(article)
    .leftJoin(articleFormat, and(eq(articleFormat.articleId, article.id), eq(articleFormat.kind, 'tldr')))
    .where(eq(article.siteId, siteRow.id));
  return new Map(
    rows.map((r) => [
      r.slug,
      {
        articleId: r.articleId,
        publishedRevisionId: r.publishedRevisionId,
        published: readTldrPayload(r.format?.publishedPayload),
        draft: readTldrPayload(r.format?.draftPayload),
        formatPublishedRevisionId: r.format?.publishedRevisionId ?? null,
      },
    ]),
  );
}

async function eligibleTexts(slug: string): Promise<Set<string>> {
  const post = loadSeedPosts().find((p) => p.slug === slug)!;
  const rendered = await renderArticle({ title: post.title, dek: post.dek, bodyMd: post.bodyMd });
  return new Set(rendered.sentences.map((s) => s.text));
}

async function generationCount(): Promise<number> {
  return (await getDb().select({ id: aiGeneration.id }).from(aiGeneration).where(eq(aiGeneration.siteId, siteRow.id))).length;
}

describe('seedTldr — fixture path (no AI call)', () => {
  it('publishes 5 decks from the committed fixtures, verbatim, with the editors’ disclosure and 0 generations', async () => {
    const result = await seedTldr(getDb(), siteRow.id, admin.user.id, { source: 'fixture' });
    expect(result).toMatchObject({ source: 'fixture', seeded: ALL_SLUGS, skipped: [], failed: [], calls: 0, costUsd: null, warnings: [] });
    expect(formatSeedTldrSummary(result)).toBe('decks: 5 seeded (0 calls)');
    expect(await generationCount()).toBe(0);

    const decks = await decksBySlug();
    for (const slug of ALL_SLUGS) {
      const deck = decks.get(slug)!;
      const fixture = loadDeckFixture(slug)!;
      expect(deck.published, slug).not.toBeNull();
      expect(deck.published!.slides.map((s) => s.text)).toEqual(fixture.lines.map((l) => l.text));
      expect(deck.published!.generationId).toBeNull();
      expect(deck.published!.slides.every((s) => s.source === 'writer' && s.reason === null)).toBe(true);
      expect(deck.draft).toEqual(deck.published); // no unpublished changes left behind
      expect(deck.formatPublishedRevisionId).toBe(deck.publishedRevisionId);
      const eligible = await eligibleTexts(slug);
      for (const slide of deck.published!.slides) expect(eligible.has(slide.text), slide.text).toBe(true);
    }

    // The reader sees it, with the editors' disclosure.
    resetCurrentSiteForTests();
    const page = await getPublishedArticle('humans-are-software');
    expect(page?.deck?.slides.map((s) => s.text)).toEqual(loadDeckFixture('humans-are-software')!.lines.map((l) => l.text));
    expect(page?.deck?.disclosure).toBe(EDITORS);
  });

  it('drops a mangled fixture line with a logged warning and still publishes the deck', async () => {
    const dir = fixtureCopy();
    const file = path.join(dir, 'humans-are-software.json');
    const fixture = JSON.parse(readFileSync(file, 'utf8')) as { lines: Array<{ text: string; reason: string }> };
    const original = fixture.lines.map((l) => l.text);
    fixture.lines[1].text = `${fixture.lines[1].text.slice(0, -1)} (edited)`;
    writeFileSync(file, JSON.stringify(fixture));

    const result = await seedTldr(getDb(), siteRow.id, admin.user.id, { source: 'fixture', fixtureDir: dir });
    expect(result.seeded).toEqual(ALL_SLUGS);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^humans-are-software: fixture line dropped/);
    const warned = logs.find('seed.tldr.fixture_line_unmatched');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ level: 'warn', slug: 'humans-are-software', source: 'fixture' });

    const deck = (await decksBySlug()).get('humans-are-software')!;
    expect(deck.published!.slides.map((s) => s.text)).toEqual(original.filter((_, i) => i !== 1));
    expect(await generationCount()).toBe(0);
  });

  it('is idempotent: a second run seeds nothing and changes nothing (also after a fresh connection)', async () => {
    await seedTldr(getDb(), siteRow.id, admin.user.id, { source: 'fixture' });
    const before = await getDb().select().from(articleFormat).where(eq(articleFormat.siteId, siteRow.id));

    const again = await seedTldr(getDb(), siteRow.id, admin.user.id, { source: 'fixture' });
    expect(again).toMatchObject({ seeded: [], skipped: ALL_SLUGS, failed: [], calls: 0, costUsd: null });
    expect(formatSeedTldrSummary(again)).toBe('decks: 0 seeded (0 calls)');

    await closeDb();
    const third = await seedTldr(getDb(), siteRow.id, admin.user.id, { source: 'auto' });
    expect(third).toMatchObject({ seeded: [], skipped: ALL_SLUGS, calls: 0 });
    const after = await getDb().select().from(articleFormat).where(eq(articleFormat.siteId, siteRow.id));
    expect(after).toEqual(before);
    expect(await generationCount()).toBe(0);
  });

  it('edge: a missing fixture file or a fixture with no matching line skips only that post, with a warning', async () => {
    const dir = fixtureCopy();
    rmSync(path.join(dir, 'ai-is-expensive.json'));
    const file = path.join(dir, 'tech-company-first.json');
    const fixture = JSON.parse(readFileSync(file, 'utf8')) as { lines: Array<{ text: string; reason: string }> };
    fixture.lines = fixture.lines.map((l) => ({ ...l, text: l.text.toUpperCase() }));
    writeFileSync(file, JSON.stringify(fixture));

    const result = await seedTldr(getDb(), siteRow.id, admin.user.id, { source: 'fixture', fixtureDir: dir });
    expect(result.seeded).toEqual(ALL_SLUGS.filter((s) => s !== 'ai-is-expensive' && s !== 'tech-company-first'));
    expect(result.failed.sort()).toEqual(['ai-is-expensive', 'tech-company-first']);
    expect(result.warnings.some((w) => w.startsWith('ai-is-expensive: no fixture'))).toBe(true);
    expect(result.warnings.some((w) => w.startsWith('tech-company-first: no fixture line matches'))).toBe(true);
    const decks = await decksBySlug();
    expect(decks.get('ai-is-expensive')!.published).toBeNull();
    expect(decks.get('tech-company-first')!.published).toBeNull();
  });

  it('never publishes a writer’s unpublished edits: that post is skipped with a warning', async () => {
    const target = (await decksBySlug()).get('artefact-driven-development')!;
    const [row] = await getDb().select().from(article).where(eq(article.id, target.articleId));
    await updateArticle({ siteId: siteRow.id, user: admin.user }, row.id, { baseRevisionId: row.currentRevisionId!, title: 'Artefact Driven Development (draft edit)' });

    const result = await seedTldr(getDb(), siteRow.id, admin.user.id, { source: 'fixture' });
    expect(result.failed).toEqual(['artefact-driven-development']);
    expect(result.warnings[0]).toMatch(/unpublished changes/);
    const [after] = await getDb().select().from(article).where(eq(article.id, row.id));
    expect(after.publishedRevisionId).toBe(row.publishedRevisionId);
    expect(after.currentRevisionId).not.toBe(after.publishedRevisionId);
    expect((await decksBySlug()).get('artefact-driven-development')!.published).toBeNull();
  });

  it('errors: an unknown user, and --write-fixture without Jev, are refused before anything is written', async () => {
    await expect(seedTldr(getDb(), siteRow.id, '00000000-0000-4000-8000-000000000000', { source: 'fixture' })).rejects.toThrow(/not an admin of this site/);
    await expect(seedTldr(getDb(), siteRow.id, admin.user.id, { source: 'fixture', writeFixture: true })).rejects.toThrow(SeedTldrError);
    const formats = await getDb().select().from(articleFormat).where(eq(articleFormat.siteId, siteRow.id));
    expect(formats).toHaveLength(0);
  });
});

describe.skipIf(pendingKey)(pendingKey ? `seedTldr — real Jev — ${PENDING_KEY_REASON}` : 'seedTldr — real Jev', () => {
  it('5 real calls once (normal Generate rows + cost), 5 published Jev decks, then 0 calls; --write-fixture captures them', async () => {
    const first = await seedTldr(getDb(), siteRow.id, admin.user.id, { source: 'auto' });
    expect(first.source).toBe('jev');
    expect(first.seeded).toEqual(ALL_SLUGS);
    expect(first.failed).toEqual([]);
    expect(first.calls).toBe(5);
    expect(first.costUsd).toBeGreaterThan(0);
    expect(first.costUsd).toBeLessThan(0.05);
    expect(formatSeedTldrSummary(first)).toMatch(/^decks: 5 seeded \(5 calls, \$0\.\d{4}\)$/);

    const generations = await getDb().select().from(aiGeneration).where(eq(aiGeneration.siteId, siteRow.id));
    expect(generations).toHaveLength(5);
    for (const g of generations) {
      expect(g).toMatchObject({ status: 'succeeded', task: 'tldr.select', formatKind: 'tldr', requestedBy: admin.user.id, promptVersion: JEV_PROMPT_VERSION });
      expect(Number(g.costUsd)).toBeGreaterThan(0);
    }

    const decks = await decksBySlug();
    for (const slug of ALL_SLUGS) {
      const deck = decks.get(slug)!;
      expect(deck.published, slug).not.toBeNull();
      const slides = deck.published!.slides;
      expect(slides.length).toBeGreaterThanOrEqual(4);
      expect(slides.length).toBeLessThanOrEqual(8);
      expect(slides.every((s) => s.source === 'jev' && (s.reason ?? '').length > 0)).toBe(true);
      expect(generations.map((g) => g.id)).toContain(deck.published!.generationId);
      expect(generations.find((g) => g.id === deck.published!.generationId)!.articleId).toBe(deck.articleId);
      expect(deck.formatPublishedRevisionId).toBe(deck.publishedRevisionId);
      const eligible = await eligibleTexts(slug);
      for (const s of slides) expect(eligible.has(s.text), s.text).toBe(true);
    }
    resetCurrentSiteForTests();
    expect((await getPublishedArticle('tech-company-first'))?.deck?.disclosure).toBe(JEV_ONLY);

    // Second run (with --write-fixture into a temp dir): 0 calls, no new rows, fixtures = live decks.
    tmp = mkdtempSync(path.join(tmpdir(), 'blog0-seed-capture-'));
    const second = await seedTldr(getDb(), siteRow.id, admin.user.id, { source: 'auto', writeFixture: true, fixtureDir: tmp });
    expect(second).toMatchObject({ seeded: [], skipped: ALL_SLUGS, calls: 0, costUsd: null });
    expect(formatSeedTldrSummary(second)).toBe('decks: 0 seeded (0 calls)');
    expect(await generationCount()).toBe(5);
    expect(second.fixturesWritten).toHaveLength(5);
    for (const slug of ALL_SLUGS) {
      const captured = loadDeckFixture(slug, tmp)!;
      const deck = decks.get(slug)!.published!;
      expect(captured.lines).toEqual(deck.slides.map((s) => ({ text: s.text, reason: s.reason })));
      expect(captured.promptVersion).toBe(JEV_PROMPT_VERSION);
    }
  });

  it('a post already seeded from the fixture is never re-generated (0 calls with a real key)', async () => {
    await seedTldr(getDb(), siteRow.id, admin.user.id, { source: 'fixture' });
    const result = await seedTldr(getDb(), siteRow.id, admin.user.id, { source: 'auto' });
    expect(result).toMatchObject({ source: 'jev', seeded: [], skipped: ALL_SLUGS, calls: 0 });
    expect(await generationCount()).toBe(0);
    // --write-fixture refuses to capture editor decks as "Jev output".
    tmp = mkdtempSync(path.join(tmpdir(), 'blog0-seed-capture-'));
    const capture = await seedTldr(getDb(), siteRow.id, admin.user.id, { source: 'jev', writeFixture: true, fixtureDir: tmp });
    expect(capture.fixturesWritten).toEqual([]);
    expect(capture.warnings).toHaveLength(5);
    expect(capture.warnings.every((w) => /not pure Jev output/.test(w))).toBe(true);
  });
});
