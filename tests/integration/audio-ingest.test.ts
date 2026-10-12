// Audio ingest against real blog0_test + real files under var/storage-test
// (spec/capabilities/listen-audio.md → Success Criteria; spec/architecture.md §9.3, §9.5).
//
// Happy paths: m4a + mp3 uploads → ready (no sync step; uploadFingerprint = the
// current paragraphs fingerprint, timing estimated), content-detected mime, duration vs
// sample.json, file + media_asset row + listen draft payload. Edge/error paths: renamed text file, WAV, over-size
// (413, nothing on disk / in the DB), over-length (422 via injected limits), unknown article, no
// file field. Lifecycle: replace (old file + row gone), remove (idempotent), a published Listen
// keeps its file across replace + remove; publish copies the uploaded draft at once and deletes the
// superseded published recording.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DELETE as deleteAudioRoute, POST as uploadRoute } from '@/app/api/admin/articles/[id]/audio/route';
import type { ArticleDetailDto, ListenResponse, ListenStateDto } from '@/lib/api/dto';
import { getConfig, resetConfigForTests } from '@/server/config';
import { getDb } from '@/server/db/client';
import { article as articleTable, articleFormat, articleRevision, mediaAsset, type MediaAssetRow } from '@/server/db/schema';
import { ApiError } from '@/server/http/api';
import { uploadAudio } from '@/server/listen/ingest';
import { getPublishedArticle } from '@/server/public/articles';

import { actAs, call, createArticle as create, data, err, ORIGIN, publish as publishCall } from '../helpers/api';
import { resetDb } from '../helpers/db';
import { captureLogs, type CapturedLogs } from '../helpers/logs';
import { loginAs, type TestLogin } from '../helpers/session';
import { resetStorage } from '../helpers/storage';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'audio');
const known = JSON.parse(readFileSync(path.join(FIXTURES, 'sample.json'), 'utf8')) as Record<'mp3' | 'm4a' | 'wav', { durationMs: number; bytes: number; sha256: string }>;

function fixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURES, name));
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function fileOf(bytes: Buffer | Uint8Array, name: string, type: string): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

let writer: TestLogin;
let storageDir: string;
let logs: CapturedLogs;

function createArticle(body: Record<string, unknown> = {}): Promise<ArticleDetailDto> {
  return create({ title: 'A recorded article', bodyMd: 'First paragraph of the reading.\n\nSecond paragraph of the reading.', ...body });
}

async function upload(id: string, file: File) {
  const form = new FormData();
  form.set('file', file);
  return call<ListenResponse>(uploadRoute, 'POST', `/api/admin/articles/${id}/audio`, { form, id });
}

async function uploadOk(id: string, file: File): Promise<ListenStateDto> {
  const res = await upload(id, file);
  expect(res.status).toBe(200);
  return data(res.env).listen;
}

async function remove(id: string) {
  return call<ListenResponse>(deleteAudioRoute, 'DELETE', `/api/admin/articles/${id}/audio`, { id });
}

async function paragraphsFingerprint(revisionId: string): Promise<string> {
  const [row] = await getDb().select({ fp: articleRevision.paragraphsFingerprint }).from(articleRevision).where(eq(articleRevision.id, revisionId));
  return row.fp;
}

async function publish(id: string, revisionId: string) {
  const res = await publishCall(id, revisionId);
  expect(res.status).toBe(200);
  return data(res.env).article;
}

async function assetRows(): Promise<MediaAssetRow[]> {
  return getDb().select().from(mediaAsset);
}

async function listenRow(articleId: string) {
  const [row] = await getDb()
    .select()
    .from(articleFormat)
    .where(and(eq(articleFormat.articleId, articleId), eq(articleFormat.kind, 'listen')));
  return row ?? null;
}

async function filesUnder(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? e.path, e.name));
}

function onDisk(key: string): string {
  return path.join(storageDir, key);
}

beforeEach(async () => {
  resetConfigForTests();
  storageDir = resetStorage();
  await resetDb();
  writer = actAs(await loginAs());
  logs = captureLogs();
});

afterEach(() => {
  logs.stop();
  delete process.env.BLOG0_MAX_AUDIO_MB;
  resetConfigForTests();
});

