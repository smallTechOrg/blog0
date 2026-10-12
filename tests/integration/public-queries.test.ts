// Public (reader) queries — S1.7. Real blog0_test Postgres; articles are inserted directly with
// the schema (the articles service is a separate slice) and rendered with the real pipeline.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDeckSlides, tldrMinutes } from '@/lib/deck/timing';
import { DECK_DISCLOSURE } from '@/lib/view-models';
import { renderArticle, resetRenderCacheForTests } from '@/server/content';
import { getDb } from '@/server/db/client';
import { appUser, article, articleFormat, articleRevision, site, type SiteRow } from '@/server/db/schema';
import { getHomeViewModel, isAdminSignedIn } from '@/server/public/home';
import { articleMetadata, pageTitle } from '@/server/public/metadata';
import { getPublishedArticle, listPublishedPostCards, nextArticleOf, publishedSlugExists } from '@/server/public/articles';
import { siteSeedFor } from '@/server/site/defaults';

import { resetDb } from '../helpers/db';
import { captureLogs, type CapturedLogs } from '../helpers/logs';
import { loginAs } from '../helpers/session';

const BODY_A = [
  '## Why it matters',
  '',
  'Most teams measure the wrong thing when they evaluate a model in production. The benchmark tells you very little about the work.',
  '',
  'A second paragraph explains the cost of getting this wrong for a small company. It is longer than the first one by design.',
].join('\n');

const BODY_B = 'Every article on this site is read three ways by the people who visit it. That is the whole idea.';

const BODY_C = 'The third article exists so the next link has somewhere to wrap around to in the end.';

type Status = 'draft' | 'submitted' | 'approved' | 'published';

interface SeedArticle {
  slug: string;
  title: string;
  dek?: string;
  topic?: string;
  bodyMd: string;
  status?: Status;
  firstPublishedAt?: Date | null;
  inProgress?: boolean;
  siteId?: string;
  /** Published TLDR payload (raw jsonb), or null for none. */
  deck?: unknown;
  /** Draft TLDR payload (never visible to readers). */
  draftDeck?: unknown;
  /** A later, unpublished revision (title/body) saved after publishing. */
  laterEdit?: { title: string; bodyMd: string };
  /** When false the article never had a published revision. */
  withPublishedRevision?: boolean;
}

let siteRow: SiteRow;
let userId: string;
let logs: CapturedLogs;

async function makeUser(siteId: string): Promise<string> {
  const [u] = await getDb()
    .insert(appUser)
    .values({ siteId, email: `w-${siteId.slice(0, 8)}@example.test`, displayName: 'Writer', passwordHash: '$x$' })
    .onConflictDoNothing()
    .returning({ id: appUser.id });
  if (u) return u.id;
  const [existing] = await getDb().select({ id: appUser.id }).from(appUser).where(eq(appUser.siteId, siteId));
  return existing.id;
}

async function insertRevision(input: { siteId: string; articleId: string; number: number; title: string; dek: string; bodyMd: string; by: string }) {
  const r = await renderArticle({ title: input.title, dek: input.dek, bodyMd: input.bodyMd });
  const [rev] = await getDb()
    .insert(articleRevision)
    .values({
      siteId: input.siteId,
      articleId: input.articleId,
      number: input.number,
      title: input.title,
      dek: input.dek,
      bodyMd: input.bodyMd,
      bodyFingerprint: r.fingerprints.body,
      paragraphsFingerprint: r.fingerprints.paragraphs,
      sentencesFingerprint: r.fingerprints.sentences,
      wordCount: r.stats.words,
      eligibleSentenceCount: r.sentences.length,
      createdBy: input.by,
    })
    .returning();
  return { rev, rendered: r };
}

