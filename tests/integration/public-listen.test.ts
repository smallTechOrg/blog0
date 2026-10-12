// Public Listen data (S3.5) against real blog0_test Postgres: the article view model's `listen`
// + `times.listen`, the home/card minutes, and GET /api/public/articles/:slug/listen. Readers get
// the PUBLISHED Listen payload over the PUBLISHED revision only — a draft recording (synced or
// not) never leaks, an unpublished article never answers, and no admin field (asset id, storage
// key, fingerprints, uploader) leaves the server. Listen never calls the LLM.
import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as listenRoute } from '@/app/api/public/articles/[slug]/listen/route';
import { GET as tldrRoute } from '@/app/api/public/articles/[slug]/tldr/route';
import type { PublicTldrDto } from '@/lib/api/dto-phase2';
import type { PublicListenDto } from '@/lib/api/dto-phase3';
import type { Envelope } from '@/lib/api/envelope';
import { listenMinutes } from '@/lib/listen/marks';
import { renderArticle, resetRenderCacheForTests } from '@/server/content';
import { getDb } from '@/server/db/client';
import { appUser, article, articleFormat, articleRevision, mediaAsset, type SiteRow } from '@/server/db/schema';
import { getHomeSections } from '@/server/public/home';
import { getPublishedArticle, listPublishedPostCards } from '@/server/public/articles';

import { resetDb } from '../helpers/db';
import { captureLogs, type CapturedLogs } from '../helpers/logs';

const BASE = 'http://localhost:3410';

const BODY = [
  '## Why decks',
  '',
  'The deck shows the strongest lines of the article in order. Each slide holds exactly one sentence from the text.',
  '',
  'Writers pick the lines by hand when the model is unavailable. That keeps publishing moving on a bad day.',
  '',
  '- A short list item.',
  '',
  '> A quoted paragraph that is also read aloud.',
].join('\n');

/** 2 min 20 s → "Listen · 2 min". */
const DURATION_MS = 140_000;

interface ListenSeed {
  durationMs?: number;
  ext?: 'mp3' | 'm4a';
  /** Published marks over the published revision's pids; omitted → no published Listen. */
  publishedMarks?: (pids: string[]) => Array<{ pid: string; tMs: number }>;
  /** Draft marks over the pids; `() => []` = uploaded but unsynced; omitted → no draft. */
  draftMarks?: (pids: string[]) => Array<{ pid: string; tMs: number }>;
  /** Raw published payload override (corrupt-payload case). */
  rawPublished?: unknown;
}

let siteRow: SiteRow;
let userId: string;
let logs: CapturedLogs;

async function makeUser(): Promise<string> {
  const [u] = await getDb()
    .insert(appUser)
    .values({ siteId: siteRow.id, email: 'reader-writer@example.test', displayName: 'Writer', passwordHash: '$x$' })
    .returning({ id: appUser.id });
  return u.id;
}

