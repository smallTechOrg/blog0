// Public Listen data against real blog0_test Postgres: the article view
// model's `listen` + `times.listen`, the home/card minutes, and GET /api/public/articles/:slug/listen.
// Readers get the PUBLISHED recording with marks RESOLVED per request over the PUBLISHED revision's
// paragraphs (resolveMarks: stored marks covering the text → 'synced', else estimateMarks over
// countWords → 'estimated') — a draft recording never leaks, an unpublished article never answers,
// and no admin field (asset id, storage key, fingerprints, uploader) leaves the server. The last
// block walks the admin routes: upload → publish (estimated) → paragraph edit + publish
// (re-estimated over the new pids, never blocked) → aligner PUT + publish (synced) → edit dropping
// a marked paragraph + publish (estimated again). Listen never calls the LLM.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PATCH as patchRoute } from '@/app/api/admin/articles/[id]/route';
import { POST as uploadRoute } from '@/app/api/admin/articles/[id]/audio/route';
import { GET as adminListenRoute, PUT as listenPutRoute } from '@/app/api/admin/articles/[id]/listen/route';
import { GET as listenRoute } from '@/app/api/public/articles/[slug]/listen/route';
import { GET as tldrRoute } from '@/app/api/public/articles/[slug]/tldr/route';
import type { ListenResponse, ListenStateDto, PublicListenDto, PublicTldrDto, UpdateArticleResponse } from '@/lib/api/dto';
import type { Envelope } from '@/lib/api/envelope';
import { countWords, estimateMarks, toTimedParagraphs } from '@/lib/listen/estimate';
import { listenMinutes } from '@/lib/listen/marks';
import { resetRenderCacheForTests } from '@/server/content';
import { getDb } from '@/server/db/client';
import { articleFormat, mediaAsset, type SiteRow } from '@/server/db/schema';
import { getHomeSections } from '@/server/public/home';
import { getPublishedArticle, listPublishedPostCards } from '@/server/public/articles';

import { actAs, call, createArticle, publish } from '../helpers/api';
import { resetDb } from '../helpers/db';
import { captureLogs, type CapturedLogs } from '../helpers/logs';
import { seedArticle as seed, seedUser } from '../helpers/seed-articles';
import { loginAs } from '../helpers/session';
import { resetStorage } from '../helpers/storage';

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
  /** Stored published marks over the published revision's pids (`none` = uploaded, no stored marks); omitted → no published Listen. */
  publishedMarks?: (pids: string[]) => Array<{ pid: string; tMs: number }>;
  /** Draft marks over the pids; `() => []` = uploaded but unsynced; omitted → no draft. */
  draftMarks?: (pids: string[]) => Array<{ pid: string; tMs: number }>;
  /** Raw published payload override (corrupt-payload case). */
  rawPublished?: unknown;
}

let siteRow: SiteRow;
let userId: string;
let logs: CapturedLogs;

async function seedArticle(input: { slug: string; status?: 'draft' | 'published'; listen?: ListenSeed; title?: string }) {
  const status = input.status ?? 'published';
  const { id, revisionId, rendered } = await seed({
    siteId: siteRow.id,
    slug: input.slug,
    status,
    title: input.title ?? 'Listen me',
    bodyMd: BODY,
    topic: 'Craft',
    bylineName: 'Asha Writer',
    firstPublishedAt: status === 'published' ? new Date(Date.UTC(2026, 8, 8, 3, 30)) : null,
    withPublishedRevision: status === 'published',
  });

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
        articleId: id,
        createdBy: userId,
      })
      .returning();
    audio = { assetId: asset.id, key, mimeType, bytes: 654_321, durationMs };
    const published =
      l.rawPublished !== undefined
        ? l.rawPublished
        : l.publishedMarks
          ? { audio, marks: l.publishedMarks(pids), syncFingerprint: rendered.fingerprints.paragraphs, uploadFingerprint: rendered.fingerprints.paragraphs }
          : null;
    const draftMarks = l.draftMarks ? l.draftMarks(pids) : null;
    const draft = draftMarks
      ? { audio: { ...audio, key: key.replace('.' + ext, '-draft.' + ext) }, marks: draftMarks, syncFingerprint: draftMarks.length ? rendered.fingerprints.paragraphs : null }
      : null;
    await getDb()
      .insert(articleFormat)
      .values({
        siteId: siteRow.id,
        articleId: id,
        kind: 'listen',
        draftPayload: draft,
        draftRevisionId: draft && draft.marks.length ? revisionId : null,
        draftFingerprint: draft && draft.marks.length ? rendered.fingerprints.paragraphs : null,
        publishedPayload: published,
        publishedRevisionId: published ? revisionId : null,
        publishedFingerprint: published ? rendered.fingerprints.paragraphs : null,
        publishedAt: published ? new Date() : null,
      });
  }
  return { id: id, pids, audio, rendered };
}

const marksOver = (startMs = 500, stepMs = 30_000) => (pids: string[]) => pids.map((pid, i) => ({ pid, tMs: startMs + i * stepMs }));
const none = () => [];

