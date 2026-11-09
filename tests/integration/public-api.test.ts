// Public reader API + crawler surfaces against real blog0_test Postgres:
// GET /api/public/articles/:slug/tldr (the card → deck overlay), /sitemap.xml, /robots.txt and the
// article route metadata (OG times from the DB). Articles are inserted directly with the schema
// and rendered with the real content pipeline. No LLM is involved anywhere in this capability.
// GET /api/public/articles/:slug/listen serves marks resolved per request (estimated
// over the published paragraphs when no stored marks cover them) and the same times as the deck DTO.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as listenRoute } from '@/app/api/public/articles/[slug]/listen/route';
import { GET as tldrRoute } from '@/app/api/public/articles/[slug]/tldr/route';
import robots from '@/app/robots';
import sitemap from '@/app/sitemap';
import type { PublicListenDto, PublicTldrDto } from '@/lib/api/dto';
import type { Envelope } from '@/lib/api/envelope';
import { buildDeckSlides, tldrMinutes } from '@/lib/deck/timing';
import { estimateMarks, toTimedParagraphs } from '@/lib/listen/estimate';
import { DECK_DISCLOSURE } from '@/lib/view-models';
import { renderArticle, resetRenderCacheForTests } from '@/server/content';
import { getDb } from '@/server/db/client';
import { site, type SiteRow } from '@/server/db/schema';
import { loadPublishedArticle } from '@/server/public/articles';
import { articleRouteMetadata } from '@/server/public/metadata';
import { siteSeedFor } from '@/server/site/defaults';

import { resetDb } from '../helpers/db';
import { captureLogs, type CapturedLogs } from '../helpers/logs';
import { day, deckFrom as deckOf, listenPayload as listenOf, seedArticle as seed, type Rendered, type SeedArticle } from '../helpers/seed-articles';

const BASE = 'http://localhost:3410';

const BODY_A = [
  '## Why it matters',
  '',
  'Most teams measure the wrong thing when they evaluate a model in production. The benchmark tells you very little about the work.',
  '',
  'A second paragraph explains the cost of getting this wrong for a small company. It is longer than the first one by design.',
].join('\n');
const BODY_B = 'Every article on this site is read three ways by the people who visit it. That is the whole idea.';

let siteRow: SiteRow;
let logs: CapturedLogs;

const seedArticle = (a: Omit<SeedArticle, 'siteId'> & { siteId?: string }) => seed({ ...a, siteId: a.siteId ?? siteRow.id });
const deckFrom = (rendered: Rendered, picks: number[], sources?: Array<'jev' | 'writer'>) =>
  deckOf(rendered, picks, sources, { reason: 'SECRET-REASON because it matters', generationId: '00000000-0000-4000-8000-00000000c0de' });
/** An uploaded-and-published Listen payload with no stored marks (spec/data.md). */
const listenPayload = (durationMs: number) => listenOf(durationMs, { ext: 'm4a', bytes: 4321, fp: 'fp-at-upload' });