async function seedArticle(input: { slug: string; status?: 'draft' | 'published'; listen?: ListenSeed; title?: string }) {
  const status = input.status ?? 'published';
  const title = input.title ?? 'Listen me';
  const dek = 'A short standfirst.';
  const firstPublishedAt = status === 'published' ? new Date(Date.UTC(2026, 8, 8, 3, 30)) : null;
  const [row] = await getDb()
    .insert(article)
    .values({
      siteId: siteRow.id,
      slug: input.slug,
      status,
      topic: 'Craft',
      bylineName: 'Asha Writer',
      createdBy: userId,
      firstPublishedAt,
      lastPublishedAt: firstPublishedAt,
    })
    .returning();
  const rendered = await renderArticle({ title, dek, bodyMd: BODY });
  const [rev] = await getDb()
    .insert(articleRevision)
    .values({
      siteId: siteRow.id,
      articleId: row.id,
      number: 1,
      title,
      dek,
      bodyMd: BODY,
      bodyFingerprint: rendered.fingerprints.body,
      paragraphsFingerprint: rendered.fingerprints.paragraphs,
      sentencesFingerprint: rendered.fingerprints.sentences,
      wordCount: rendered.stats.words,
      eligibleSentenceCount: rendered.sentences.length,
      createdBy: userId,
    })
    .returning();
  await getDb()
    .update(article)
    .set({ currentRevisionId: rev.id, publishedRevisionId: status === 'published' ? rev.id : null })
    .where(eq(article.id, row.id));

  const pids = rendered.paragraphs.map((p) => p.pid);
  let audio: { assetId: string; key: string; mimeType: 'audio/mpeg' | 'audio/mp4'; bytes: number; durationMs: number } | null = null;
  if (input.listen) {
    const l = input.listen;
    const ext = l.ext ?? 'mp3';
    const durationMs = l.durationMs ?? DURATION_MS;
    const key = `${siteRow.slug}/audio/2026/10/${randomUUID()}.${ext}`;
    const mimeType = ext === 'mp3' ? ('audio/mpeg' as const) : ('audio/mp4' as const);
    const [asset] = await getDb()
      .insert(mediaAsset)
      .values({
        siteId: siteRow.id,
        kind: 'audio',
        storageKey: key,
        originalFilename: `reading.${ext}`,
        mimeType,
        byteSize: 654_321,
        sha256: 'cd'.repeat(32),
        durationSec: durationMs / 1000,
        articleId: row.id,
        createdBy: userId,
      })
      .returning();
    audio = { assetId: asset.id, key, mimeType, bytes: 654_321, durationMs };
    const published =
      l.rawPublished !== undefined
        ? l.rawPublished
        : l.publishedMarks
          ? { audio, marks: l.publishedMarks(pids), syncFingerprint: rendered.fingerprints.paragraphs }
          : null;
    const draftMarks = l.draftMarks ? l.draftMarks(pids) : null;
    const draft = draftMarks
      ? { audio: { ...audio, key: key.replace('.' + ext, '-draft.' + ext) }, marks: draftMarks, syncFingerprint: draftMarks.length ? rendered.fingerprints.paragraphs : null }
      : null;
    await getDb()
      .insert(articleFormat)
      .values({
        siteId: siteRow.id,
        articleId: row.id,
        kind: 'listen',
        draftPayload: draft,
        draftRevisionId: draft && draft.marks.length ? rev.id : null,
        draftFingerprint: draft && draft.marks.length ? rendered.fingerprints.paragraphs : null,
        publishedPayload: published,
        publishedRevisionId: published ? rev.id : null,
        publishedFingerprint: published ? rendered.fingerprints.paragraphs : null,
        publishedAt: published ? new Date() : null,
      });
  }
  return { id: row.id, pids, audio, rendered };
}

const marksOver = (startMs = 500, stepMs = 30_000) => (pids: string[]) => pids.map((pid, i) => ({ pid, tMs: startMs + i * stepMs }));
const none = () => [];

async function callListen(slug: string) {
  const res = await listenRoute(new Request(`${BASE}/api/public/articles/${encodeURIComponent(slug)}/listen`), {
    params: Promise.resolve<Record<string, string>>({ slug }),
  });
  return { status: res.status, headers: res.headers, env: (await res.json()) as Envelope<PublicListenDto> };
}

beforeEach(async () => {
  siteRow = await resetDb();
  resetRenderCacheForTests();
  userId = await makeUser();
  logs = captureLogs();
});

afterEach(() => {
  logs.stop();
});

describe('article view model — published Listen', () => {
  it('exposes the published recording, its marks and listenMinutes; never the asset id or storage key', async () => {
    const { pids, audio } = await seedArticle({ slug: 'synced', listen: { publishedMarks: marksOver(), draftMarks: none } });
    const marks = marksOver()(pids);

    const vm = await getPublishedArticle('synced');
    expect(vm).not.toBeNull();
    if (!vm || !audio) return;
    expect(vm.times.listen).toBe(listenMinutes(DURATION_MS));
    expect(vm.times.listen).toBe(2);
    expect(vm.listen).toEqual({
      audioUrl: `/media/${audio.key}`,
      mimeType: 'audio/mpeg',
      durationMs: DURATION_MS,
      marks,
      shareUrl: 'http://localhost:3410/p/synced/listen',
    });
    expect(JSON.stringify(vm.listen)).not.toContain(audio.assetId);
    expect(Object.keys(vm.listen ?? {})).not.toContain('syncFingerprint');
  });

  it('is null with times.listen null when only a draft Listen exists (uploaded, or even fully synced but unpublished)', async () => {
    await seedArticle({ slug: 'draft-only', listen: { draftMarks: none } });
    await seedArticle({ slug: 'synced-unpublished', listen: { draftMarks: marksOver() } });

    for (const slug of ['draft-only', 'synced-unpublished']) {
      const vm = await getPublishedArticle(slug);
      expect(vm?.listen).toBeNull();
      expect(vm?.times.listen).toBeNull();
    }
  });

  it('ignores an empty or corrupt published payload (logs a warning, never crashes the page)', async () => {
    await seedArticle({ slug: 'corrupt', listen: { rawPublished: { audio: { key: 'x' }, marks: 'nope' } } });
    await seedArticle({ slug: 'empty-marks', listen: { publishedMarks: none } });

    expect((await getPublishedArticle('corrupt'))?.listen).toBeNull();
    expect((await getPublishedArticle('empty-marks'))?.listen).toBeNull();
    expect(logs.lines.some((l) => l.event === 'public.listen_invalid')).toBe(true);
  });

  it('answers times.listen on the cards (home + archive) and in the TLDR DTO only for a published Listen', async () => {
    await seedArticle({ slug: 'with-listen', listen: { publishedMarks: marksOver() } });
    await seedArticle({ slug: 'without', listen: { draftMarks: none } });
    await seedArticle({ slug: 'none' });

    const cards = await listPublishedPostCards();
    const byslug = Object.fromEntries(cards.map((c) => [c.slug, c.times.listen]));
    expect(byslug).toEqual({ 'with-listen': 2, without: null, none: null });

    const home = await getHomeSections(null);
    const homeBySlug = Object.fromEntries([...home.featured, ...home.latest].map((c) => [c.slug, c.times.listen]));
    expect(homeBySlug).toEqual({ 'with-listen': 2, without: null, none: null });
  });
});

