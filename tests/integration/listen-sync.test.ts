// Listen sync API (S3.3) against real blog0_test: GET state, PUT marks (every MARKS_INVALID
// reason, CONFLICT, LISTEN_NO_AUDIO), stale detection on paragraph edits, the LISTEN_STALE
// publish guard with missingPids/orphanPids, re-sync, and the publish matrix (ready copies,
// needs_sync leaves the published copy, no draft clears it). Listen never calls the LLM.
//
// The draft recording is seeded exactly as S3.2's ingest writes it (media_asset row + the
// listen row's draft_payload); sync never touches storage, so no file is needed here. S3.6's
// E2E covers the real upload → sync → publish journey through the audio route.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { and, count, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { GET as listRoute, POST as createRoute } from '@/app/api/admin/articles/route';
import { PATCH as patchRoute } from '@/app/api/admin/articles/[id]/route';
import { POST as uploadRoute } from '@/app/api/admin/articles/[id]/audio/route';
import { GET as listenGetRoute, PUT as listenPutRoute } from '@/app/api/admin/articles/[id]/listen/route';
import { POST as publishRoute } from '@/app/api/admin/articles/[id]/publish/route';
import type { ArticleDetailDto, ArticleListResponse, ArticleResponse, PublishBlockedDetails, UpdateArticleResponse } from '@/lib/api/dto';
import type { ListenMarkDto, ListenResponse, ListenStateDto, MarksInvalidDetails } from '@/lib/api/dto-phase3';
import type { Envelope, Err } from '@/lib/api/envelope';
import { getDb } from '@/server/db/client';
import { aiGeneration, articleFormat, articleRevision, mediaAsset } from '@/server/db/schema';
import { readListenPayload, type ListenPayload } from '@/server/formats/payload';
import { getPublishedArticle } from '@/server/public/articles';
import { getCurrentSite } from '@/server/site/current';

import { resetDb } from '../helpers/db';
import { loginAs, type TestLogin } from '../helpers/session';
import { resetStorage } from '../helpers/storage';

const ORIGIN = 'http://localhost:3410';
const DURATION_MS = 20_480;
const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'audio');

const BODY = [
  '## Why decks',
  '',
  'The deck shows the strongest lines of the article in order. Each slide holds exactly one sentence from the text.',
  '',
  'Writers pick the lines by hand when the model is unavailable. That keeps publishing moving on a bad day.',
  '',
  '## How it works',
  '',
  'The server owns every word that appears on a slide. Nothing the model writes ever reaches a reader.',
  '',
  '- A short list item.',
  '- Another list item with more words in it.',
  '',
  '> A quoted paragraph that is also read aloud.',
  '',
  'Readers can open the deck from any article page. The published deck keeps serving until the next publish.',
].join('\n');

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

let writer: TestLogin;

