// Listen state + aligner-facing sync API against real blog0_test: upload ⇒ ready,
// a paragraph text edit ⇒ text_changed (warning only — publish is NEVER blocked by Listen),
// heading-only edits and reverts stay/return ready, re-upload re-baselines; PUT …/listen keeps its
// validation contract (every MARKS_INVALID reason, CONFLICT, LISTEN_NO_AUDIO) and never changes the
// status or uploadFingerprint; publish copies the draft whatever its status, or clears the
// published copy with no draft. Listen never calls the LLM.
//
// The draft recording is seeded exactly as the ingest writes it (media_asset row + the listen
// row's draft_payload with uploadFingerprint = the current paragraphs fingerprint); sync never
// touches storage, so no file is needed except in the real-route cases at the end.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { and, count, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { GET as listRoute } from '@/app/api/admin/articles/route';
import { PATCH as patchRoute } from '@/app/api/admin/articles/[id]/route';
import { POST as uploadRoute } from '@/app/api/admin/articles/[id]/audio/route';
import { GET as listenGetRoute, PUT as listenPutRoute } from '@/app/api/admin/articles/[id]/listen/route';
import type { ArticleDetailDto, ArticleListResponse, ListenMarkDto, ListenResponse, ListenStateDto, MarksInvalidDetails, UpdateArticleResponse } from '@/lib/api/dto';
import type { Envelope } from '@/lib/api/envelope';
import { getDb } from '@/server/db/client';
import { aiGeneration, article, articleFormat, articleRevision, mediaAsset } from '@/server/db/schema';
import { estimateMarks, toTimedParagraphs } from '@/lib/listen/estimate';
import { readListenPayload, type ListenPayload } from '@/server/formats/payload';
import { getPublishedArticle } from '@/server/public/articles';
import { getCurrentSite } from '@/server/site/current';

import { actAs, call, createArticle as create, data, err, ORIGIN, publish } from '../helpers/api';
import { resetDb } from '../helpers/db';
import { loginAs, type TestLogin } from '../helpers/session';
import { resetStorage } from '../helpers/storage';

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

let writer: TestLogin;

function createArticle(body: Record<string, unknown> = {}): Promise<ArticleDetailDto> {
  return create({ title: 'Listen me', topic: 'Craft', bodyMd: BODY, ...body });
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

async function currentParagraphsFingerprint(articleId: string): Promise<string> {
  const [row] = await getDb()
    .select({ fp: articleRevision.paragraphsFingerprint })
    .from(article)
    .innerJoin(articleRevision, eq(articleRevision.id, article.currentRevisionId))
    .where(eq(article.id, articleId));
  return row.fp;
}

/**
 * Seeds a draft recording the way the ingest does (media_asset + listen draft, marks cleared,
 * uploadFingerprint = the current paragraphs fingerprint). `legacy` writes a tap-sync era payload with
 * no uploadFingerprint key (optionally with a syncFingerprint) to exercise the fallback.
 */
async function seedAudio(
  articleId: string,
  opts: { durationMs?: number; ext?: 'mp3' | 'm4a'; who?: TestLogin; legacy?: { syncFingerprint: string | null; marks?: ListenMarkDto[] } } = {},
) {
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
  const audio = { assetId: asset.id, key, mimeType, bytes: asset.byteSize, durationMs } as ListenPayload['audio'];
  const fp = await currentParagraphsFingerprint(articleId);
  const payload: Record<string, unknown> = opts.legacy
    ? { audio, marks: opts.legacy.marks ?? [], syncFingerprint: opts.legacy.syncFingerprint }
    : { audio, marks: [], syncFingerprint: null, uploadFingerprint: fp };
  const values = {
    draftPayload: payload,
    draftRevisionId: null,
    draftFingerprint: opts.legacy ? opts.legacy.syncFingerprint : fp,
    draftUpdatedBy: (opts.who ?? writer).user.id,
    draftUpdatedAt: new Date(),
  };
  await getDb()
    .insert(articleFormat)
    .values({ siteId: site.id, articleId, kind: 'listen', ...values })
    .onConflictDoUpdate({ target: [articleFormat.articleId, articleFormat.kind], set: values });
  return audio;
}

/** Remove audio the way removeAudio does: draft payload cleared, row kept. */
async function clearDraft(articleId: string) {
  await getDb()
    .update(articleFormat)
    .set({ draftPayload: null, draftRevisionId: null, draftFingerprint: null })
    .where(and(eq(articleFormat.articleId, articleId), eq(articleFormat.kind, 'listen')));
}

function marksFor(state: ListenStateDto, startMs = 800, stepMs = 2_500): ListenMarkDto[] {
  return state.paragraphs.map((p, i) => ({ pid: p.pid, tMs: startMs + i * stepMs }));
}

/** What readers get for these paragraphs when no stored marks cover them. */
function expectedEstimate(paragraphs: ReadonlyArray<{ pid: string; text: string }>, durationMs: number) {
  return estimateMarks(toTimedParagraphs(paragraphs), durationMs);
}

async function uploadFile(id: string, file: 'sample.mp3' | 'sample.m4a') {
  const bytes = readFileSync(path.join(FIXTURES, file));
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], file, { type: file.endsWith('mp3') ? 'audio/mpeg' : 'audio/mp4' }));
  const res = await uploadRoute(
    new Request(`${ORIGIN}/api/admin/articles/${id}/audio`, { method: 'POST', headers: { host: 'localhost:3410', origin: ORIGIN, cookie: writer.cookie }, body: form }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, env: (await res.json()) as Envelope<ListenResponse> };
}