describe('GET /api/public/articles/:slug/listen', () => {
  it('returns the PublicListenDto for a published article with a published Listen, cacheable for 60 s', async () => {
    const { pids, audio } = await seedArticle({ slug: 'synced', listen: { publishedMarks: marksOver(), draftMarks: none } });
    const marks = marksOver()(pids);

    const res = await callListen('synced');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(res.env.ok).toBe(true);
    if (!res.env.ok || !audio) return;
    expect(res.env.data).toEqual({
      slug: 'synced',
      title: 'Listen me',
      topic: 'Craft',
      dek: 'A short standfirst.',
      meta: '8 Sep 2026 · 1 min read',
      audio: { url: `/media/${audio.key}`, mimeType: 'audio/mpeg', durationMs: DURATION_MS },
      marks,
      bylineName: 'Asha Writer',
      times: { read: 1, tldr: null, listen: 2 },
      shareUrl: 'http://localhost:3410/p/synced/listen',
    });
    const raw = JSON.stringify(res.env.data);
    expect(raw).not.toContain(audio.assetId);
    expect(raw).not.toContain('syncFingerprint');
    expect(raw).not.toContain('-draft.');
  });

  it('serves the PUBLISHED marks even when a newer draft sync exists (no draft leak)', async () => {
    const { pids, audio } = await seedArticle({ slug: 'two-copies', listen: { publishedMarks: marksOver(1_000), draftMarks: marksOver(9_000) } });
    const published = marksOver(1_000)(pids);

    const res = await callListen('two-copies');
    expect(res.status).toBe(200);
    if (!res.env.ok) return;
    expect(res.env.data.marks).toEqual(published);
    expect(res.env.data.audio.url).toBe(`/media/${audio!.key}`);
  });

  it('404s for a published article without a published Listen (none, draft-only), an unpublished article, unknown and malformed slugs', async () => {
    await seedArticle({ slug: 'no-listen' });
    await seedArticle({ slug: 'draft-only', listen: { draftMarks: none } });
    await seedArticle({ slug: 'unpublished', status: 'draft', listen: { publishedMarks: marksOver() } });

    for (const slug of ['no-listen', 'draft-only', 'unpublished', 'never-existed', 'Bad Slug/../x', '']) {
      const res = await callListen(slug);
      expect(res.status, slug).toBe(404);
      expect(res.env.ok).toBe(false);
      if (res.env.ok) continue;
      expect(res.env.error.code).toBe('NOT_FOUND');
      expect(res.headers.get('cache-control')).not.toBe('public, max-age=60');
    }
  });

  it('the TLDR DTO carries the same times.listen', async () => {
    const { id, rendered } = await seedArticle({ slug: 'both', listen: { publishedMarks: marksOver() } });
    await getDb()
      .insert(articleFormat)
      .values({
        siteId: siteRow.id,
        articleId: id,
        kind: 'tldr',
        publishedPayload: { slides: [{ sid: rendered.sentences[0].sid, text: rendered.sentences[0].text, source: 'jev', reason: null }], generationId: null },
        publishedRevisionId: null,
        publishedAt: new Date(),
      });

    const res = await tldrRoute(new Request(`${BASE}/api/public/articles/both/tldr`), { params: Promise.resolve<Record<string, string>>({ slug: 'both' }) });
    expect(res.status).toBe(200);
    const env = (await res.json()) as Envelope<PublicTldrDto>;
    expect(env.ok && env.data.times.listen).toBe(2);
  });
});