describe('POST /api/admin/articles/:id/audio — upload', () => {
  it('stores sample.m4a: ready, audio/mp4, duration vs sample.json, file + row + listen draft', async () => {
    const article = await createArticle();
    const fp = await paragraphsFingerprint(article.currentRevision.id);
    const bytes = fixture('sample.m4a');
    const listen = await uploadOk(article.id, fileOf(bytes, 'reading.m4a', 'audio/mp4'));

    expect(listen.status).toBe('ready');
    expect(listen.uploadFingerprint).toBe(fp);
    expect(listen.timing).toBe('estimated');
    expect(listen.textChangedSinceUpload).toBe(false);
    expect(listen.marks).toEqual([]);
    expect(listen.syncFingerprint).toBeNull();
    expect(listen.audio).not.toBeNull();
    const audio = listen.audio!;
    expect(audio.mimeType).toBe('audio/mp4');
    expect(audio.bytes).toBe(known.m4a.bytes);
    expect(Math.abs(audio.durationMs - known.m4a.durationMs)).toBeLessThanOrEqual(500);
    expect(audio.key).toMatch(/^blog0\/audio\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.m4a$/);
    expect(audio.url).toBe(`/media/${audio.key}`);
    expect(audio.originalFilename).toBe('reading.m4a');
    expect(audio.uploadedBy).toBe(writer.user.displayName);
    expect(listen.limits).toEqual({ maxAudioMb: getConfig().maxAudioMb, maxAudioMinutes: getConfig().maxAudioMinutes });

    // File on disk with the fixture's sha256.
    const stored = readFileSync(onDisk(audio.key));
    expect(stored.byteLength).toBe(known.m4a.bytes);
    expect(sha256(stored)).toBe(known.m4a.sha256);

    // One media_asset row.
    const rows = await assetRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(audio.assetId);
    expect(rows[0].kind).toBe('audio');
    expect(rows[0].storageKey).toBe(audio.key);
    expect(rows[0].mimeType).toBe('audio/mp4');
    expect(rows[0].byteSize).toBe(known.m4a.bytes);
    expect(rows[0].sha256).toBe(known.m4a.sha256);
    expect(Math.round(Number(rows[0].durationSec) * 1000)).toBe(audio.durationMs);
    expect(rows[0].articleId).toBe(article.id);
    expect(rows[0].createdBy).toBe(writer.user.id);

    // Listen draft payload per spec/data.md.
    const row = await listenRow(article.id);
    expect(row).not.toBeNull();
    expect(row!.draftPayload).toEqual({
      audio: { assetId: audio.assetId, key: audio.key, mimeType: 'audio/mp4', bytes: known.m4a.bytes, durationMs: audio.durationMs },
      marks: [],
      syncFingerprint: null,
      uploadFingerprint: fp,
    });
    expect(row!.draftFingerprint).toBe(fp);
    expect(row!.draftRevisionId).toBe(article.currentRevision.id);
    expect(row!.draftUpdatedBy).toBe(writer.user.id);
    expect(row!.publishedPayload).toBeNull();

    const line = logs.find('media.upload');
    expect(line).toHaveLength(1);
    expect(line[0].level).toBe('info');
    expect(line[0]).toMatchObject({
      kind: 'audio',
      mime: 'audio/mp4',
      bytes: known.m4a.bytes,
      duration_ms: audio.durationMs,
      article_id: article.id,
      outcome: 'ok',
      asset_id: audio.assetId,
    });
    expect(line[0]).not.toHaveProperty('mime_type');
    expect(typeof line[0].request_id).toBe('string');
  });

  it('stores sample.mp3 as audio/mpeg under a .mp3 key, detected by content even with a wrong name/type', async () => {
    const article = await createArticle();
    const listen = await uploadOk(article.id, fileOf(fixture('sample.mp3'), 'whatever.bin', 'application/octet-stream'));
    expect(listen.status).toBe('ready');
    expect(listen.timing).toBe('estimated');
    expect(listen.audio!.mimeType).toBe('audio/mpeg');
    expect(listen.audio!.key).toMatch(/\.mp3$/);
    expect(listen.audio!.bytes).toBe(known.mp3.bytes);
    expect(Math.abs(listen.audio!.durationMs - known.mp3.durationMs)).toBeLessThanOrEqual(500);
    expect(sha256(readFileSync(onDisk(listen.audio!.key)))).toBe(known.mp3.sha256);
    const [row] = await assetRows();
    expect(row.mimeType).toBe('audio/mpeg');
    expect(row.originalFilename).toBe('whatever.bin');
  });

  it('refuses a renamed 1-byte text file (song.mp3, audio/mpeg) with 415 and leaves nothing behind', async () => {
    const article = await createArticle();
    const res = await upload(article.id, fileOf(Buffer.from('x'), 'song.mp3', 'audio/mpeg'));
    expect(res.status).toBe(415);
    const e = err(res.env);
    expect(e.code).toBe('UNSUPPORTED_MEDIA');
    expect(e.message).toContain('not an audio file');
    expect(e.message).toContain('mp3 or m4a');
    expect(await assetRows()).toHaveLength(0);
    expect(await listenRow(article.id)).toBeNull();
    expect(await filesUnder(storageDir)).toEqual([]);
  });

  it('refuses not-audio.wav with 415 naming the detected container', async () => {
    const article = await createArticle();
    const res = await upload(article.id, fileOf(fixture('not-audio.wav'), 'not-audio.wav', 'audio/wav'));
    expect(res.status).toBe(415);
    const e = err(res.env);
    expect(e.code).toBe('UNSUPPORTED_MEDIA');
    expect(e.message).toContain('WAVE');
    expect(await assetRows()).toHaveLength(0);
    expect(await filesUnder(storageDir)).toEqual([]);
  });

  it('refuses a file over BLOG0_MAX_AUDIO_MB=1 with 413 — no row, no file', async () => {
    const article = await createArticle();
    process.env.BLOG0_MAX_AUDIO_MB = '1';
    resetConfigForTests();
    expect(getConfig().maxAudioMb).toBe(1);
    const big = new Uint8Array(Math.round(1.1 * 1024 * 1024));
    for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) & 0xff; // not compressible, not an mp3
    const res = await upload(article.id, fileOf(big, 'huge.mp3', 'audio/mpeg'));
    expect(res.status).toBe(413);
    const e = err(res.env);
    expect(e.code).toBe('PAYLOAD_TOO_LARGE');
    expect(e.message).toContain('1 MB');
    expect(await assetRows()).toHaveLength(0);
    expect(await listenRow(article.id)).toBeNull();
    expect(await filesUnder(storageDir)).toEqual([]);
  });

  it('refuses a recording over the injected duration limit with 422 AUDIO_TOO_LONG — no row, no file', async () => {
    const article = await createArticle();
    const file = fileOf(fixture('sample.m4a'), 'sample.m4a', 'audio/mp4');
    const actor = { siteId: writer.user.siteId, user: writer.user };
    let caught: unknown;
    try {
      await uploadAudio(article.id, file, actor, { limits: { maxBytes: 50 * 1024 * 1024, maxDurationMs: 10_000 } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const e = caught as ApiError;
    expect(e.code).toBe('AUDIO_TOO_LONG');
    expect(e.status).toBe(422);
    expect(e.message).toMatch(/0 min 21 s/);
    expect(e.message).toContain('0 minutes'); // the limit, 10 000 ms rounded to whole minutes
    expect(await assetRows()).toHaveLength(0);
    expect(await listenRow(article.id)).toBeNull();
    expect(await filesUnder(storageDir)).toEqual([]);
  });

  it('answers 400 without a file field and 404 for an unknown article', async () => {
    const article = await createArticle();
    const empty = new FormData();
    empty.set('alt', 'nothing');
    const noFile = await call<ListenResponse>(uploadRoute, 'POST', `/api/admin/articles/${article.id}/audio`, { form: empty, id: article.id });
    expect(noFile.status).toBe(400);
    expect(err(noFile.env).code).toBe('VALIDATION_FAILED');

    const missing = await upload('00000000-0000-4000-8000-000000000000', fileOf(fixture('sample.mp3'), 'sample.mp3', 'audio/mpeg'));
    expect(missing.status).toBe(404);
    expect(err(missing.env).code).toBe('NOT_FOUND');
    expect(await filesUnder(storageDir)).toEqual([]);
  });

  it('requires a session and a same-origin request', async () => {
    const article = await createArticle();
    const form = new FormData();
    form.set('file', fileOf(fixture('sample.mp3'), 'sample.mp3', 'audio/mpeg'));
    const anon = await uploadRoute(new Request(`${ORIGIN}/api/admin/articles/${article.id}/audio`, { method: 'POST', headers: { host: 'localhost:3410', origin: ORIGIN }, body: form }), {
      params: Promise.resolve({ id: article.id }),
    });
    expect(anon.status).toBe(401);
    const form2 = new FormData();
    form2.set('file', fileOf(fixture('sample.mp3'), 'sample.mp3', 'audio/mpeg'));
    const crossOrigin = await uploadRoute(
      new Request(`${ORIGIN}/api/admin/articles/${article.id}/audio`, { method: 'POST', headers: { host: 'localhost:3410', origin: 'https://evil.example', cookie: writer.cookie }, body: form2 }),
      { params: Promise.resolve({ id: article.id }) },
    );
    expect(crossOrigin.status).toBe(403);
  });
});

describe('replace and remove', () => {
  it('a second upload replaces the asset, clears stored marks, re-baselines, and deletes the first (unpublished) file + row', async () => {
    const article = await createArticle();
    const first = await uploadOk(article.id, fileOf(fixture('sample.m4a'), 'take-1.m4a', 'audio/mp4'));
    // Simulate stored (aligner) marks + an old baseline on the draft (cleared / re-set by the replace).
    const draft = (await listenRow(article.id))!.draftPayload as { audio: object };
    await getDb()
      .update(articleFormat)
      .set({ draftPayload: { ...draft, marks: [{ pid: 'p1', tMs: 0 }], syncFingerprint: 'fp', uploadFingerprint: 'fp-old' }, draftFingerprint: 'fp-old' })
      .where(eq(articleFormat.articleId, article.id));

    const second = await uploadOk(article.id, fileOf(fixture('sample.mp3'), 'take-2.mp3', 'audio/mpeg'));
    expect(second.audio!.assetId).not.toBe(first.audio!.assetId);
    expect(second.audio!.key).not.toBe(first.audio!.key);
    expect(second.audio!.mimeType).toBe('audio/mpeg');
    expect(second.marks).toEqual([]);
    expect(second.status).toBe('ready');
    expect(second.syncFingerprint).toBeNull();
    expect(second.uploadFingerprint).toBe(await paragraphsFingerprint(article.currentRevision.id));

    expect(existsSync(onDisk(first.audio!.key))).toBe(false);
    expect(existsSync(onDisk(second.audio!.key))).toBe(true);
    const rows = await assetRows();
    expect(rows.map((r) => r.id)).toEqual([second.audio!.assetId]);
    const row = await listenRow(article.id);
    expect((row!.draftPayload as { audio: { key: string }; marks: unknown[] }).audio.key).toBe(second.audio!.key);
    expect((row!.draftPayload as { marks: unknown[] }).marks).toEqual([]);
    expect(logs.find('media.upload')[1]).toMatchObject({ replaced_asset_id: first.audio!.assetId });
  });

  it('DELETE removes the draft: status missing, audio null, file + row deleted; a second DELETE is a no-op 200', async () => {
    const article = await createArticle();
    const uploaded = await uploadOk(article.id, fileOf(fixture('sample.mp3'), 'sample.mp3', 'audio/mpeg'));
    expect(existsSync(onDisk(uploaded.audio!.key))).toBe(true);

    const res = await remove(article.id);
    expect(res.status).toBe(200);
    const listen = data(res.env).listen;
    expect(listen.status).toBe('missing');
    expect(listen.audio).toBeNull();
    expect(listen.marks).toEqual([]);
    expect(existsSync(onDisk(uploaded.audio!.key))).toBe(false);
    expect(await assetRows()).toHaveLength(0);
    const row = await listenRow(article.id);
    expect(row).not.toBeNull(); // row kept, payload null
    expect(row!.draftPayload).toBeNull();
    expect(row!.draftFingerprint).toBeNull();
    expect(logs.find('media.remove')).toHaveLength(1);

    const again = await remove(article.id);
    expect(again.status).toBe(200);
    expect(data(again.env).listen.status).toBe('missing');
    expect(logs.find('media.remove')).toHaveLength(1);

    // Removing on an article that never had audio is also a 200 (no row is created).
    const fresh = await createArticle({ title: 'Never recorded' });
    const never = await remove(fresh.id);
    expect(never.status).toBe(200);
    expect(data(never.env).listen.status).toBe('missing');
    expect(await listenRow(fresh.id)).toBeNull();

    const unknown = await remove('00000000-0000-4000-8000-000000000000');
    expect(unknown.status).toBe(404);
  });

  it('a published Listen keeps its file + row across replace and remove (only the unpublished draft is collected)', async () => {
    const article = await createArticle();
    const published = await uploadOk(article.id, fileOf(fixture('sample.m4a'), 'published.m4a', 'audio/mp4'));
    const draftRow = (await listenRow(article.id))!;
    // Stand in for the adapter publish: copy the (synced) draft into the published columns.
    const payload = { ...(draftRow.draftPayload as { audio: object }), marks: [{ pid: 'p1', tMs: 0 }, { pid: 'p2', tMs: 9000 }], syncFingerprint: 'fp-published' };
    await getDb()
      .update(articleFormat)
      .set({ draftPayload: payload, draftFingerprint: 'fp-published', publishedPayload: payload, publishedFingerprint: 'fp-published', publishedAt: new Date() })
      .where(eq(articleFormat.id, draftRow.id));

    // Replace: the published key is still referenced → its file + row stay.
    const replaced = await uploadOk(article.id, fileOf(fixture('sample.mp3'), 'retake.mp3', 'audio/mpeg'));
    expect(replaced.audio!.assetId).not.toBe(published.audio!.assetId);
    expect(existsSync(onDisk(published.audio!.key))).toBe(true);
    expect(existsSync(onDisk(replaced.audio!.key))).toBe(true);
    expect((await assetRows()).map((r) => r.id).sort()).toEqual([published.audio!.assetId, replaced.audio!.assetId].sort());
    let row = (await listenRow(article.id))!;
    expect(row.publishedPayload).toEqual(payload);
    expect((row.publishedPayload as { audio: { durationMs: number } }).audio.durationMs).toBe(published.audio!.durationMs);
    expect(replaced.published).toMatchObject({ durationMs: published.audio!.durationMs, sameAudioAsDraft: false });

    // Remove: the retake goes, the published recording stays.
    const removed = data((await remove(article.id)).env).listen;
    expect(removed.status).toBe('missing');
    expect(removed.audio).toBeNull();
    expect(existsSync(onDisk(replaced.audio!.key))).toBe(false);
    expect(existsSync(onDisk(published.audio!.key))).toBe(true);
    expect((await assetRows()).map((r) => r.id)).toEqual([published.audio!.assetId]);
    row = (await listenRow(article.id))!;
    expect(row.draftPayload).toBeNull();
    expect(row.publishedPayload).toEqual(payload);

    // Re-uploading the very same recording bytes still gets a fresh key (caches never see a new body under an old URL).
    const again = await uploadOk(article.id, fileOf(fixture('sample.m4a'), 'published.m4a', 'audio/mp4'));
    expect(again.audio!.key).not.toBe(published.audio!.key);
    expect(again.audio!.assetId).not.toBe(published.audio!.assetId);
    expect(existsSync(onDisk(published.audio!.key))).toBe(true);
  });
});

describe('media.upload log — rejected uploads (spec/architecture.md §7)', () => {
  it('415 (renamed text file) logs one rejected line with err_code and no asset', async () => {
    const article = await createArticle();
    const res = await upload(article.id, fileOf(Buffer.from('x'), 'song.mp3', 'audio/mpeg'));
    expect(res.status).toBe(415);
    const lines = logs.find('media.upload');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'audio', outcome: 'rejected', err_code: 'UNSUPPORTED_MEDIA', bytes: 1, article_id: article.id });
    expect(lines[0]).not.toHaveProperty('mime_type');
    expect(lines[0]).not.toHaveProperty('asset_id');
  });

  it('413 (over the byte limit inside the handler) and 422 (over the duration limit, mime known) log rejected lines', async () => {
    const article = await createArticle();
    const actor = { siteId: writer.user.siteId, user: writer.user };
    const file = fileOf(fixture('sample.m4a'), 'sample.m4a', 'audio/mp4');

    await expect(uploadAudio(article.id, file, actor, { requestId: 'req-413', limits: { maxBytes: 1024, maxDurationMs: 600_000 } })).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      status: 413,
    });
    await expect(uploadAudio(article.id, file, actor, { requestId: 'req-422', limits: { maxBytes: 50 * 1024 * 1024, maxDurationMs: 10_000 } })).rejects.toMatchObject({
      code: 'AUDIO_TOO_LONG',
      status: 422,
    });

    const lines = logs.find('media.upload');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ request_id: 'req-413', kind: 'audio', outcome: 'rejected', err_code: 'PAYLOAD_TOO_LARGE', bytes: known.m4a.bytes });
    expect(lines[0].mime).toBeUndefined(); // refused before the probe
    expect(lines[1]).toMatchObject({ request_id: 'req-422', kind: 'audio', outcome: 'rejected', err_code: 'AUDIO_TOO_LONG', mime: 'audio/mp4' });
    expect(await assetRows()).toHaveLength(0);
    expect(await filesUnder(storageDir)).toEqual([]);
  });

  it('a 404 (unknown article) is not an upload rejection: no media.upload line', async () => {
    const res = await upload('00000000-0000-4000-8000-000000000000', fileOf(fixture('sample.mp3'), 'sample.mp3', 'audio/mpeg'));
    expect(res.status).toBe(404);
    expect(logs.find('media.upload')).toHaveLength(0);
  });
});