async function getListen(slug: string) {
  const res = await listenRoute(new Request(`${BASE}/api/public/articles/${encodeURIComponent(slug)}/listen`, { headers: { host: 'localhost:3410' } }), {
    params: Promise.resolve({ slug }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, env: JSON.parse(text) as Envelope<PublicListenDto> };
}

async function getTldr(slug: string) {
  const res = await tldrRoute(new Request(`${BASE}/api/public/articles/${encodeURIComponent(slug)}/tldr`, { headers: { host: 'localhost:3410' } }), {
    params: Promise.resolve({ slug }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, env: JSON.parse(text) as Envelope<PublicTldrDto> };
}

beforeEach(async () => {
  siteRow = await resetDb();
  resetRenderCacheForTests();
  logs = captureLogs();
});

afterEach(() => {
  logs.stop();
});

describe('GET /api/public/articles/:slug/tldr', () => {
  it('returns the published deck for a card overlay, cacheable for 60 s', async () => {
    const pre = await renderArticle({ title: 'Measure the work', dek: 'Benchmarks are not the job.', bodyMd: BODY_A });
    await seedArticle({
      slug: 'measure-the-work',
      title: 'Measure the work',
      dek: 'Benchmarks are not the job.',
      topic: 'Op-Ed',
      bodyMd: BODY_A,
      firstPublishedAt: day(8),
      deck: deckFrom(pre, [0, 2]),
    });

    const res = await getTldr('measure-the-work');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(res.env.ok).toBe(true);
    if (!res.env.ok) return;
    const d = res.env.data;
    const lines = [pre.sentences[0].text, pre.sentences[2].text];
    expect(d).toEqual({
      slug: 'measure-the-work',
      title: 'Measure the work',
      topic: 'Op-Ed',
      dek: 'Benchmarks are not the job.',
      meta: '8 Sep 2026 · 1 min read',
      slides: lines.map((text) => ({ text })),
      disclosure: DECK_DISCLOSURE.jev,
      times: { read: 1, tldr: tldrMinutes(buildDeckSlides('Measure the work', 'Benchmarks are not the job.', lines)), listen: null },
      shareUrl: `${BASE}/p/measure-the-work/tldr`,
    });
    // Reader data only: no sentence ids, Jev reasons, generation ids or cost leave the server.
    expect(res.text).not.toContain('SECRET-REASON');
    expect(res.text).not.toContain('00000000-0000-4000-8000-00000000c0de');
    expect(res.text).not.toMatch(/"(sid|reason|source|generationId|costUsd|cost)"/);
    const line = logs.lines.find((l) => l.event === 'api.request' && l.status === 200);
    expect(line?.output_summary).toEqual({ slides: 2 });
  });

  it('labels a mixed deck and serves the published deck, never the draft', async () => {
    const pre = await renderArticle({ title: 'Mixed', dek: 'A short standfirst.', bodyMd: BODY_A });
    await seedArticle({
      slug: 'mixed',
      title: 'Mixed',
      bodyMd: BODY_A,
      deck: deckFrom(pre, [1, 3], ['jev', 'writer']),
      draftDeck: deckFrom(pre, [0, 1, 2, 3]),
    });

    const res = await getTldr('mixed');

    if (!res.env.ok) throw new Error('expected ok');
    expect(res.env.data.slides.map((s) => s.text)).toEqual([pre.sentences[1].text, pre.sentences[3].text]);
    expect(res.env.data.disclosure).toBe(DECK_DISCLOSURE.mixed);
  });

  it('answers 404 NOT_FOUND (no-store) for unknown, malformed, unpublished, deck-less and other-site slugs', async () => {
    const pre = await renderArticle({ title: 'T', dek: 'A short standfirst.', bodyMd: BODY_A });
    await seedArticle({ slug: 'no-deck', title: 'T', bodyMd: BODY_A });
    await seedArticle({ slug: 'draft-deck-only', title: 'T', bodyMd: BODY_A, draftDeck: deckFrom(pre, [0]) });
    await seedArticle({ slug: 'broken-deck', title: 'T', bodyMd: BODY_A, deck: { slides: [{ nope: true }] } });
    await seedArticle({ slug: 'a-draft', title: 'T', bodyMd: BODY_A, status: 'draft', withPublishedRevision: false, deck: deckFrom(pre, [0]) });
    await seedArticle({ slug: 'was-live', title: 'T', bodyMd: BODY_A, status: 'draft', firstPublishedAt: day(1), deck: deckFrom(pre, [0]) });
    const [other] = await getDb().insert(site).values(siteSeedFor('other-site')).returning();
    await seedArticle({ slug: 'elsewhere', title: 'T', bodyMd: BODY_A, siteId: other.id, deck: deckFrom(pre, [0]) });

    for (const slug of ['nope', 'Bad Slug', '../admin', '', 'no-deck', 'draft-deck-only', 'broken-deck', 'a-draft', 'was-live', 'elsewhere']) {
      const res = await getTldr(slug);
      expect(res.status, slug).toBe(404);
      expect(res.headers.get('cache-control'), slug).toBe('no-store');
      expect(res.env.ok).toBe(false);
      if (!res.env.ok) {
        expect(res.env.error.code).toBe('NOT_FOUND');
        expect(res.env.error.message).toBe('That article has no published summary.');
      }
    }
  });
});

describe('sitemap and robots', () => {
  it('lists exactly /, /archive, /about, /privacy and the published article URLs (absolute)', async () => {
    const pre = await renderArticle({ title: 'T', dek: 'A short standfirst.', bodyMd: BODY_A });
    await seedArticle({ slug: 'older', title: 'Older', bodyMd: BODY_B, firstPublishedAt: day(2) });
    await seedArticle({ slug: 'newer', title: 'Newer', bodyMd: BODY_A, firstPublishedAt: day(5), lastPublishedAt: day(9), deck: deckFrom(pre, [0]) });
    await seedArticle({ slug: 'a-draft', title: 'Draft', bodyMd: BODY_B, status: 'draft', withPublishedRevision: false });
    await seedArticle({ slug: 'was-live', title: 'Was live', bodyMd: BODY_B, status: 'draft', firstPublishedAt: day(1) });
    const [other] = await getDb().insert(site).values(siteSeedFor('other-site')).returning();
    await seedArticle({ slug: 'elsewhere', title: 'Elsewhere', bodyMd: BODY_B, siteId: other.id });

    const entries = await sitemap();

    expect(entries.map((e) => e.url)).toEqual([`${BASE}/`, `${BASE}/archive`, `${BASE}/about`, `${BASE}/privacy`, `${BASE}/p/newer`, `${BASE}/p/older`]);
    const newer = entries.find((e) => e.url.endsWith('/p/newer'));
    expect(newer?.lastModified).toEqual(day(9));
    expect(entries[0].lastModified).toEqual(day(9));
    expect(entries.find((e) => e.url.endsWith('/p/older'))?.lastModified).toEqual(day(2));
  });

  it('still lists the three site pages when nothing is published', async () => {
    const entries = await sitemap();
    expect(entries.map((e) => e.url)).toEqual([`${BASE}/`, `${BASE}/archive`, `${BASE}/about`, `${BASE}/privacy`]);
    expect(entries[0].lastModified).toBeUndefined();
  });

  it('robots allows the site, blocks the desk and the API, and points at the sitemap', () => {
    const r = robots();
    expect(r.rules).toEqual([{ userAgent: '*', allow: '/', disallow: ['/admin', '/api/'] }]);
    expect(r.sitemap).toBe(`${BASE}/sitemap.xml`);
    expect(r.host).toBe(BASE);
  });
});

describe('article route metadata', () => {
  it('carries title "— blog0", dek, canonical and OG published/modified times from the DB', async () => {
    const pre = await renderArticle({ title: 'OG test', dek: 'The dek.', bodyMd: BODY_A });
    await seedArticle({ slug: 'og-test', title: 'OG test', dek: 'The dek.', bodyMd: BODY_A, firstPublishedAt: day(3), lastPublishedAt: day(7), deck: deckFrom(pre, [0]) });

    const page = await loadPublishedArticle('og-test');
    const read = await articleRouteMetadata(page, 'read');
    const tldr = await articleRouteMetadata(page, 'tldr');

    expect(read.title).toBe('OG test — blog0');
    expect(read.description).toBe('The dek.');
    expect(read.alternates?.canonical).toBe(`${BASE}/p/og-test`);
    const og = read.openGraph as Record<string, unknown>;
    expect(og).toMatchObject({
      type: 'article',
      title: 'OG test',
      description: 'The dek.',
      url: `${BASE}/p/og-test`,
      siteName: 'blog0',
      publishedTime: day(3).toISOString(),
      modifiedTime: day(7).toISOString(),
    });
    expect((read.twitter as Record<string, unknown>).card).toBe('summary_large_image'); // Stage A item 2 (spec/ui.md §3)
    expect((tldr.openGraph as Record<string, unknown>).url).toBe(`${BASE}/p/og-test/tldr`);
    expect(tldr.alternates?.canonical).toBe(`${BASE}/p/og-test`);
  });

  it('is empty for a missing page and has no modified time for an unpublished slug', async () => {
    await seedArticle({ slug: 'was-live', title: 'Was live', bodyMd: BODY_B, status: 'draft', firstPublishedAt: day(1) });

    expect(await articleRouteMetadata(null, 'read')).toEqual({});
    expect(await loadPublishedArticle('was-live')).toBeNull();
    expect(await loadPublishedArticle('never-existed')).toBeNull();
  });
});

describe('GET /api/public/articles/:slug/listen', () => {
  it('serves estimated marks over the published paragraphs + the same times as the deck DTO; no admin fields', async () => {
    const pre = await renderArticle({ title: 'Hear the work', dek: 'Benchmarks are not the job.', bodyMd: BODY_A });
    const payload = listenPayload(95_000);
    await seedArticle({
      slug: 'hear-the-work',
      title: 'Hear the work',
      dek: 'Benchmarks are not the job.',
      topic: 'Op-Ed',
      bodyMd: BODY_A,
      firstPublishedAt: day(8),
      deck: deckFrom(pre, [0, 2]),
      listen: { published: payload },
    });

    const res = await getListen('hear-the-work');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    if (!res.env.ok) throw new Error('expected ok');
    const d = res.env.data;
    expect(d.timing).toBe('estimated');
    expect(d.marks).toEqual(estimateMarks(toTimedParagraphs(pre.paragraphs), 95_000));
    expect(d.marks.map((m) => m.pid)).toEqual(pre.paragraphs.map((p) => p.pid));
    expect(d.marks[0].tMs).toBe(0);
    expect(d.audio).toEqual({ url: `/media/${payload.audio.key}`, mimeType: 'audio/mp4', durationMs: 95_000 });
    expect(d.times.listen).toBe(2);
    expect(res.text).not.toMatch(/"(assetId|uploadFingerprint|syncFingerprint|key)"/);

    const tldr = await getTldr('hear-the-work');
    if (!tldr.env.ok) throw new Error('expected ok');
    expect(tldr.env.data.times).toEqual(d.times);
    const line = logs.lines.find((l) => l.event === 'api.request' && l.status === 200 && String(l.path).endsWith('/listen'));
    expect(line?.output_summary).toEqual({ marks: pre.paragraphs.length, timing: 'estimated' });
  });

  it('404s when only a draft Listen exists, and when the published payload is corrupt', async () => {
    await seedArticle({ slug: 'draft-listen', title: 'Draft listen', bodyMd: BODY_B, listen: { draft: listenPayload(30_000) } });
    await seedArticle({ slug: 'corrupt-listen', title: 'Corrupt listen', bodyMd: BODY_B, listen: { published: { audio: { key: 1 } } } });
    for (const slug of ['draft-listen', 'corrupt-listen']) {
      const res = await getListen(slug);
      expect(res.status, slug).toBe(404);
      expect(res.env.ok).toBe(false);
    }
    const tldr = await getTldr('draft-listen');
    expect(tldr.status).toBe(404); // no deck either; just proving no Listen-driven 500s
  });
});