async function seedArticle(a: SeedArticle) {
  const siteId = a.siteId ?? siteRow.id;
  const by = siteId === siteRow.id ? userId : await makeUser(siteId);
  const status = a.status ?? 'published';
  const firstPublishedAt = a.firstPublishedAt === undefined ? (status === 'published' ? new Date() : null) : a.firstPublishedAt;
  const [row] = await getDb()
    .insert(article)
    .values({
      siteId,
      slug: a.slug,
      status,
      topic: a.topic ?? 'Analysis',
      bylineName: 'Sai Krishna V',
      createdBy: by,
      inProgress: a.inProgress ?? false,
      firstPublishedAt,
      lastPublishedAt: firstPublishedAt,
    })
    .returning();
  const dek = a.dek ?? 'A short standfirst.';
  const first = await insertRevision({ siteId, articleId: row.id, number: 1, title: a.title, dek, bodyMd: a.bodyMd, by });
  let currentId = first.rev.id;
  if (a.laterEdit) {
    const later = await insertRevision({ siteId, articleId: row.id, number: 2, title: a.laterEdit.title, dek, bodyMd: a.laterEdit.bodyMd, by });
    currentId = later.rev.id;
  }
  const publishedRevisionId = a.withPublishedRevision === false ? null : first.rev.id;
  await getDb().update(article).set({ currentRevisionId: currentId, publishedRevisionId }).where(eq(article.id, row.id));
  if (a.deck !== undefined || a.draftDeck !== undefined) {
    await getDb()
      .insert(articleFormat)
      .values({
        siteId,
        articleId: row.id,
        kind: 'tldr',
        draftPayload: a.draftDeck ?? null,
        publishedPayload: a.deck ?? null,
        publishedRevisionId: a.deck ? first.rev.id : null,
        publishedAt: a.deck ? new Date() : null,
      });
  }
  return { id: row.id, rendered: first.rendered };
}

/** A deck payload built from the rendered article's own sentences. */
function deckFrom(rendered: Awaited<ReturnType<typeof renderArticle>>, picks: number[], sources?: Array<'jev' | 'writer'>) {
  return {
    slides: picks.map((i, k) => ({
      sid: rendered.sentences[i].sid,
      text: rendered.sentences[i].text,
      source: sources?.[k] ?? 'jev',
      reason: 'because',
    })),
    generationId: null,
  };
}

const day = (n: number) => new Date(Date.UTC(2026, 8, n, 3, 30)); // 09:00 Asia/Kolkata

beforeEach(async () => {
  siteRow = await resetDb();
  resetRenderCacheForTests();
  userId = await makeUser(siteRow.id);
  logs = captureLogs();
});

afterEach(() => {
  logs.stop();
});