describe('publish deletes the superseded published recording (listen-audio file lifecycle)', () => {
  async function publishedWithListen() {
    const article = await createArticle({ topic: 'Craft' });
    const first = await uploadOk(article.id, fileOf(fixture('sample.m4a'), 'first.m4a', 'audio/mp4'));
    expect(first.status).toBe('ready');
    await publish(article.id, article.currentRevision.id); // no sync step: the uploaded draft publishes as is
    const row = (await listenRow(article.id))!;
    expect((row.publishedPayload as { audio: { key: string } }).audio.key).toBe(first.audio!.key);
    return { article, first };
  }

  it('replace + publish: the old published file and row are deleted, the new one serves', async () => {
    const { article, first } = await publishedWithListen();

    // Replace: the published recording stays (and keeps serving) while the draft moves on.
    const second = await uploadOk(article.id, fileOf(fixture('sample.mp3'), 'second.mp3', 'audio/mpeg'));
    expect(second.status).toBe('ready');
    expect(existsSync(onDisk(first.audio!.key))).toBe(true);
    expect(second.published).toMatchObject({ durationMs: first.audio!.durationMs, sameAudioAsDraft: false });
    expect((await assetRows()).map((r) => r.id).sort()).toEqual([first.audio!.assetId, second.audio!.assetId].sort());
    expect((await getPublishedArticle(article.slug))!.listen!.audioUrl).toBe(`/media/${first.audio!.key}`);

    logs.lines.length = 0;
    const published = await publish(article.id, article.currentRevision.id);
    expect(published.status).toBe('published');

    expect(existsSync(onDisk(first.audio!.key))).toBe(false);
    expect(existsSync(onDisk(second.audio!.key))).toBe(true);
    expect((await assetRows()).map((r) => r.id)).toEqual([second.audio!.assetId]);
    const row = (await listenRow(article.id))!;
    expect((row.publishedPayload as { audio: { key: string } }).audio.key).toBe(second.audio!.key);
    expect((row.draftPayload as { audio: { key: string } }).audio.key).toBe(second.audio!.key);
    expect(logs.find('media.remove')).toEqual([expect.objectContaining({ asset_id: first.audio!.assetId, key: first.audio!.key, article_id: article.id })]);

    // Re-publishing the same recording deletes nothing.
    await publish(article.id, article.currentRevision.id);
    expect(existsSync(onDisk(second.audio!.key))).toBe(true);
    expect(await assetRows()).toHaveLength(1);
  });

  it('remove + publish clears the published Listen: times.listen null on /p/<slug> and the old file + row deleted', async () => {
    const { article, first } = await publishedWithListen();
    const before = await getPublishedArticle(article.slug);
    expect(before!.times.listen).not.toBeNull();

    await remove(article.id);
    expect(existsSync(onDisk(first.audio!.key))).toBe(true); // still published
    expect((await getPublishedArticle(article.slug))!.times.listen).not.toBeNull();

    await publish(article.id, article.currentRevision.id);
    expect((await getPublishedArticle(article.slug))!.times.listen).toBeNull();
    expect(existsSync(onDisk(first.audio!.key))).toBe(false);
    expect(await assetRows()).toHaveLength(0);
    const row = (await listenRow(article.id))!;
    expect(row.publishedPayload).toBeNull();
    expect(row.draftPayload).toBeNull();
  });

  it('a blocked publish (rolled back) deletes nothing', async () => {
    const { article, first } = await publishedWithListen();
    const second = await uploadOk(article.id, fileOf(fixture('sample.mp3'), 'second.mp3', 'audio/mpeg'));
    // Clearing the topic makes the publish fail its guard → the transaction rolls back.
    await getDb().update(articleTable).set({ topic: '' }).where(eq(articleTable.id, article.id));
    const res = await publishCall(article.id, article.currentRevision.id);
    expect(res.status).toBe(422);
    expect(existsSync(onDisk(first.audio!.key))).toBe(true);
    expect((await assetRows()).map((r) => r.id).sort()).toEqual([first.audio!.assetId, second.audio!.assetId].sort());
  });
});