/** The reader marks expected when no stored marks cover the text. */
function estimatedFor(rendered: { paragraphs: ReadonlyArray<{ pid: string; text: string }> }, durationMs = DURATION_MS) {
  return estimateMarks(toTimedParagraphs(rendered.paragraphs), durationMs);
}

async function callListen(slug: string) {
  const res = await listenRoute(new Request(`${BASE}/api/public/articles/${encodeURIComponent(slug)}/listen`), {
    params: Promise.resolve<Record<string, string>>({ slug }),
  });
  return { status: res.status, headers: res.headers, env: (await res.json()) as Envelope<PublicListenDto> };
}

beforeEach(async () => {
  siteRow = await resetDb();
  resetRenderCacheForTests();
  userId = await seedUser(siteRow.id);
  logs = captureLogs();
});

afterEach(() => {
  logs.stop();
});

describe('article view model — published Listen', () => {
  it('exposes the published recording, its covering stored marks (synced) and listenMinutes; never the asset id or storage key', async () => {
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
      timing: 'synced',
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

  it('estimates the marks from the published text and duration when no marks are stored — the computed values, not just the length', async () => {
    const { rendered } = await seedArticle({ slug: 'estimated', listen: { publishedMarks: none } });
    const vm = await getPublishedArticle('estimated');
    expect(vm?.listen?.timing).toBe('estimated');
    const expected = estimateMarks(
      rendered.paragraphs.map((p) => ({ pid: p.pid, words: countWords(p.text) })),
      DURATION_MS,
    );
    expect(vm?.listen?.marks).toEqual(expected);
    // Hand-checked against the rule: weights 21.5, 20.5, 5.5, 9.5 (W = 57) over 140 000 ms →
    // floor(140000·21.5/57) = 52807, floor(140000·42/57) = 103157, floor(140000·47.5/57) = 116666.
    expect(rendered.paragraphs.map((p) => countWords(p.text))).toEqual([20, 19, 4, 8]);
    expect(vm?.listen?.marks.map((m) => m.tMs)).toEqual([0, 52807, 103157, 116666]);
    expect(vm?.listen?.marks.map((m) => m.pid)).toEqual(rendered.paragraphs.map((p) => p.pid));
    expect(vm?.times.listen).toBe(2);
  });

  it('falls back to the estimate when stored marks do not cover the text or are invalid (ignoring vanished pids)', async () => {
    const partial = await seedArticle({ slug: 'partial', listen: { publishedMarks: (pids) => marksOver()(pids).slice(0, 2) } });
    const invalid = await seedArticle({
      slug: 'not-increasing',
      listen: { publishedMarks: (pids) => pids.map((pid, i) => ({ pid, tMs: i === 2 ? 500 : 500 + i * 30_000 })) },
    });
    const extra = await seedArticle({
      slug: 'extra-orphan',
      listen: { publishedMarks: (pids) => [{ pid: 'p-vanished', tMs: 100 }, ...marksOver()(pids)] },
    });

    for (const [slug, seeded] of [['partial', partial], ['not-increasing', invalid]] as const) {
      const vm = await getPublishedArticle(slug);
      expect(vm?.listen?.timing, slug).toBe('estimated');
      expect(vm?.listen?.marks, slug).toEqual(estimatedFor(seeded.rendered));
    }
    // A mark for a vanished paragraph is dropped; the rest still cover the text → synced.
    const vm = await getPublishedArticle('extra-orphan');
    expect(vm?.listen?.timing).toBe('synced');
    expect(vm?.listen?.marks).toEqual(marksOver()(extra.pids));
  });

  it('ignores a corrupt published payload (logs a warning, never crashes the page)', async () => {
    await seedArticle({ slug: 'corrupt', listen: { rawPublished: { audio: { key: 'x' }, marks: 'nope' } } });

    expect((await getPublishedArticle('corrupt'))?.listen).toBeNull();
    expect((await getPublishedArticle('corrupt'))?.times.listen).toBeNull();
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
      timing: 'synced',
      bylineName: 'Asha Writer',
      times: { read: 1, tldr: null, listen: 2 },
      shareUrl: 'http://localhost:3410/p/synced/listen',
    });
    const raw = JSON.stringify(res.env.data);
    expect(raw).not.toContain(audio.assetId);
    expect(raw).not.toContain('syncFingerprint');
    expect(raw).not.toContain('-draft.');
  });

  it('serves estimated marks over the published paragraphs when the published Listen has no stored marks', async () => {
    const { rendered } = await seedArticle({ slug: 'est', listen: { publishedMarks: none, draftMarks: none } });
    const res = await callListen('est');
    expect(res.status).toBe(200);
    if (!res.env.ok) return;
    expect(res.env.data.timing).toBe('estimated');
    expect(res.env.data.marks).toEqual(estimatedFor(rendered));
    expect(res.env.data.marks).toHaveLength(rendered.paragraphs.length);
  });

  it('serves the PUBLISHED marks even when newer draft marks exist (no draft leak)', async () => {
    const { pids, audio } = await seedArticle({ slug: 'two-copies', listen: { publishedMarks: marksOver(1_000), draftMarks: marksOver(9_000) } });
    const published = marksOver(1_000)(pids);

    const res = await callListen('two-copies');
    expect(res.status).toBe(200);
    if (!res.env.ok) return;
    expect(res.env.data.marks).toEqual(published);
    expect(res.env.data.timing).toBe('synced');
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

describe('through the admin routes: estimated → re-estimated after an edit → synced → estimated again', () => {
  function ok<T>(r: { status: number; env: Envelope<T> }): T {
    if (!r.env.ok) throw new Error(`expected ok, got ${r.status} ${r.env.error.code}: ${r.env.error.message}`);
    return r.env.data;
  }
  const state = async (id: string) => ok(await call<ListenStateDto>(adminListenRoute, 'GET', `/api/admin/articles/${id}/listen`, { id }));
  async function publishOk(id: string, revisionId: string) {
    const res = await publish(id, revisionId);
    expect(res.status).toBe(200); // Listen never blocks
    return ok(res).article;
  }
  async function saveBody(a: { id: string }, baseRevisionId: string, bodyMd: string) {
    const saved = ok(await call<UpdateArticleResponse>(patchRoute, 'PATCH', `/api/admin/articles/${a.id}`, { body: { baseRevisionId, bodyMd }, id: a.id }));
    expect(saved.revisionCreated).toBe(true);
    return saved.article.currentRevision.id;
  }
  async function publicListen(slug: string): Promise<PublicListenDto> {
    const res = await callListen(slug);
    expect(res.status).toBe(200);
    return ok(res);
  }

  beforeEach(async () => {
    resetStorage();
    actAs(await loginAs({ displayName: 'Asha Writer' }));
  });

  it('keeps the reader timing in step with the published text across edits, an aligner PUT and publishes', async () => {
    const a = await createArticle({ title: 'Listen flow', topic: 'Craft', bodyMd: BODY });

    const form = new FormData();
    const bytes = readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'audio', 'sample.mp3'));
    form.set('file', new File([new Uint8Array(bytes)], 'sample.mp3', { type: 'audio/mpeg' }));
    const uploaded = ok(await call<ListenResponse>(uploadRoute, 'POST', `/api/admin/articles/${a.id}/audio`, { form, id: a.id })).listen;
    expect(uploaded.status).toBe('ready');
    const D = uploaded.audio!.durationMs;

    // 1. Publish right after the upload → estimated over the published paragraphs.
    await publishOk(a.id, a.currentRevision.id);
    const first = await publicListen(a.slug);
    expect(first.timing).toBe('estimated');
    expect(first.marks).toEqual(estimateMarks(toTimedParagraphs(uploaded.paragraphs), D));

    // 2. Edit one paragraph's text → text_changed (warning), publish 200 → re-estimated over the NEW pids.
    const target = uploaded.paragraphs[1];
    const rev2 = await saveBody(a, a.currentRevision.id, BODY.replace(target.text, `${target.text} Then a few more words arrive.`));
    const changed = await state(a.id);
    expect(changed.status).toBe('text_changed');
    const newPid = changed.paragraphs[1].pid;
    expect(newPid).not.toBe(target.pid);
    await publishOk(a.id, rev2);
    const second = await publicListen(a.slug);
    expect(second.timing).toBe('estimated');
    expect(second.marks.map((m) => m.pid)).toContain(newPid);
    expect(second.marks.map((m) => m.pid)).not.toContain(target.pid);
    expect(second.marks).toEqual(estimateMarks(toTimedParagraphs(changed.paragraphs), D));

    // 3. Aligner PUT with a complete valid set + publish → synced, the PUT set verbatim.
    const aligned = changed.paragraphs.map((p, i) => ({ pid: p.pid, tMs: 300 + i * 4_000 }));
    const put = await call<ListenResponse>(listenPutRoute, 'PUT', `/api/admin/articles/${a.id}/listen`, { body: { revisionId: rev2, marks: aligned }, id: a.id });
    expect(put.status).toBe(200);
    expect(ok(put).listen.status).toBe('text_changed'); // a PUT never changes the status
    await publishOk(a.id, rev2);
    const third = await publicListen(a.slug);
    expect(third.timing).toBe('synced');
    expect(third.marks).toEqual(aligned);

    // 4. An edit that drops one marked paragraph and adds a new one + publish → estimated again.
    const dropped = changed.paragraphs[2];
    const bodyNow = BODY.replace(target.text, `${target.text} Then a few more words arrive.`);
    const rev3 = await saveBody(a, rev2, bodyNow.replace(`- ${dropped.text}`, '- A brand new list item replaces the old one.'));
    const after = await state(a.id);
    expect(after.paragraphs.map((p) => p.pid)).not.toContain(dropped.pid);
    await publishOk(a.id, rev3);
    const fourth = await publicListen(a.slug);
    expect(fourth.timing).toBe('estimated');
    expect(fourth.marks).toEqual(estimateMarks(toTimedParagraphs(after.paragraphs), D));
    expect(fourth.marks.map((m) => m.pid)).not.toContain(dropped.pid);
  });
});