describe('getPublishedArticle', () => {
  it('returns the published article view model with formatted date, blocks, times and absolute urls', async () => {
    const pre = await renderArticle({ title: 'Measure the work', dek: 'Benchmarks are not the job.', bodyMd: BODY_A });
    await seedArticle({ slug: 'measure-the-work', title: 'Measure the work', dek: 'Benchmarks are not the job.', bodyMd: BODY_A, firstPublishedAt: day(8), deck: deckFrom(pre, [0, 2]) });

    const vm = await getPublishedArticle('measure-the-work');

    expect(vm).not.toBeNull();
    if (!vm) return;
    expect(vm.slug).toBe('measure-the-work');
    expect(vm.title).toBe('Measure the work');
    expect(vm.dek).toBe('Benchmarks are not the job.');
    expect(vm.topic).toBe('Analysis');
    expect(vm.bylineName).toBe('Sai Krishna V');
    expect(vm.publishedLabel).toBe('8 Sep 2026');
    expect(vm.updatedLabel).toBeNull();
    expect(vm.inProgress).toBe(false);
    const html = vm.blocks.map((b) => (b.kind === 'html' ? b.html : '')).join('');
    expect(html).toContain('Most teams measure the wrong thing');
    expect(html).toContain('<h2');
    expect(vm.times.read).toBe(1);
    expect(vm.times.listen).toBeNull();
    expect(vm.listen).toBeNull();
    expect(vm.correctionsHtml).toBeNull();
    expect(vm.articleUrl).toBe('http://localhost:3410/p/measure-the-work');
    expect(vm.deck).not.toBeNull();
    expect(vm.deck?.slides.map((s) => s.text)).toEqual([pre.sentences[0].text, pre.sentences[2].text]);
    expect(vm.deck?.disclosure).toBe(DECK_DISCLOSURE.jev);
    expect(vm.deck?.shareUrl).toBe('http://localhost:3410/p/measure-the-work/tldr');
    expect(vm.times.tldr).toBe(tldrMinutes(buildDeckSlides(vm.title, vm.dek, vm.deck?.slides.map((s) => s.text) ?? [])));
  });

  it('returns null for an unknown slug and for a malformed slug without querying content', async () => {
    await seedArticle({ slug: 'real-one', title: 'Real', bodyMd: BODY_B });

    expect(await getPublishedArticle('does-not-exist')).toBeNull();
    expect(await getPublishedArticle('Bad Slug/../x')).toBeNull();
    expect(await getPublishedArticle('')).toBeNull();
    expect(await getPublishedArticle('a'.repeat(81))).toBeNull();
  });

  it('never exposes drafts, submitted or approved articles, or an unpublished article', async () => {
    await seedArticle({ slug: 'a-draft', title: 'Draft', bodyMd: BODY_B, status: 'draft', withPublishedRevision: false });
    await seedArticle({ slug: 'a-submitted', title: 'Submitted', bodyMd: BODY_B, status: 'submitted', withPublishedRevision: false });
    await seedArticle({ slug: 'an-approved', title: 'Approved', bodyMd: BODY_B, status: 'approved', withPublishedRevision: false });
    // Unpublished: status back to draft, published pointers kept (spec/data.md lifecycle).
    await seedArticle({ slug: 'was-live', title: 'Was live', bodyMd: BODY_B, status: 'draft', firstPublishedAt: day(1) });

    for (const slug of ['a-draft', 'a-submitted', 'an-approved', 'was-live']) {
      expect(await getPublishedArticle(slug)).toBeNull();
    }
    expect(await listPublishedPostCards()).toEqual([]);
  });

  it('serves the published revision, not later saved edits, and the published deck, not the draft', async () => {
    const pre = await renderArticle({ title: 'Original title', dek: 'A short standfirst.', bodyMd: BODY_A });
    await seedArticle({
      slug: 'edited-after',
      title: 'Original title',
      bodyMd: BODY_A,
      laterEdit: { title: 'Edited title', bodyMd: 'Entirely new unpublished text that readers must not see yet.' },
      deck: deckFrom(pre, [1]),
      draftDeck: deckFrom(pre, [0, 1, 2]),
    });

    const vm = await getPublishedArticle('edited-after');

    expect(vm?.title).toBe('Original title');
    const html = vm?.blocks.map((b) => (b.kind === 'html' ? b.html : '')).join('') ?? '';
    expect(html).toContain('Most teams measure');
    expect(html).not.toContain('Entirely new unpublished text');
    expect(vm?.deck?.slides.map((s) => s.text)).toEqual([pre.sentences[1].text]);
  });

  it('disables TLDR when no deck is published (no row, null payload, or only a draft)', async () => {
    const pre = await renderArticle({ title: 'T', dek: 'A short standfirst.', bodyMd: BODY_A });
    await seedArticle({ slug: 'no-row', title: 'T', bodyMd: BODY_A });
    await seedArticle({ slug: 'draft-only', title: 'T', bodyMd: BODY_A, draftDeck: deckFrom(pre, [0]) });

    for (const slug of ['no-row', 'draft-only']) {
      const vm = await getPublishedArticle(slug);
      expect(vm).not.toBeNull();
      expect(vm?.deck).toBeNull();
      expect(vm?.times.tldr).toBeNull();
    }
  });

  it('treats a malformed published deck payload as no deck and logs a warning', async () => {
    await seedArticle({ slug: 'broken-deck', title: 'T', bodyMd: BODY_A, deck: { slides: [{ nope: true }] } });

    const vm = await getPublishedArticle('broken-deck');

    expect(vm).not.toBeNull();
    expect(vm?.deck).toBeNull();
    expect(vm?.times.tldr).toBeNull();
    expect(logs.lines.some((l) => l.event === 'public.deck_invalid' && l.level === 'warn')).toBe(true);
  });

  it('labels the disclosure by who picked the lines', async () => {
    const pre = await renderArticle({ title: 'T', dek: 'A short standfirst.', bodyMd: BODY_A });
    await seedArticle({ slug: 'mixed', title: 'T', bodyMd: BODY_A, deck: deckFrom(pre, [0, 1], ['jev', 'writer']) });
    await seedArticle({ slug: 'editors', title: 'T', bodyMd: BODY_A, deck: deckFrom(pre, [0], ['writer']) });

    expect((await getPublishedArticle('mixed'))?.deck?.disclosure).toBe(DECK_DISCLOSURE.mixed);
    expect((await getPublishedArticle('editors'))?.deck?.disclosure).toBe(DECK_DISCLOSURE.editors);
  });

  it('carries the in-progress flag of a published piece', async () => {
    await seedArticle({ slug: 'wip', title: 'Work in progress', bodyMd: BODY_B, inProgress: true });

    expect((await getPublishedArticle('wip'))?.inProgress).toBe(true);
  });

  it('links Next to the next newer published article and wraps to the oldest', async () => {
    await seedArticle({ slug: 'oldest', title: 'Oldest', bodyMd: BODY_A, firstPublishedAt: day(1) });
    await seedArticle({ slug: 'middle', title: 'Middle', bodyMd: BODY_B, firstPublishedAt: day(5) });
    await seedArticle({ slug: 'newest', title: 'Newest', bodyMd: BODY_C, firstPublishedAt: day(9) });
    await seedArticle({ slug: 'hidden-draft', title: 'Hidden', bodyMd: BODY_C, status: 'draft', firstPublishedAt: day(7) });

    expect((await getPublishedArticle('oldest'))?.next).toEqual({ slug: 'middle', title: 'Middle' });
    expect((await getPublishedArticle('middle'))?.next).toEqual({ slug: 'newest', title: 'Newest' });
    expect((await getPublishedArticle('newest'))?.next).toEqual({ slug: 'oldest', title: 'Oldest' });
  });

  it('has no Next link when the article is the only one published', async () => {
    await seedArticle({ slug: 'alone', title: 'Alone', bodyMd: BODY_B });

    expect((await getPublishedArticle('alone'))?.next).toBeNull();
  });

  it('never reads another site’s articles', async () => {
    const [other] = await getDb().insert(site).values(siteSeedFor('other-site')).returning();
    await seedArticle({ slug: 'elsewhere', title: 'Elsewhere', bodyMd: BODY_B, siteId: other.id });

    expect(await getPublishedArticle('elsewhere')).toBeNull();
    expect(await listPublishedPostCards()).toEqual([]);
  });

  it('serves a re-read from the render cache with the same view model (state survives a second request)', async () => {
    await seedArticle({ slug: 'twice', title: 'Twice', bodyMd: BODY_A });

    const first = await getPublishedArticle('twice');
    const second = await getPublishedArticle('twice');

    expect(second).toEqual(first);
  });
});