function editParagraph(bodyMd: string, text: string): string {
  expect(bodyMd.includes(text)).toBe(true);
  return bodyMd.replace(text, `${text} Edited, so the words changed.`);
}

beforeEach(async () => {
  await resetDb();
  writer = actAs(await loginAs({ displayName: 'Asha Writer' }));
});

describe('GET /api/admin/articles/:id/listen', () => {
  it('lists the current revision paragraphs in order with status missing and no audio before any upload', async () => {
    const a = await createArticle();
    const state = await listen(a.id);

    expect(state.status).toBe('missing');
    expect(state.audio).toBeNull();
    expect(state.marks).toEqual([]);
    expect(state.timing).toBeNull();
    expect(state.uploadFingerprint).toBeNull();
    expect(state.textChangedSinceUpload).toBe(false);
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
    expect(state).not.toHaveProperty('missingPids');
    expect(state).not.toHaveProperty('orphanPids');
  });

  it('is ready (estimated timing, upload baseline) with the draft recording right after an upload', async () => {
    const a = await createArticle();
    const audio = await seedAudio(a.id);
    const state = await listen(a.id);

    expect(state.status).toBe('ready');
    expect(state.timing).toBe('estimated');
    expect(state.uploadFingerprint).toBe(await paragraphsFingerprint(a.currentRevision.id));
    expect(state.textChangedSinceUpload).toBe(false);
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
    expect(state.syncedAt).toBeNull();
    expect(state.syncedBy).toBeNull();
    expect((await deskChip(a.id, 'listen')).status).toBe('ready');
  });

  it('404s for an unknown article', async () => {
    const res = await call(listenGetRoute, 'GET', `/api/admin/articles/${randomUUID()}/listen`, { id: randomUUID() });
    expect(res.status).toBe(404);
    expect(err(res.env).code).toBe('NOT_FOUND');
  });
});