async function call<T>(handler: Handler, method: string, url: string, opts: { body?: unknown; id?: string; who?: TestLogin } = {}) {
  const headers: Record<string, string> = { host: 'localhost:3410', cookie: (opts.who ?? writer).cookie };
  if (method !== 'GET') headers.origin = ORIGIN;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await handler(
    new Request(`${ORIGIN}${url}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
    { params: Promise.resolve<Record<string, string>>(opts.id ? { id: opts.id } : {}) },
  );
  return { status: res.status, env: (await res.json()) as Envelope<T> };
}

function data<T>(env: Envelope<T>): T {
  if (!env.ok) throw new Error(`expected ok envelope, got ${env.error.code}: ${env.error.message}`);
  return env.data;
}

function err(env: Envelope<unknown>): Err['error'] {
  if (env.ok) throw new Error('expected an error envelope');
  return env.error;
}

async function createArticle(body: Record<string, unknown> = {}): Promise<ArticleDetailDto> {
  const res = await call<ArticleResponse>(createRoute, 'POST', '/api/admin/articles', {
    body: { title: 'Listen me', topic: 'Craft', bodyMd: BODY, ...body },
  });
  return data(res.env).article;
}
async function save(id: string, body: Record<string, unknown>) {
  return data((await call<UpdateArticleResponse>(patchRoute, 'PATCH', `/api/admin/articles/${id}`, { body, id })).env);
}
async function listen(id: string): Promise<ListenStateDto> {
  return data((await call<ListenStateDto>(listenGetRoute, 'GET', `/api/admin/articles/${id}/listen`, { id })).env);
}
async function putMarks(id: string, body: Record<string, unknown>) {
  return call<ListenResponse>(listenPutRoute, 'PUT', `/api/admin/articles/${id}/listen`, { body, id });
}
async function publish(id: string, revisionId: string) {
  return call<ArticleResponse>(publishRoute, 'POST', `/api/admin/articles/${id}/publish`, { body: { revisionId }, id });
}
async function deskChip(id: string, kind: string) {
  const list = data((await call<ArticleListResponse>(listRoute, 'GET', '/api/admin/articles')).env).articles;
  return list.find((a) => a.id === id)!.formats.find((f) => f.kind === kind)!;
}

async function listenRow(articleId: string) {
  const [row] = await getDb()
    .select()
    .from(articleFormat)
    .where(and(eq(articleFormat.articleId, articleId), eq(articleFormat.kind, 'listen')));
  return row ?? null;
}
async function draftPayload(articleId: string): Promise<ListenPayload | null> {
  return readListenPayload((await listenRow(articleId))?.draftPayload);
}
async function publishedPayload(articleId: string): Promise<ListenPayload | null> {
  return readListenPayload((await listenRow(articleId))?.publishedPayload);
}
async function paragraphsFingerprint(revisionId: string): Promise<string> {
  const [row] = await getDb().select({ fp: articleRevision.paragraphsFingerprint }).from(articleRevision).where(eq(articleRevision.id, revisionId));
  return row.fp;
}
async function generationRows(articleId: string): Promise<number> {
  const [row] = await getDb().select({ n: count() }).from(aiGeneration).where(eq(aiGeneration.articleId, articleId));
  return Number(row.n);
}

/** Seeds a draft recording the way S3.2's ingest does (media_asset + listen draft, marks cleared). */
async function seedAudio(articleId: string, opts: { durationMs?: number; ext?: 'mp3' | 'm4a'; who?: TestLogin } = {}) {
  const site = await getCurrentSite();
  const durationMs = opts.durationMs ?? DURATION_MS;
  const ext = opts.ext ?? 'mp3';
  const mimeType = ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
  const key = `${site.slug}/audio/2026/10/${randomUUID()}.${ext}`;
  const [asset] = await getDb()
    .insert(mediaAsset)
    .values({
      siteId: site.id,
      kind: 'audio',
      storageKey: key,
      originalFilename: `reading.${ext}`,
      mimeType,
      byteSize: 321_456,
      sha256: 'ab'.repeat(32),
      durationSec: durationMs / 1000,
      articleId,
      createdBy: (opts.who ?? writer).user.id,
    })
    .returning();
  const payload: ListenPayload = {
    audio: { assetId: asset.id, key, mimeType, bytes: asset.byteSize, durationMs },
    marks: [],
    syncFingerprint: null,
  };
  const values = {
    draftPayload: payload,
    draftRevisionId: null,
    draftFingerprint: null,
    draftUpdatedBy: (opts.who ?? writer).user.id,
    draftUpdatedAt: new Date(),
  };
  await getDb()
    .insert(articleFormat)
    .values({ siteId: site.id, articleId, kind: 'listen', ...values })
    .onConflictDoUpdate({ target: [articleFormat.articleId, articleFormat.kind], set: values });
  return payload.audio;
}

/** Remove audio the way S3.2 does: draft payload cleared, row kept. */
async function clearDraft(articleId: string) {
  await getDb()
    .update(articleFormat)
    .set({ draftPayload: null, draftRevisionId: null, draftFingerprint: null })
    .where(and(eq(articleFormat.articleId, articleId), eq(articleFormat.kind, 'listen')));
}

function marksFor(state: ListenStateDto, startMs = 800, stepMs = 2_500): ListenMarkDto[] {
  return state.paragraphs.map((p, i) => ({ pid: p.pid, tMs: startMs + i * stepMs }));
}

function editParagraph(bodyMd: string, text: string): string {
  expect(bodyMd.includes(text)).toBe(true);
  return bodyMd.replace(text, `${text} Edited, so the words changed.`);
}

beforeEach(async () => {
  await resetDb();
  writer = await loginAs({ displayName: 'Asha Writer' });
});

describe('GET /api/admin/articles/:id/listen', () => {
  it('lists the current revision paragraphs in order with status missing and no audio before any upload', async () => {
    const a = await createArticle();
    const state = await listen(a.id);

    expect(state.status).toBe('missing');
    expect(state.audio).toBeNull();
    expect(state.marks).toEqual([]);
    expect(state.revisionId).toBe(a.currentRevision.id);
    expect(state.syncFingerprint).toBeNull();
    expect(state.published).toBeNull();
    expect(state.limits).toEqual({ maxAudioMb: 50, maxAudioMinutes: 30 });
    // p, li and quote paragraphs only — the two headings are not paragraphs.
    expect(state.paragraphs.map((p) => p.kind)).toEqual(['p', 'p', 'p', 'li', 'li', 'quote', 'p']);
    expect(state.paragraphs.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(state.paragraphs[0].text).toBe(
      'The deck shows the strongest lines of the article in order. Each slide holds exactly one sentence from the text.',
    );
    expect(state.paragraphs[3].text).toBe('A short list item.');
    expect(state.paragraphs[5].text).toBe('A quoted paragraph that is also read aloud.');
    expect(state.paragraphs[6].headingPath).toEqual(['How it works']);
    expect(state.paragraphs.every((p) => /^p-[0-9a-f]{8}(-\d+)?$/.test(p.pid))).toBe(true);
    expect(state.missingPids).toEqual(state.paragraphs.map((p) => p.pid));
    expect(state.orphanPids).toEqual([]);
  });

  it('is needs_sync with the draft recording and every paragraph missing after an upload', async () => {
    const a = await createArticle();
    const audio = await seedAudio(a.id);
    const state = await listen(a.id);

    expect(state.status).toBe('needs_sync');
    expect(state.audio).toMatchObject({
      assetId: audio.assetId,
      key: audio.key,
      url: `/media/${audio.key}`,
      mimeType: 'audio/mpeg',
      bytes: 321_456,
      durationMs: DURATION_MS,
      originalFilename: 'reading.mp3',
      uploadedBy: 'Asha Writer',
    });
    expect(new Date(state.audio!.uploadedAt).getTime()).toBeGreaterThan(0);
    expect(state.marks).toEqual([]);
    expect(state.missingPids).toEqual(state.paragraphs.map((p) => p.pid));
    expect(state.orphanPids).toEqual([]);
    expect((await deskChip(a.id, 'listen')).status).toBe('needs_sync');
  });

  it('404s for an unknown article', async () => {
    const res = await call(listenGetRoute, 'GET', `/api/admin/articles/${randomUUID()}/listen`, { id: randomUUID() });
    expect(res.status).toBe(404);
    expect(err(res.env).code).toBe('NOT_FOUND');
  });
});

describe('PUT /api/admin/articles/:id/listen — save sync', () => {
  it('saves a complete increasing set → ready with the revision paragraphs fingerprint; a second GET returns the same marks', async () => {
    const a = await createArticle();
    await seedAudio(a.id);
    const before = await listen(a.id);
    const marks = marksFor(before);

    const res = await putMarks(a.id, { revisionId: a.currentRevision.id, marks });
    expect(res.status).toBe(200);
    const saved = data(res.env).listen;
    expect(saved.status).toBe('ready');
    expect(saved.marks).toEqual(marks);
    expect(saved.syncFingerprint).toBe(await paragraphsFingerprint(a.currentRevision.id));
    expect(saved.syncedBy).toBe('Asha Writer');
    expect(saved.syncedAt).not.toBeNull();
    expect(saved.missingPids).toEqual([]);
    expect(saved.orphanPids).toEqual([]);
    expect(saved.published).toBeNull();

    const again = await listen(a.id);
    expect(again.marks).toEqual(marks);
    expect(again.status).toBe('ready');

    const row = (await listenRow(a.id))!;
    expect(row.draftFingerprint).toBe(saved.syncFingerprint);
    expect(row.draftRevisionId).toBe(a.currentRevision.id);
    expect(readListenPayload(row.draftPayload)?.marks).toEqual(marks);

    expect(await deskChip(a.id, 'listen')).toEqual({ kind: 'listen', status: 'ready', published: false, hasUnpublishedChanges: false });
    expect(await generationRows(a.id)).toBe(0);
  });

  it('refuses every invalid set with 422 MARKS_INVALID listing each reason, and leaves the draft untouched', async () => {
    const a = await createArticle();
    await seedAudio(a.id);
    const state = await listen(a.id);
    const good = marksFor(state);
    const rev = a.currentRevision.id;

    const attempt = async (marks: ListenMarkDto[]) => {
      const res = await putMarks(a.id, { revisionId: rev, marks });
      expect(res.status).toBe(422);
      const e = err(res.env);
      expect(e.code).toBe('MARKS_INVALID');
      return (e.details as MarksInvalidDetails).reasons;
    };

    const notIncreasing = good.map((m, i) => (i === 2 ? { ...m, tMs: good[1].tMs } : m));
    expect(await attempt(notIncreasing)).toEqual([{ code: 'NOT_INCREASING', pid: good[2].pid, index: 2 }]);

    const unknown = good.map((m, i) => (i === 4 ? { ...m, pid: 'p-deadbeef' } : m));
    expect(await attempt(unknown)).toEqual([
      { code: 'UNKNOWN_PID', pid: 'p-deadbeef', index: 4 },
      { code: 'MISSING_PID', pid: good[4].pid },
    ]);

    const omitted = good.filter((_, i) => i !== 1);
    expect(await attempt(omitted)).toEqual([{ code: 'MISSING_PID', pid: good[1].pid }]);

    const duplicate = good.map((m, i) => (i === 3 ? { ...m, pid: good[2].pid } : m));
    expect(await attempt(duplicate)).toEqual([
      { code: 'DUPLICATE_PID', pid: good[2].pid, index: 3 },
      { code: 'MISSING_PID', pid: good[3].pid },
    ]);

    const swapped = good.map((m, i) => (i === 1 ? { ...m, pid: good[2].pid } : i === 2 ? { ...m, pid: good[1].pid } : m));
    expect(await attempt(swapped)).toEqual([{ code: 'OUT_OF_ORDER', pid: good[1].pid, index: 2 }]);

    const atDuration = good.map((m, i) => (i === good.length - 1 ? { ...m, tMs: DURATION_MS } : m));
    expect(await attempt(atDuration)).toEqual([{ code: 'OUT_OF_RANGE', pid: good[good.length - 1].pid, index: good.length - 1 }]);

    const fractional = good.map((m, i) => (i === 0 ? { ...m, tMs: 800.5 } : m));
    expect(await attempt(fractional)).toEqual([{ code: 'OUT_OF_RANGE', pid: good[0].pid, index: 0 }]);

    const after = await listen(a.id);
    expect(after.status).toBe('needs_sync');
    expect(after.marks).toEqual([]);
    expect((await draftPayload(a.id))?.marks).toEqual([]);
  });

  it('rejects malformed bodies with 400 VALIDATION_FAILED', async () => {
    const a = await createArticle();
    await seedAudio(a.id);
    const res = await putMarks(a.id, { revisionId: a.currentRevision.id, marks: [{ pid: 'p-1', tMs: 'soon' }] });
    expect(res.status).toBe(400);
    expect(err(res.env).code).toBe('VALIDATION_FAILED');
    const missing = await putMarks(a.id, { marks: [] });
    expect(missing.status).toBe(400);
  });

  it('answers 409 CONFLICT for a stale revisionId and 409 LISTEN_NO_AUDIO with no recording; neither changes the draft', async () => {
    const a = await createArticle();
    const state = await listen(a.id);

    const noAudio = await putMarks(a.id, { revisionId: a.currentRevision.id, marks: marksFor(state) });
    expect(noAudio.status).toBe(409);
    expect(err(noAudio.env).code).toBe('LISTEN_NO_AUDIO');
    expect(await listenRow(a.id)).toBeNull();

    await seedAudio(a.id);
    const saved = await save(a.id, { baseRevisionId: a.currentRevision.id, title: 'Listen me, renamed' });
    expect(saved.revisionCreated).toBe(true);
    const conflict = await putMarks(a.id, { revisionId: a.currentRevision.id, marks: marksFor(state) });
    expect(conflict.status).toBe(409);
    expect(err(conflict.env).code).toBe('CONFLICT');
    expect((await draftPayload(a.id))?.marks).toEqual([]);

    const ok = await putMarks(a.id, { revisionId: saved.article.currentRevision.id, marks: marksFor(state) });
    expect(ok.status).toBe(200);
    expect(data(ok.env).listen.status).toBe('ready');
  });

  it('is ignored by the LLM ledger: syncing creates no ai_generation row', async () => {
    const a = await createArticle();
    await seedAudio(a.id);
    const state = await listen(a.id);
    await putMarks(a.id, { revisionId: a.currentRevision.id, marks: marksFor(state) });
    expect(await generationRows(a.id)).toBe(0);
  });
});

describe('stale detection + publish guard', () => {
  async function readyArticle() {
    const a = await createArticle();
    const audio = await seedAudio(a.id);
    const state = await listen(a.id);
    const marks = marksFor(state);
    const res = await putMarks(a.id, { revisionId: a.currentRevision.id, marks });
    expect(data(res.env).listen.status).toBe('ready');
    return { a, audio, state, marks };
  }

  it('publish copies a ready draft to the published Listen; the public article is published', async () => {
    const { a, audio, marks } = await readyArticle();
    const res = await publish(a.id, a.currentRevision.id);
    expect(res.status).toBe(200);
    const article = data(res.env).article;
    expect(article.status).toBe('published');
    expect(article.formats.find((f) => f.kind === 'listen')).toEqual({
      kind: 'listen',
      status: 'ready',
      published: true,
      hasUnpublishedChanges: false,
    });

    const row = (await listenRow(a.id))!;
    const published = readListenPayload(row.publishedPayload)!;
    expect(published.marks).toEqual(marks);
    expect(published.audio.key).toBe(audio.key);
    expect(published.syncFingerprint).toBe(await paragraphsFingerprint(a.currentRevision.id));
    expect(row.publishedFingerprint).toBe(published.syncFingerprint);
    expect(row.publishedRevisionId).toBe(a.currentRevision.id);
    expect(row.publishedAt).not.toBeNull();

    const state = await listen(a.id);
    expect(state.published).toMatchObject({ durationMs: DURATION_MS, markCount: marks.length, matchesCurrentText: true });
    expect(await getPublishedArticle(a.slug)).not.toBeNull();
  });

  it('editing one paragraph → stale with exactly the new pid missing and the old pid orphaned; publish blocked with LISTEN_STALE; the published Listen keeps serving', async () => {
    const { a, state, marks } = await readyArticle();
    await publish(a.id, a.currentRevision.id);
    const before = await publishedPayload(a.id);

    const target = state.paragraphs[2];
    const saved = await save(a.id, { baseRevisionId: a.currentRevision.id, bodyMd: editParagraph(BODY, target.text) });
    expect(saved.revisionCreated).toBe(true);

    const stale = await listen(a.id);
    expect(stale.status).toBe('stale');
    expect(stale.revisionId).toBe(saved.article.currentRevision.id);
    const newPid = stale.paragraphs[2].pid;
    expect(newPid).not.toBe(target.pid);
    expect(stale.missingPids).toEqual([newPid]);
    expect(stale.orphanPids).toEqual([target.pid]);
    expect(stale.marks).toEqual(marks); // kept verbatim, including the orphaned one
    expect(stale.published?.matchesCurrentText).toBe(false);
    expect(await deskChip(a.id, 'listen')).toMatchObject({ status: 'stale', published: true });

    const blocked = await publish(a.id, saved.article.currentRevision.id);
    expect(blocked.status).toBe(422);
    const e = err(blocked.env);
    expect(e.code).toBe('PUBLISH_BLOCKED');
    const reasons = (e.details as PublishBlockedDetails).reasons;
    expect(reasons).toEqual([expect.objectContaining({ code: 'LISTEN_STALE', missingPids: [newPid], orphanPids: [target.pid] })]);
    expect(reasons[0].message).toMatch(/text changed/i);

    expect(await publishedPayload(a.id)).toEqual(before);
    const article = await getPublishedArticle(a.slug);
    expect(article).not.toBeNull();
    expect(await generationRows(a.id)).toBe(0);
  });

  it('editing only a heading leaves Listen ready (paragraph set unchanged)', async () => {
    const { a, marks } = await readyArticle();
    const saved = await save(a.id, { baseRevisionId: a.currentRevision.id, bodyMd: BODY.replace('## Why decks', '## Why decks matter') });
    expect(saved.revisionCreated).toBe(true);
    const state = await listen(a.id);
    expect(state.status).toBe('ready');
    expect(state.marks).toEqual(marks);
    expect(state.missingPids).toEqual([]);
    expect(state.orphanPids).toEqual([]);
    expect(state.syncFingerprint).toBe(await paragraphsFingerprint(saved.article.currentRevision.id));
    const res = await publish(a.id, saved.article.currentRevision.id);
    expect(res.status).toBe(200);
  });

  it('re-syncing a stale draft with a complete set → ready; publish → 200 with the new marks and current key', async () => {
    const { a, state } = await readyArticle();
    await publish(a.id, a.currentRevision.id);
    const saved = await save(a.id, { baseRevisionId: a.currentRevision.id, bodyMd: editParagraph(BODY, state.paragraphs[0].text) });
    const stale = await listen(a.id);
    expect(stale.status).toBe('stale');

    // Partial re-sync (orphan still present, new pid missing) is refused.
    const partial = await putMarks(a.id, { revisionId: saved.article.currentRevision.id, marks: stale.marks });
    expect(partial.status).toBe(422);
    expect((err(partial.env).details as MarksInvalidDetails).reasons).toEqual([
      { code: 'UNKNOWN_PID', pid: state.paragraphs[0].pid, index: 0 },
      { code: 'MISSING_PID', pid: stale.paragraphs[0].pid },
    ]);

    const newMarks = marksFor(stale, 1_200, 2_400);
    const res = await putMarks(a.id, { revisionId: saved.article.currentRevision.id, marks: newMarks });
    expect(res.status).toBe(200);
    expect(data(res.env).listen.status).toBe('ready');
    expect(data(res.env).listen.orphanPids).toEqual([]);

    const published = await publish(a.id, saved.article.currentRevision.id);
    expect(published.status).toBe(200);
    const payload = (await publishedPayload(a.id))!;
    expect(payload.marks).toEqual(newMarks);
    expect(payload.audio.key).toBe(stale.audio!.key);
    expect(payload.syncFingerprint).toBe(await paragraphsFingerprint(saved.article.currentRevision.id));
  });

  it('publish with audio but no marks: allowed on a never-published Listen (not offered), allowed when the live Listen still matches (unchanged), blocked when the text changed', async () => {
    const a = await createArticle();
    await seedAudio(a.id);

    // 1. Never published Listen, needs_sync → publish ok, nothing published for Listen.
    const first = await publish(a.id, a.currentRevision.id);
    expect(first.status).toBe(200);
    expect(await publishedPayload(a.id)).toBeNull();
    expect(data(first.env).article.formats.find((f) => f.kind === 'listen')).toEqual({
      kind: 'listen',
      status: 'needs_sync',
      published: false,
      hasUnpublishedChanges: true,
    });
    const publicArticle = await getPublishedArticle(a.slug);
    expect(publicArticle?.times.listen ?? null).toBeNull();

    // 2. Sync + publish, then a new upload (marks cleared) with the text unchanged → publish ok, published Listen unchanged.
    const state = await listen(a.id);
    await putMarks(a.id, { revisionId: a.currentRevision.id, marks: marksFor(state) });
    await publish(a.id, a.currentRevision.id);
    const live = await publishedPayload(a.id);
    expect(live?.marks).toHaveLength(state.paragraphs.length);
    const replacement = await seedAudio(a.id, { ext: 'm4a' });
    expect((await listen(a.id)).status).toBe('needs_sync');
    expect(await deskChip(a.id, 'listen')).toMatchObject({ status: 'needs_sync', published: true, hasUnpublishedChanges: true });
    const second = await publish(a.id, a.currentRevision.id);
    expect(second.status).toBe(200);
    expect(await publishedPayload(a.id)).toEqual(live);
    expect((await publishedPayload(a.id))!.audio.key).not.toBe(replacement.key);

    // 3. The text changed while the draft is unsynced → the live reading no longer matches → blocked.
    const saved = await save(a.id, { baseRevisionId: a.currentRevision.id, bodyMd: editParagraph(BODY, state.paragraphs[1].text) });
    const blocked = await publish(a.id, saved.article.currentRevision.id);
    expect(blocked.status).toBe(422);
    const reasons = (err(blocked.env).details as PublishBlockedDetails).reasons;
    expect(reasons).toHaveLength(1);
    expect(reasons[0].code).toBe('LISTEN_STALE');
    expect(reasons[0].message).toMatch(/live reading no longer matches/i);
    expect(reasons[0].orphanPids).toEqual([state.paragraphs[1].pid]);
    expect(reasons[0].missingPids).toHaveLength(1);
    expect(await publishedPayload(a.id)).toEqual(live);
  });

  it('publish with no Listen draft at all clears the published Listen', async () => {
    const a = await createArticle();
    await seedAudio(a.id);
    const state = await listen(a.id);
    await putMarks(a.id, { revisionId: a.currentRevision.id, marks: marksFor(state) });
    await publish(a.id, a.currentRevision.id);
    expect(await publishedPayload(a.id)).not.toBeNull();

    await clearDraft(a.id);
    expect((await listen(a.id)).status).toBe('missing');
    expect(await deskChip(a.id, 'listen')).toMatchObject({ status: 'missing', published: true, hasUnpublishedChanges: true });

    const res = await publish(a.id, a.currentRevision.id);
    expect(res.status).toBe(200);
    const row = (await listenRow(a.id))!;
    expect(row.publishedPayload).toBeNull();
    expect(row.publishedFingerprint).toBeNull();
    expect(row.publishedRevisionId).toBeNull();
    expect(row.publishedAt).toBeNull();
    expect(data(res.env).article.formats.find((f) => f.kind === 'listen')).toEqual({
      kind: 'listen',
      status: 'missing',
      published: false,
      hasUnpublishedChanges: false,
    });
  });

  it('survives a reload: the saved marks come back from the database on a fresh GET after other writes', async () => {
    const { a, marks } = await readyArticle();
    await save(a.id, { baseRevisionId: a.currentRevision.id, topic: 'Changed topic' });
    const state = await listen(a.id);
    expect(state.status).toBe('ready');
    expect(state.marks).toEqual(marks);
  });
});

describe('through the real audio route (S3.2): upload → sync → publish', () => {
  it('syncs a recording uploaded as multipart and publishes it with the stored key', async () => {
    const storageDir = resetStorage();
    const known = JSON.parse(readFileSync(path.join(FIXTURES, 'sample.json'), 'utf8')) as { mp3: { durationMs: number; bytes: number } };
    const bytes = readFileSync(path.join(FIXTURES, 'sample.mp3'));
    const a = await createArticle();

    const form = new FormData();
    form.set('file', new File([new Uint8Array(bytes)], 'sample.mp3', { type: 'audio/mpeg' }));
    const res = await uploadRoute(
      new Request(`${ORIGIN}/api/admin/articles/${a.id}/audio`, { method: 'POST', headers: { host: 'localhost:3410', origin: ORIGIN, cookie: writer.cookie }, body: form }),
      { params: Promise.resolve({ id: a.id }) },
    );
    expect(res.status).toBe(200);
    const uploaded = data((await res.json()) as Envelope<ListenResponse>).listen;
    expect(uploaded.status).toBe('needs_sync');
    expect(uploaded.audio).toMatchObject({ mimeType: 'audio/mpeg', bytes: known.mp3.bytes, originalFilename: 'sample.mp3', uploadedBy: 'Asha Writer' });
    expect(Math.abs(uploaded.audio!.durationMs - known.mp3.durationMs)).toBeLessThanOrEqual(500);
    expect(uploaded.audio!.url).toBe(`/media/${uploaded.audio!.key}`);
    expect(existsSync(path.join(storageDir, uploaded.audio!.key))).toBe(true);
    expect(uploaded.missingPids).toEqual(uploaded.paragraphs.map((p) => p.pid));

    // Marks must stay inside the real recording's duration.
    const tooLong = marksFor(uploaded, 500, 5_000);
    const refused = await putMarks(a.id, { revisionId: a.currentRevision.id, marks: tooLong });
    expect(refused.status).toBe(422);
    expect((err(refused.env).details as MarksInvalidDetails).reasons.every((r) => r.code === 'OUT_OF_RANGE')).toBe(true);

    const marks = marksFor(uploaded, 500, 2_500);
    const saved = await putMarks(a.id, { revisionId: a.currentRevision.id, marks });
    expect(saved.status).toBe(200);
    expect(data(saved.env).listen.status).toBe('ready');

    const published = await publish(a.id, a.currentRevision.id);
    expect(published.status).toBe(200);
    const payload = (await publishedPayload(a.id))!;
    expect(payload.audio.key).toBe(uploaded.audio!.key);
    expect(payload.audio.durationMs).toBe(uploaded.audio!.durationMs);
    expect(payload.marks).toEqual(marks);
    expect((await listen(a.id)).published).toMatchObject({ durationMs: uploaded.audio!.durationMs, markCount: marks.length, matchesCurrentText: true });
    expect(await generationRows(a.id)).toBe(0);
  });
});