describe('publishedSlugExists (proxy 404 pre-check)', () => {
  it('is true for a published article', async () => {
    await seedArticle({ slug: 'live-piece', title: 'Live', bodyMd: BODY_B });

    expect(await publishedSlugExists('live-piece')).toBe(true);
  });

  it('is false for drafts (never published) and for an unpublished article with pointers kept', async () => {
    await seedArticle({ slug: 'a-draft', title: 'Draft', bodyMd: BODY_B, status: 'draft', withPublishedRevision: false });
    await seedArticle({ slug: 'an-approved', title: 'Approved', bodyMd: BODY_B, status: 'approved', withPublishedRevision: false });
    await seedArticle({ slug: 'was-live', title: 'Was live', bodyMd: BODY_B, status: 'draft', firstPublishedAt: day(1) });

    expect(await publishedSlugExists('a-draft')).toBe(false);
    expect(await publishedSlugExists('an-approved')).toBe(false);
    expect(await publishedSlugExists('was-live')).toBe(false);
  });

  it('is false for a published article on another site', async () => {
    const [other] = await getDb().insert(site).values(siteSeedFor('other-site')).returning();
    await seedArticle({ slug: 'elsewhere', title: 'Elsewhere', bodyMd: BODY_B, siteId: other.id });

    expect(await publishedSlugExists('elsewhere')).toBe(false);
  });

  it('is false for unknown and malformed slugs', async () => {
    await seedArticle({ slug: 'real-one', title: 'Real', bodyMd: BODY_B });

    expect(await publishedSlugExists('does-not-exist')).toBe(false);
    expect(await publishedSlugExists('Real-One')).toBe(false);
    expect(await publishedSlugExists('real-one/../x')).toBe(false);
    expect(await publishedSlugExists("real-one' OR '1'='1")).toBe(false);
    expect(await publishedSlugExists('%E0%A4%A')).toBe(false);
    expect(await publishedSlugExists('')).toBe(false);
    expect(await publishedSlugExists('a'.repeat(81))).toBe(false);
  });
});

describe('nextArticleOf', () => {
  const list = [
    { slug: 'c', title: 'C', firstPublishedAt: day(9) },
    { slug: 'a', title: 'A', firstPublishedAt: day(1) },
    { slug: 'b', title: 'B', firstPublishedAt: day(5) },
  ];

  it('orders by first-published date regardless of input order', () => {
    expect(nextArticleOf(list, 'a')).toEqual({ slug: 'b', title: 'B' });
    expect(nextArticleOf(list, 'c')).toEqual({ slug: 'a', title: 'A' });
  });

  it('returns null for an empty list or a slug not in it', () => {
    expect(nextArticleOf([], 'a')).toBeNull();
    expect(nextArticleOf(list, 'zzz')).toBeNull();
  });
});