describe('PUT /api/admin/articles/:id/listen — aligner-facing marks storage', () => {
  it('stores a complete increasing set → 200; status and uploadFingerprint unchanged; timing becomes synced; a second GET returns the same marks', async () => {
    const a = await createArticle();
    await seedAudio(a.id);
    const before = await listen(a.id);
    const fp = await paragraphsFingerprint(a.currentRevision.id);
    const marks = marksFor(before);

    const res = await putMarks(a.id, { revisionId: a.currentRevision.id, marks });
    expect(res.status).toBe(200);
    const saved = data(res.env).listen;
    expect(saved.status).toBe(before.status);
    expect(saved.status).toBe('ready');
    expect(saved.uploadFingerprint).toBe(before.uploadFingerprint);
    expect(saved.timing).toBe('synced');
    expect(saved.marks).toEqual(marks);
    expect(saved.syncFingerprint).toBe(fp);
    expect(saved.syncedBy).toBe('Asha Writer');
    expect(saved.syncedAt).not.toBeNull();
    expect(saved.published).toBeNull();

    const again = await listen(a.id);
    expect(again.marks).toEqual(marks);
    expect(again.status).toBe('ready');

    const row = (await listenRow(a.id))!;
    expect(row.draftFingerprint).toBe(fp); // the upload baseline, untouched by the PUT
    expect(row.draftRevisionId).toBe(a.currentRevision.id);
    const payload = readListenPayload(row.draftPayload)!;
    expect(payload.marks).toEqual(marks);
    expect(payload.uploadFingerprint).toBe(fp);

    expect(await deskChip(a.id, 'listen')).toEqual({ kind: 'listen', status: 'ready', published: false, hasUnpublishedChanges: false });
    expect(await generationRows(a.id)).toBe(0);
  });

  it('a PUT while text_changed stores the marks but keeps status text_changed and the upload baseline', async () => {
    const a = await createArticle();
    await seedAudio(a.id);
    const uploaded = await listen(a.id);
    const saved = await save(a.id, { baseRevisionId: a.currentRevision.id, bodyMd: editParagraph(BODY, uploaded.paragraphs[1].text) });
    const changed = await listen(a.id);
    expect(changed.status).toBe('text_changed');

    const res = await putMarks(a.id, { revisionId: saved.article.currentRevision.id, marks: marksFor(changed) });
    expect(res.status).toBe(200);
    const after = data(res.env).listen;
    expect(after.status).toBe('text_changed');
    expect(after.textChangedSinceUpload).toBe(true);
    expect(after.uploadFingerprint).toBe(uploaded.uploadFingerprint);
    expect(after.syncFingerprint).toBe(await paragraphsFingerprint(saved.article.currentRevision.id));
    expect((await listenRow(a.id))!.draftFingerprint).toBe(uploaded.uploadFingerprint);
  });

  it('refuses every invalid set with 422 MARKS_INVALID listing each reason, and leaves the draft untouched', async () => {
    const a = await createArticle();
    await seedAudio(a.id);
    const state = await listen(a.id);
    const good = marksFor(state);
    const rev = a.currentRevision.id;
    const rowBefore = await listenRow(a.id);

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
    expect(after.status).toBe('ready');
    expect(after.marks).toEqual([]);
    expect(after.timing).toBe('estimated');
    expect(await listenRow(a.id)).toEqual(rowBefore);
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

  it('is ignored by the LLM ledger: storing marks creates no ai_generation row', async () => {
    const a = await createArticle();
    await seedAudio(a.id);
    const state = await listen(a.id);
    await putMarks(a.id, { revisionId: a.currentRevision.id, marks: marksFor(state) });
    expect(await generationRows(a.id)).toBe(0);
  });
});

describe('text_changed warning + publish (Listen never blocks)', () => {
  it('publish copies the uploaded draft (no marks) to the published Listen; readers get estimated marks', async () => {
    const a = await createArticle();
    const audio = await seedAudio(a.id);
    const fp = await paragraphsFingerprint(a.currentRevision.id);

    const res = await publish(a.id, a.currentRevision.id);
    expect(res.status).toBe(200);
    const detail = data(res.env).article;
    expect(detail.status).toBe('published');
    expect(detail.formats.find((f) => f.kind === 'listen')).toEqual({ kind: 'listen', status: 'ready', published: true, hasUnpublishedChanges: false });

    const row = (await listenRow(a.id))!;
    const published = readListenPayload(row.publishedPayload)!;
    expect(published.audio.key).toBe(audio.key);
    expect(published.marks).toEqual([]);
    expect(published.uploadFingerprint).toBe(fp);
    expect(row.publishedFingerprint).toBe(fp);
    expect(row.publishedRevisionId).toBe(a.currentRevision.id);
    expect(row.publishedAt).not.toBeNull();

    const state = await listen(a.id);
    expect(state.published).toEqual({ durationMs: DURATION_MS, publishedAt: row.publishedAt!.toISOString(), sameAudioAsDraft: true });

    const reader = (await getPublishedArticle(a.slug))!;
    expect(reader.listen?.timing).toBe('estimated');
    expect(reader.listen?.marks).toEqual(expectedEstimate(state.paragraphs, DURATION_MS));
    expect(reader.times.listen).toBe(1);
  });

  it('editing one paragraph → text_changed (warning) with the upload baseline kept; publish → 200 and the live Listen is re-estimated over the new text', async () => {
    const a = await createArticle();
    const audio = await seedAudio(a.id);
    await publish(a.id, a.currentRevision.id);
    const uploaded = await listen(a.id);

    const target = uploaded.paragraphs[2];
    const saved = await save(a.id, { baseRevisionId: a.currentRevision.id, bodyMd: editParagraph(BODY, target.text) });
    expect(saved.revisionCreated).toBe(true);

    const changed = await listen(a.id);
    expect(changed.status).toBe('text_changed');
    expect(changed.textChangedSinceUpload).toBe(true);
    expect(changed.uploadFingerprint).toBe(uploaded.uploadFingerprint);
    expect(changed.timing).toBe('estimated');
    const newPid = changed.paragraphs[2].pid;
    expect(newPid).not.toBe(target.pid);
    expect(await deskChip(a.id, 'listen')).toMatchObject({ status: 'text_changed', published: true });

    const res = await publish(a.id, saved.article.currentRevision.id);
    expect(res.status).toBe(200);
    expect(res.env.ok).toBe(true);
    expect(data(res.env).article.formats.find((f) => f.kind === 'listen')).toMatchObject({ status: 'text_changed', published: true });

    const payload = (await publishedPayload(a.id))!;
    expect(payload.audio.key).toBe(audio.key);
    const reader = (await getPublishedArticle(a.slug))!;
    expect(reader.listen?.audioUrl).toBe(`/media/${audio.key}`);
    expect(reader.listen?.timing).toBe('estimated');
    const pids = reader.listen!.marks.map((m) => m.pid);
    expect(pids).toEqual(changed.paragraphs.map((p) => p.pid));
    expect(pids).toContain(newPid);
    expect(pids).not.toContain(target.pid);
    expect(reader.listen?.marks).toEqual(expectedEstimate(changed.paragraphs, DURATION_MS));
    expect(await generationRows(a.id)).toBe(0);
  });

  it('editing only a heading leaves Listen ready; reverting a paragraph edit returns to ready', async () => {
    const a = await createArticle();
    await seedAudio(a.id);
    const headingOnly = await save(a.id, { baseRevisionId: a.currentRevision.id, bodyMd: BODY.replace('## Why decks', '## Why decks matter') });
    expect(headingOnly.revisionCreated).toBe(true);
    expect((await listen(a.id)).status).toBe('ready');
    expect((await publish(a.id, headingOnly.article.currentRevision.id)).status).toBe(200);

    const state = await listen(a.id);
    const edited = await save(a.id, {
      baseRevisionId: headingOnly.article.currentRevision.id,
      bodyMd: editParagraph(BODY.replace('## Why decks', '## Why decks matter'), state.paragraphs[0].text),
    });
    expect((await listen(a.id)).status).toBe('text_changed');
    const reverted = await save(a.id, { baseRevisionId: edited.article.currentRevision.id, bodyMd: BODY.replace('## Why decks', '## Why decks matter') });
    expect(reverted.revisionCreated).toBe(true);
    const back = await listen(a.id);
    expect(back.status).toBe('ready');
    expect(back.textChangedSinceUpload).toBe(false);
  });

  it('legacy payloads (no uploadFingerprint) fall back to syncFingerprint for the warning; a PUT never changes their status', async () => {
    const a = await createArticle();
    const fp = await paragraphsFingerprint(a.currentRevision.id);
    const paragraphs = (await listen(a.id)).paragraphs;
    await seedAudio(a.id, { legacy: { syncFingerprint: fp, marks: paragraphs.map((p, i) => ({ pid: p.pid, tMs: 800 + i * 2_500 })) } });

    const legacy = await listen(a.id);
    expect(legacy.status).toBe('ready');
    expect(legacy.uploadFingerprint).toBe(fp);
    expect(legacy.timing).toBe('synced');

    const saved = await save(a.id, { baseRevisionId: a.currentRevision.id, bodyMd: editParagraph(BODY, paragraphs[3].text) });
    const changed = await listen(a.id);
    expect(changed.status).toBe('text_changed');
    expect(changed.timing).toBe('estimated'); // the stored marks no longer cover the text

    const res = await putMarks(a.id, { revisionId: saved.article.currentRevision.id, marks: marksFor(changed) });
    expect(res.status).toBe(200);
    expect(data(res.env).listen.status).toBe('text_changed');
    expect(data(res.env).listen.uploadFingerprint).toBe(fp);
    expect(data(res.env).listen.timing).toBe('synced');
  });

  it('a new upload after publishing replaces only the draft (sameAudioAsDraft false, unpublished changes); publish then copies it', async () => {
    const a = await createArticle();
    const first = await seedAudio(a.id);
    await publish(a.id, a.currentRevision.id);
    const live = await publishedPayload(a.id);

    const replacement = await seedAudio(a.id, { ext: 'm4a', durationMs: 30_000 });
    const state = await listen(a.id);
    expect(state.status).toBe('ready');
    expect(state.published?.sameAudioAsDraft).toBe(false);
    expect(await deskChip(a.id, 'listen')).toMatchObject({ status: 'ready', published: true, hasUnpublishedChanges: true });
    expect(await publishedPayload(a.id)).toEqual(live);
    expect((await getPublishedArticle(a.slug))?.listen?.audioUrl).toBe(`/media/${first.key}`);

    expect((await publish(a.id, a.currentRevision.id)).status).toBe(200);
    expect((await publishedPayload(a.id))!.audio.key).toBe(replacement.key);
    const reader = (await getPublishedArticle(a.slug))!;
    expect(reader.listen?.durationMs).toBe(30_000);
    expect(reader.listen?.marks).toEqual(expectedEstimate(state.paragraphs, 30_000));
  });

  it('publish with no Listen draft at all clears the published Listen', async () => {
    const a = await createArticle();
    await seedAudio(a.id);
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
    expect((await getPublishedArticle(a.slug))?.listen).toBeNull();
  });

  it('survives a reload: the stored marks and baseline come back from the database on a fresh GET after other writes', async () => {
    const a = await createArticle();
    await seedAudio(a.id);
    const marks = marksFor(await listen(a.id));
    await putMarks(a.id, { revisionId: a.currentRevision.id, marks });
    await save(a.id, { baseRevisionId: a.currentRevision.id, topic: 'Changed topic' });
    const state = await listen(a.id);
    expect(state.status).toBe('ready');
    expect(state.marks).toEqual(marks);
    expect(state.uploadFingerprint).toBe(await paragraphsFingerprint(a.currentRevision.id));
  });
});

describe('through the real audio route: upload ⇒ ready → (aligner PUT) → publish', () => {
  it('uploads as multipart → ready with uploadFingerprint; a text edit then a re-upload re-baselines to ready', async () => {
    resetStorage();
    const a = await createArticle();
    const up = await uploadFile(a.id, 'sample.mp3');
    expect(up.status).toBe(200);
    const uploaded = data(up.env).listen;
    expect(uploaded.status).toBe('ready');
    expect(uploaded.timing).toBe('estimated');
    expect(uploaded.uploadFingerprint).toBe(await paragraphsFingerprint(a.currentRevision.id));
    const row = (await listenRow(a.id))!;
    expect(row.draftFingerprint).toBe(uploaded.uploadFingerprint);
    expect(row.draftRevisionId).toBe(a.currentRevision.id);

    const saved = await save(a.id, { baseRevisionId: a.currentRevision.id, bodyMd: editParagraph(BODY, uploaded.paragraphs[0].text) });
    expect((await listen(a.id)).status).toBe('text_changed');

    const again = await uploadFile(a.id, 'sample.mp3');
    expect(again.status).toBe(200);
    const rebased = data(again.env).listen;
    expect(rebased.status).toBe('ready');
    expect(rebased.uploadFingerprint).toBe(await paragraphsFingerprint(saved.article.currentRevision.id));
    expect(rebased.uploadFingerprint).not.toBe(uploaded.uploadFingerprint);
  });

  it('stores aligner marks against the real recording and publishes them as synced timing', async () => {
    const storageDir = resetStorage();
    const known = JSON.parse(readFileSync(path.join(FIXTURES, 'sample.json'), 'utf8')) as { mp3: { durationMs: number; bytes: number } };
    const a = await createArticle();

    const up = await uploadFile(a.id, 'sample.mp3');
    expect(up.status).toBe(200);
    const uploaded = data(up.env).listen;
    expect(uploaded.audio).toMatchObject({ mimeType: 'audio/mpeg', bytes: known.mp3.bytes, originalFilename: 'sample.mp3', uploadedBy: 'Asha Writer' });
    expect(Math.abs(uploaded.audio!.durationMs - known.mp3.durationMs)).toBeLessThanOrEqual(500);
    expect(uploaded.audio!.url).toBe(`/media/${uploaded.audio!.key}`);
    expect(existsSync(path.join(storageDir, uploaded.audio!.key))).toBe(true);

    // Marks must stay inside the real recording's duration.
    const tooLong = marksFor(uploaded, 500, 5_000);
    const refused = await putMarks(a.id, { revisionId: a.currentRevision.id, marks: tooLong });
    expect(refused.status).toBe(422);
    expect((err(refused.env).details as MarksInvalidDetails).reasons.every((r) => r.code === 'OUT_OF_RANGE')).toBe(true);

    const marks = marksFor(uploaded, 500, 2_500);
    const saved = await putMarks(a.id, { revisionId: a.currentRevision.id, marks });
    expect(saved.status).toBe(200);
    expect(data(saved.env).listen).toMatchObject({ status: 'ready', timing: 'synced', uploadFingerprint: uploaded.uploadFingerprint });

    const published = await publish(a.id, a.currentRevision.id);
    expect(published.status).toBe(200);
    const payload = (await publishedPayload(a.id))!;
    expect(payload.audio.key).toBe(uploaded.audio!.key);
    expect(payload.audio.durationMs).toBe(uploaded.audio!.durationMs);
    expect(payload.marks).toEqual(marks);
    expect((await listen(a.id)).published).toMatchObject({ durationMs: uploaded.audio!.durationMs, sameAudioAsDraft: true });
    const reader = (await getPublishedArticle(a.slug))!;
    expect(reader.listen).toMatchObject({ timing: 'synced', marks });
    expect(await generationRows(a.id)).toBe(0);
  });
});