describe('listPublishedPostCards', () => {
  it('lists published articles newest first with TLDR minutes only when a deck is published', async () => {
    const pre = await renderArticle({ title: 'With deck', dek: 'A short standfirst.', bodyMd: BODY_A });
    await seedArticle({ slug: 'with-deck', title: 'With deck', bodyMd: BODY_A, firstPublishedAt: day(3), deck: deckFrom(pre, [0, 1]) });
    await seedArticle({ slug: 'no-deck', title: 'No deck', bodyMd: BODY_B, firstPublishedAt: day(8), inProgress: true, topic: 'Op-Ed' });
    await seedArticle({ slug: 'secret', title: 'Secret', bodyMd: BODY_C, status: 'draft', withPublishedRevision: false });

    const cards = await listPublishedPostCards();

    expect(cards.map((c) => c.slug)).toEqual(['no-deck', 'with-deck']);
    expect(cards[0]).toEqual({
      slug: 'no-deck',
      title: 'No deck',
      dek: 'A short standfirst.',
      topic: 'Op-Ed',
      publishedLabel: '8 Sep 2026',
      inProgress: true,
      times: { tldr: null, listen: null },
    });
    expect(cards[1].times.tldr).toBe(tldrMinutes(buildDeckSlides('With deck', 'A short standfirst.', [pre.sentences[0].text, pre.sentences[1].text])));
    expect(cards[1].publishedLabel).toBe('3 Sep 2026');
  });

  it('uses the published revision title for cards, not a later unpublished edit', async () => {
    await seedArticle({ slug: 'card-edit', title: 'Live title', bodyMd: BODY_B, laterEdit: { title: 'Unsaved idea', bodyMd: BODY_C } });

    const cards = await listPublishedPostCards();

    expect(cards.map((c) => c.title)).toEqual(['Live title']);
  });
});

describe('home view model', () => {
  it('returns an empty list and signedIn=false for an anonymous reader with nothing published', async () => {
    const home = await getHomeViewModel(null);

    expect(home).toEqual({ posts: [], signedIn: false });
  });

  it('reports signedIn only for a valid admin session token', async () => {
    const login = await loginAs();

    expect(await isAdminSignedIn(login.token)).toBe(true);
    expect(await isAdminSignedIn('not-a-real-token')).toBe(false);
    expect(await isAdminSignedIn(null)).toBe(false);
    expect((await getHomeViewModel(login.token)).signedIn).toBe(true);
  });
});

describe('metadata', () => {
  it('builds the "<Title> — log0" title, dek description and Open Graph tags', async () => {
    const pre = await renderArticle({ title: 'OG test', dek: 'The dek.', bodyMd: BODY_B });
    await seedArticle({ slug: 'og-test', title: 'OG test', dek: 'The dek.', bodyMd: BODY_B, firstPublishedAt: day(8), deck: deckFrom(pre, [0]) });
    await seedArticle({ slug: 'og-no-deck', title: 'No deck', dek: 'The dek.', bodyMd: BODY_C, firstPublishedAt: day(9) });
    const vm = await getPublishedArticle('og-test');
    const noDeck = await getPublishedArticle('og-no-deck');
    if (!vm) throw new Error('expected article');

    const meta = articleMetadata(vm, { wordmark: 'log0', mode: 'read', publishedAt: day(8) });
    const tldrMeta = articleMetadata(vm, { wordmark: 'log0', mode: 'tldr', publishedAt: day(8) });

    expect(meta.title).toBe('OG test — log0');
    expect(meta.description).toBe('The dek.');
    expect(meta.alternates?.canonical).toBe('http://localhost:3410/p/og-test');
    const og = meta.openGraph as Record<string, unknown>;
    expect(og.title).toBe('OG test');
    expect(og.description).toBe('The dek.');
    expect(og.url).toBe('http://localhost:3410/p/og-test');
    expect(og.siteName).toBe('log0');
    expect(og.type).toBe('article');
    expect(og.publishedTime).toBe(day(8).toISOString());
    expect((tldrMeta.openGraph as Record<string, unknown>).url).toBe('http://localhost:3410/p/og-test/tldr');
    expect(tldrMeta.alternates?.canonical).toBe('http://localhost:3410/p/og-test');
    // /p/<slug>/tldr without a published deck falls back to Read, so its preview points at Read.
    if (!noDeck) throw new Error('expected article');
    const fallback = articleMetadata(noDeck, { wordmark: 'log0', mode: 'tldr', publishedAt: day(9) });
    expect((fallback.openGraph as Record<string, unknown>).url).toBe('http://localhost:3410/p/og-no-deck');
    expect(pageTitle('Archive', 'log0')).toBe('Archive — log0');
  });
});
