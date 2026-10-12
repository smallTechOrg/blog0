// Media (S3.1) against real blog0_test + real files under var/storage-test: the storage
// interface (atomic put, size cap, traversal refusal), image upload (png/jpg/webp/gif, SVG 415,
// content wins over extension, 413/400/404), the /media/[...key] route (200/206/304/416/404/405,
// headers, If-Range, HEAD), cleanup, log lines — and one designer-mode (PGlite) upload → stream.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as uploadImageRoute } from '@/app/api/admin/uploads/images/route';
import { DELETE as mediaDelete, GET as mediaGet, HEAD as mediaHead, POST as mediaPost } from '@/app/media/[...key]/route';
import type { Envelope, Err } from '@/lib/api/envelope';
import { createArticle, type ActorContext } from '@/server/articles/service';
import { resetConfigForTests } from '@/server/config';
import { closeDb, getDb, initDb, resetDbForTests } from '@/server/db/client';
import { runMigrations } from '@/server/db/migrate';
import { articleFormat, mediaAsset } from '@/server/db/schema';
import { ApiError, MULTIPART_OVERHEAD_BYTES, precheckContentLength } from '@/server/http/api';
import { deleteAssetIfUnreferenced, isStorageKeyReferenced } from '@/server/media/cleanup';
import { cleanOriginalFilename } from '@/server/media/ingest';
import { probeImage } from '@/server/media/image-probe';
import { resetLlmClientForTests } from '@/server/llm';
import { resetLoggerForTests } from '@/server/log';
import { seedSite } from '@/server/seed/site';
import { resetCurrentSiteForTests } from '@/server/site/current';
import { getStorage, LocalDiskStorage, resetStorageForTests, StorageError } from '@/server/storage';

import { resetDb } from '../helpers/db';
import { captureLogs } from '../helpers/logs';
import { loginAs, type TestLogin } from '../helpers/session';
import { resetStorage, testStorageDir } from '../helpers/storage';

const ORIGIN = 'http://localhost:3410';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'images');
type Manifest = Record<string, { type: string; mime: string | null; width: number; height: number; bytes: number }>;
const MANIFEST = JSON.parse(readFileSync(path.join(FIXTURES, 'sample.json'), 'utf8')) as Manifest;
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function fixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURES, name));
}

interface UploadOpts {
  cookie?: string | null;
  origin?: string | null;
  fields?: Record<string, string>;
  file?: { buffer: Buffer; name: string; type?: string } | null;
  headers?: Record<string, string>;
}

interface ImageUploadData {
  asset: { id: string; key: string; url: string; mimeType: string; bytes: number; width: number; height: number };
  markdown: string;
}

async function upload(opts: UploadOpts): Promise<{ status: number; env: Envelope<ImageUploadData>; res: Response }> {
  const form = new FormData();
  if (opts.file !== null) {
    const f = opts.file ?? { buffer: fixture('sample.png'), name: 'sample.png', type: 'image/png' };
    form.set('file', new File([new Uint8Array(f.buffer)], f.name, { type: f.type ?? 'application/octet-stream' }));
  }
  for (const [k, v] of Object.entries(opts.fields ?? {})) form.set(k, v);
  const headers: Record<string, string> = { host: 'localhost:3410', ...(opts.headers ?? {}) };
  if (opts.cookie !== null) headers.cookie = opts.cookie ?? writer.cookie;
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  const request = new Request(`${ORIGIN}/api/admin/uploads/images`, { method: 'POST', headers, body: form });
  const res = await uploadImageRoute(request, { params: Promise.resolve({}) });
  return { status: res.status, env: (await res.json()) as Envelope<ImageUploadData>, res };
}

function data<T>(env: Envelope<T>): T {
  if (!env.ok) throw new Error(`expected ok envelope, got ${env.error.code}: ${env.error.message}`);
  return env.data;
}

function err(env: Envelope<unknown>): Err['error'] {
  if (env.ok) throw new Error('expected an error envelope');
  return env.error;
}

type MediaHandler = (request: Request, ctx: { params: Promise<{ key?: string | string[] }> }) => Promise<Response>;

async function media(handler: MediaHandler, key: string | string[], headers: Record<string, string> = {}): Promise<Response> {
  const segments = Array.isArray(key) ? key : key.split('/');
  const request = new Request(`${ORIGIN}/media/${segments.map(encodeURIComponent).join('/')}`, {
    method: handler === mediaHead ? 'HEAD' : handler === mediaGet ? 'GET' : 'POST',
    headers,
  });
  return handler(request, { params: Promise.resolve({ key: segments }) });
}

async function uploadPng(fields: Record<string, string> = {}): Promise<ImageUploadData> {
  const { status, env } = await upload({ fields });
  expect(status).toBe(201);
  return data(env);
}

function diskPath(key: string): string {
  return path.join(testStorageDir(), key);
}

let writer: TestLogin;

beforeEach(async () => {
  await resetDb();
  resetStorage();
  writer = await loginAs();
});

// ---------------------------------------------------------------------------------------------

describe('LocalDiskStorage', () => {
  const key = `blog0/image/2026/10/${UUID}.png`;

  it('put writes atomically (no temp files left), returns size + sha256, get/stat/stream/delete round-trip', async () => {
    const storage = getStorage();
    const bytes = fixture('sample.png');
    const stored = await storage.put(key, bytes, { maxBytes: bytes.length });

    expect(stored).toEqual({ key, size: bytes.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(readdirSync(path.dirname(diskPath(key)))).toEqual([`${UUID}.png`]);
    expect(readFileSync(diskPath(key)).equals(bytes)).toBe(true);
    expect((await storage.get(key))!.equals(bytes)).toBe(true);
    expect(await storage.stat(key)).toEqual({ size: bytes.length, mtime: expect.any(Date) });

    const whole = await storage.stream(key);
    expect(whole.size).toBe(bytes.length);
    expect(whole.range).toBeNull();
    expect(Buffer.from(await new Response(whole.stream).arrayBuffer()).equals(bytes)).toBe(true);

    const part = await storage.stream(key, { start: 1, end: 3 });
    expect(part.range).toEqual({ start: 1, end: 3 });
    expect(Buffer.from(await new Response(part.stream).arrayBuffer())).toEqual(bytes.subarray(1, 4));

    await storage.delete(key);
    await storage.delete(key); // idempotent
    expect(await storage.get(key)).toBeNull();
    expect(await storage.stat(key)).toBeNull();
    expect(existsSync(diskPath(key))).toBe(false);
  });

  it('put over maxBytes → TOO_LARGE and nothing on disk (Buffer and stream bodies)', async () => {
    const storage = getStorage();
    const bytes = fixture('sample.png');
    await expect(storage.put(key, bytes, { maxBytes: bytes.length - 1 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    const stream = new Response(new Uint8Array(bytes)).body!;
    await expect(storage.put(key, stream, { maxBytes: 1000 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(existsSync(path.dirname(diskPath(key))) ? readdirSync(path.dirname(diskPath(key))) : []).toEqual([]);
  });

  it('accepts a streamed body exactly at the limit', async () => {
    const storage = getStorage();
    const bytes = fixture('sample.jpg');
    const stream = new Response(new Uint8Array(bytes)).body!;
    const stored = await storage.put(key.replace(/png$/, 'jpg'), stream, { maxBytes: bytes.length });
    expect(stored.size).toBe(bytes.length);
  });

  it('refuses invalid keys on every method without touching the disk (BAD_KEY)', async () => {
    const storage = new LocalDiskStorage(testStorageDir());
    for (const bad of ['../../etc/passwd', `/${key}`, `blog0/image/2026/10/../${UUID}.png`, 'blog0/image/2026/10/x.png', '']) {
      await expect(storage.put(bad, Buffer.from('x'), { maxBytes: 10 })).rejects.toMatchObject({ code: 'BAD_KEY' });
      await expect(storage.get(bad)).rejects.toMatchObject({ code: 'BAD_KEY' });
      await expect(storage.stat(bad)).rejects.toMatchObject({ code: 'BAD_KEY' });
      await expect(storage.delete(bad)).rejects.toMatchObject({ code: 'BAD_KEY' });
      await expect(storage.stream(bad)).rejects.toMatchObject({ code: 'BAD_KEY' });
    }
    expect(existsSync(testStorageDir())).toBe(false);
  });

  it('stream: NOT_FOUND for a missing key, BAD_RANGE outside the object', async () => {
    const storage = getStorage();
    await expect(storage.stream(key)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await storage.put(key, Buffer.from('hello'), { maxBytes: 10 });
    await expect(storage.stream(key, { start: 0, end: 5 })).rejects.toMatchObject({ code: 'BAD_RANGE' });
    await expect(storage.stream(key, { start: 3, end: 2 })).rejects.toMatchObject({ code: 'BAD_RANGE' });
    await expect(storage.stream(key, { start: -1, end: 2 })).rejects.toMatchObject({ code: 'BAD_RANGE' });
    const err = await storage.stream(key, { start: 5, end: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
  });
});

// ---------------------------------------------------------------------------------------------

describe('POST /api/admin/uploads/images', () => {
  it('stores sample.png: 201 ImageUploadResponse with the fixture dimensions, a media_asset row, the file on disk', async () => {
    const logs = captureLogs();
    const article = await createArticle({ siteId: writer.user.siteId, user: writer.user } as ActorContext, { title: 'With image', topic: 'Images' });
    const { status, env, res } = await upload({ fields: { alt: 'sample', articleId: article.id } });
    logs.stop();

    expect(status).toBe(201);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const body = data(env);
    const known = MANIFEST['sample.png'];
    expect(body.asset).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      key: expect.stringMatching(/^blog0\/image\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/),
      url: `/media/${body.asset.key}`,
      mimeType: 'image/png',
      bytes: known.bytes,
      width: known.width,
      height: known.height,
    });
    expect(body.markdown).toBe(`![sample](/media/${body.asset.key})`);

    const [row] = await getDb().select().from(mediaAsset).where(eq(mediaAsset.id, body.asset.id));
    expect(row).toMatchObject({
      siteId: writer.user.siteId,
      kind: 'image',
      storageKey: body.asset.key,
      originalFilename: 'sample.png',
      mimeType: 'image/png',
      byteSize: known.bytes,
      width: known.width,
      height: known.height,
      durationSec: null,
      articleId: article.id,
      createdBy: writer.user.id,
    });
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(diskPath(body.asset.key)).size).toBe(known.bytes);

    const uploadLine = logs.find('media.upload');
    expect(uploadLine).toHaveLength(1);
    expect(uploadLine[0]).toMatchObject({ kind: 'image', mime: 'image/png', bytes: known.bytes, width: 320, height: 200, article_id: article.id, outcome: 'ok' });
    expect(uploadLine[0].request_id).toBe(res.headers.get('x-request-id'));
    expect(logs.find('api.request')[0]).toMatchObject({ status: 201, path: '/api/admin/uploads/images' });
  });

  it.each([
    ['sample.jpg', 'image/jpeg', 'jpg'],
    ['sample.webp', 'image/webp', 'webp'],
    ['tiny.gif', 'image/gif', 'gif'],
  ])('%s → 201 as %s with a key ending .%s', async (name, mime, ext) => {
    const { status, env } = await upload({ file: { buffer: fixture(name), name, type: 'application/octet-stream' }, fields: { alt: 'x' } });
    expect(status).toBe(201);
    const body = data(env);
    expect(body.asset.mimeType).toBe(mime);
    expect(body.asset.key.endsWith(`.${ext}`)).toBe(true);
    expect(body.asset.width).toBe(MANIFEST[name].width);
    expect(body.asset.height).toBe(MANIFEST[name].height);
    expect(body.asset.bytes).toBe(MANIFEST[name].bytes);
  });

  it('caption → markdown with a quoted title (quotes escaped); alt defaults to empty', async () => {
    const withCaption = await uploadPng({ caption: 'A "quoted" caption' });
    expect(withCaption.markdown).toBe(`![](/media/${withCaption.asset.key} "A \\"quoted\\" caption")`);
    const blankCaption = await uploadPng({ alt: 'a', caption: '   ' });
    expect(blankCaption.markdown).toBe(`![a](/media/${blankCaption.asset.key})`);
  });

  it('sample.svg → 415 UNSUPPORTED_MEDIA naming SVG; no row, no file', async () => {
    const logs = captureLogs();
    const { status, env } = await upload({ file: { buffer: fixture('sample.svg'), name: 'sample.svg', type: 'image/svg+xml' } });
    logs.stop();
    expect(status).toBe(415);
    expect(err(env).code).toBe('UNSUPPORTED_MEDIA');
    expect(err(env).message).toMatch(/SVG/);
    expect(await getDb().select().from(mediaAsset)).toEqual([]);
    expect(existsSync(testStorageDir())).toBe(false);
    expect(logs.find('media.upload')[0]).toMatchObject({ kind: 'image', outcome: 'rejected', err_code: 'UNSUPPORTED_MEDIA' });
  });

  it('content wins over the name and the declared type: a PNG named .svg → 201 image/png; text named .png → 415', async () => {
    const renamed = await upload({ file: { buffer: fixture('sample.png'), name: 'sneaky.svg', type: 'image/svg+xml' } });
    expect(renamed.status).toBe(201);
    expect(data(renamed.env).asset.mimeType).toBe('image/png');
    expect(data(renamed.env).asset.key.endsWith('.png')).toBe(true);

    const text = await upload({ file: { buffer: Buffer.from('definitely not an image\n'), name: 'fake.png', type: 'image/png' } });
    expect(text.status).toBe(415);
    expect(err(text.env).code).toBe('UNSUPPORTED_MEDIA');
  });

  it('a 9 MB file with the default 8 MB limit → 413 PAYLOAD_TOO_LARGE; no row, no file', async () => {
    const big = Buffer.concat([fixture('sample.png'), Buffer.alloc(9 * 1024 * 1024)]);
    const { status, env } = await upload({ file: { buffer: big, name: 'big.png', type: 'image/png' } });
    expect(status).toBe(413);
    expect(err(env).code).toBe('PAYLOAD_TOO_LARGE');
    expect(err(env).message).toMatch(/8 MB/);
    expect(await getDb().select().from(mediaAsset)).toEqual([]);
    expect(existsSync(testStorageDir())).toBe(false);
  });

  it('declared Content-Length over the limit + 64 KiB → 413 before the body is read', async () => {
    const limit = 8 * 1024 * 1024;
    const request = new Request(`${ORIGIN}/api/admin/uploads/images`, {
      method: 'POST',
      headers: { host: 'localhost:3410', origin: ORIGIN, cookie: writer.cookie, 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(limit + MULTIPART_OVERHEAD_BYTES + 1) },
      body: '--x--\r\n',
      // @ts-expect-error -- undici option for a streaming request body
      duplex: 'half',
    });
    const res = await uploadImageRoute(request, { params: Promise.resolve({}) });
    const env = (await res.json()) as Envelope<unknown>;
    expect(res.status).toBe(413);
    expect(err(env).code).toBe('PAYLOAD_TOO_LARGE');

    expect(() => precheckContentLength(new Request(ORIGIN, { headers: { 'content-length': String(limit + MULTIPART_OVERHEAD_BYTES) } }), limit)).not.toThrow();
    expect(() => precheckContentLength(new Request(ORIGIN, { headers: { 'content-length': String(limit + MULTIPART_OVERHEAD_BYTES + 1) } }), limit)).toThrow(ApiError);
    expect(() => precheckContentLength(new Request(ORIGIN), limit)).not.toThrow();
  });

  it('validation: alt of 201 chars → 400; missing file → 400; empty file → 400; unknown articleId → 404', async () => {
    const longAlt = await upload({ fields: { alt: 'a'.repeat(201) } });
    expect(longAlt.status).toBe(400);
    expect(err(longAlt.env).code).toBe('VALIDATION_FAILED');

    const noFile = await upload({ file: null, fields: { alt: 'x' } });
    expect(noFile.status).toBe(400);
    expect(err(noFile.env).code).toBe('VALIDATION_FAILED');

    const empty = await upload({ file: { buffer: Buffer.alloc(0), name: 'empty.png' } });
    expect(empty.status).toBe(400);

    const badArticle = await upload({ fields: { articleId: UUID } });
    expect(badArticle.status).toBe(404);
    expect(err(badArticle.env).code).toBe('NOT_FOUND');

    const malformedArticle = await upload({ fields: { articleId: 'not-a-uuid' } });
    expect(malformedArticle.status).toBe(404);
    expect(await getDb().select().from(mediaAsset)).toEqual([]);
  });

  it('non-multipart body → 400; no session → 401; cross-origin → 403', async () => {
    const json = new Request(`${ORIGIN}/api/admin/uploads/images`, {
      method: 'POST',
      headers: { host: 'localhost:3410', origin: ORIGIN, cookie: writer.cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    const jsonRes = await uploadImageRoute(json, { params: Promise.resolve({}) });
    expect(jsonRes.status).toBe(400);

    const anon = await upload({ cookie: null });
    expect(anon.status).toBe(401);
    expect(err(anon.env).code).toBe('UNAUTHENTICATED');

    const cross = await upload({ origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
    expect(err(cross.env).code).toBe('FORBIDDEN_ORIGIN');
  });

  it('original filename is stored as a cleaned basename', async () => {
    const { env } = await upload({ file: { buffer: fixture('sample.png'), name: '../dir/My Photo\u0007.PNG' } });
    const [row] = await getDb().select().from(mediaAsset).where(eq(mediaAsset.id, data(env).asset.id));
    expect(row.originalFilename).toBe('My Photo.PNG');
    expect(cleanOriginalFilename('')).toBe('upload');
    expect(cleanOriginalFilename('..')).toBe('upload');
    expect(cleanOriginalFilename(`${'x'.repeat(300)}.png`)).toHaveLength(255);
  });

  it('probeImage rejects oversized dimensions with 422 IMAGE_TOO_LARGE (synthetic 13000×1 PNG header)', () => {
    const png = Buffer.from(fixture('sample.png'));
    png.writeUInt32BE(13_000, 16); // IHDR width (the probe reads the header only)
    const error = (() => {
      try {
        probeImage(png);
        return null;
      } catch (e) {
        return e as ApiError;
      }
    })();
    expect(error).toBeInstanceOf(ApiError);
    expect(error!.code).toBe('IMAGE_TOO_LARGE');
    expect(error!.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------------------------

describe('GET / HEAD /media/[...key]', () => {
  it('200 with the stored bytes and every contract header; HEAD carries the headers and no body', async () => {
    const logs = captureLogs();
    const { asset } = await uploadPng({ alt: 'x' });
    const res = await media(mediaGet, asset.key);
    logs.stop();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-length')).toBe(String(MANIFEST['sample.png'].bytes));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
    expect(res.headers.get('last-modified')).toMatch(/GMT$/);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="sample.png"');
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(Buffer.from(await res.arrayBuffer()).equals(fixture('sample.png'))).toBe(true);

    const line = logs.find('media.request');
    expect(line).toHaveLength(1);
    expect(line[0]).toMatchObject({ key: asset.key, status: 200, bytes_sent: MANIFEST['sample.png'].bytes });
    expect(line[0].request_id).toBe(res.headers.get('x-request-id'));
    expect(typeof line[0].latency_ms).toBe('number');

    const head = await media(mediaHead, asset.key);
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(MANIFEST['sample.png'].bytes));
    expect(head.headers.get('etag')).toBe(res.headers.get('etag'));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it('206 for bytes=a-b, bytes=a-, bytes=-n with Content-Range; the bytes match the file', async () => {
    const { asset } = await uploadPng();
    const file = fixture('sample.png');
    const size = file.length;

    const first = await media(mediaGet, asset.key, { range: 'bytes=0-1' });
    expect(first.status).toBe(206);
    expect(first.headers.get('content-range')).toBe(`bytes 0-1/${size}`);
    expect(first.headers.get('content-length')).toBe('2');
    expect(Buffer.from(await first.arrayBuffer())).toEqual(file.subarray(0, 2));

    const tail = await media(mediaGet, asset.key, { range: `bytes=${size - 10}-` });
    expect(tail.status).toBe(206);
    expect(tail.headers.get('content-range')).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(file.subarray(size - 10));

    const suffix = await media(mediaGet, asset.key, { range: 'bytes=-7' });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('content-range')).toBe(`bytes ${size - 7}-${size - 1}/${size}`);
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(file.subarray(size - 7));

    const clamped = await media(mediaGet, asset.key, { range: 'bytes=10-999999999' });
    expect(clamped.status).toBe(206);
    expect(clamped.headers.get('content-range')).toBe(`bytes 10-${size - 1}/${size}`);

    const headRange = await media(mediaHead, asset.key, { range: 'bytes=0-1' });
    expect(headRange.status).toBe(206);
    expect(headRange.headers.get('content-length')).toBe('2');
    expect((await headRange.arrayBuffer()).byteLength).toBe(0);
  });

  it('416 with Content-Range: bytes */size and an empty body when the range starts past the end', async () => {
    const logs = captureLogs();
    const { asset } = await uploadPng();
    const size = MANIFEST['sample.png'].bytes;
    const res = await media(mediaGet, asset.key, { range: `bytes=${size}-` });
    logs.stop();
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${size}`);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    expect(logs.find('media.request')[0]).toMatchObject({ status: 416, range: `bytes=${size}-`, bytes_sent: 0 });

    const zero = await media(mediaGet, asset.key, { range: 'bytes=-0' });
    expect(zero.status).toBe(416);
  });

  it('malformed / multi-range / other-unit Range headers are ignored → 200 full', async () => {
    const { asset } = await uploadPng();
    for (const range of ['bytes=0-1,4-5', 'items=0-1', 'bytes=5-2', 'garbage']) {
      const res = await media(mediaGet, asset.key, { range });
      expect(res.status, range).toBe(200);
      expect(res.headers.get('content-length')).toBe(String(MANIFEST['sample.png'].bytes));
      await res.arrayBuffer();
    }
  });

  it('304 on If-None-Match (exact, weak, list, *) with ETag and Cache-Control and no body', async () => {
    const { asset } = await uploadPng();
    const full = await media(mediaGet, asset.key);
    const etag = full.headers.get('etag')!;
    await full.arrayBuffer();

    for (const value of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const res = await media(mediaGet, asset.key, { 'if-none-match': value });
      expect(res.status, value).toBe(304);
      expect(res.headers.get('etag')).toBe(etag);
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect((await res.arrayBuffer()).byteLength).toBe(0);
    }
    const miss = await media(mediaGet, asset.key, { 'if-none-match': '"deadbeef"' });
    expect(miss.status).toBe(200);
    await miss.arrayBuffer();
  });

  it('If-Range: a matching ETag keeps the 206; a stale one yields the full 200', async () => {
    const { asset } = await uploadPng();
    const full = await media(mediaGet, asset.key);
    const etag = full.headers.get('etag')!;
    await full.arrayBuffer();

    const fresh = await media(mediaGet, asset.key, { range: 'bytes=0-1', 'if-range': etag });
    expect(fresh.status).toBe(206);
    await fresh.arrayBuffer();

    const stale = await media(mediaGet, asset.key, { range: 'bytes=0-1', 'if-range': '"stale"' });
    expect(stale.status).toBe(200);
    expect(stale.headers.get('content-range')).toBeNull();
    await stale.arrayBuffer();
  });

  it('404 JSON envelope for traversal, malformed, unknown and cross-site keys — without creating the storage dir', async () => {
    const logs = captureLogs();
    for (const bad of [['..', '..', 'etc', 'passwd'], ['..%2F..%2Fetc%2Fpasswd'], ['blog0', 'image', '2026', '10', `${UUID}.svg`], ['blog0', 'image', '2026', '10', '..', `${UUID}.png`], [`/${UUID}.png`], ['']]) {
      const res = await media(mediaGet, bad);
      expect(res.status, bad.join('/')).toBe(404);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      const env = (await res.json()) as Envelope<unknown>;
      expect(err(env).code).toBe('NOT_FOUND');
      expect(res.headers.get('x-request-id')).toBeTruthy();
    }
    const unknownValid = await media(mediaGet, `blog0/image/2026/10/${UUID}.png`);
    expect(unknownValid.status).toBe(404);
    expect(err((await unknownValid.json()) as Envelope<unknown>).code).toBe('NOT_FOUND');

    const other = await media(mediaGet, `other-site/image/2026/10/${UUID}.png`);
    expect(other.status).toBe(404);
    await other.json();
    logs.stop();
    expect(existsSync(testStorageDir())).toBe(false);
    expect(logs.lines.filter((l) => l.level === 'error')).toEqual([]);
    expect(logs.find('media.request').every((l) => l.status === 404)).toBe(true);
  });

  it('404 (with a warn line) when the row exists but the file is gone', async () => {
    const { asset } = await uploadPng();
    await getStorage().delete(asset.key);
    const logs = captureLogs();
    const res = await media(mediaGet, asset.key);
    logs.stop();
    expect(res.status).toBe(404);
    expect(err((await res.json()) as Envelope<unknown>).code).toBe('NOT_FOUND');
    expect(logs.lines.some((l) => l.level === 'warn' && l.event === 'media.request')).toBe(true);
  });

  it('other methods → 405 with Allow: GET, HEAD', async () => {
    const { asset } = await uploadPng();
    for (const handler of [mediaPost, mediaDelete]) {
      const res = await media(handler, asset.key);
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
    }
  });

  it('serves every stored image type with its stored mime and an ASCII-safe filename', async () => {
    for (const name of ['sample.jpg', 'sample.webp', 'tiny.gif']) {
      const { env } = await upload({ file: { buffer: fixture(name), name: `Üñí "${name}` } });
      const { asset } = data(env);
      const res = await media(mediaGet, asset.key);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(MANIFEST[name].mime);
      expect(res.headers.get('content-disposition')).toBe(`inline; filename="___ _${name}"`);
      expect(Buffer.from(await res.arrayBuffer()).equals(fixture(name))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('deleteAssetIfUnreferenced', () => {
  it('deletes the row and the file when no article_format payload references the key; idempotent', async () => {
    const { asset } = await uploadPng();
    expect(await isStorageKeyReferenced(writer.user.siteId, asset.key)).toBe(false);
    expect(await deleteAssetIfUnreferenced(writer.user.siteId, asset.id)).toBe('deleted');
    expect(await getDb().select().from(mediaAsset)).toEqual([]);
    expect(existsSync(diskPath(asset.key))).toBe(false);
    expect(await deleteAssetIfUnreferenced(writer.user.siteId, asset.id)).toBe('missing');
    expect(await deleteAssetIfUnreferenced(writer.user.siteId, 'not-a-uuid')).toBe('missing');
  });

  it('keeps the row and the file while a draft or published payload still references the key', async () => {
    const { asset } = await uploadPng();
    const article = await createArticle({ siteId: writer.user.siteId, user: writer.user } as ActorContext, { title: 'Listen', topic: 'Audio' });
    const [fmt] = await getDb()
      .insert(articleFormat)
      .values({ siteId: writer.user.siteId, articleId: article.id, kind: 'listen', draftPayload: { audio: { key: asset.key } }, publishedPayload: null })
      .returning();

    expect(await isStorageKeyReferenced(writer.user.siteId, asset.key)).toBe(true);
    expect(await deleteAssetIfUnreferenced(writer.user.siteId, asset.id)).toBe('referenced');
    expect(existsSync(diskPath(asset.key))).toBe(true);

    await getDb().update(articleFormat).set({ draftPayload: null, publishedPayload: { audio: { key: asset.key } } }).where(eq(articleFormat.id, fmt.id));
    expect(await deleteAssetIfUnreferenced(writer.user.siteId, asset.id)).toBe('referenced');

    await getDb().update(articleFormat).set({ publishedPayload: { audio: { key: 'blog0/audio/2026/10/00000000-0000-4000-8000-000000000000.mp3' } } }).where(eq(articleFormat.id, fmt.id));
    expect(await deleteAssetIfUnreferenced(writer.user.siteId, asset.id)).toBe('deleted');
    expect(existsSync(diskPath(asset.key))).toBe(false);
  });

  it('never deletes across sites', async () => {
    const { asset } = await uploadPng();
    expect(await deleteAssetIfUnreferenced(UUID, asset.id)).toBe('missing');
    expect(existsSync(diskPath(asset.key))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

describe('designer mode (pglite://memory): upload → stream with local disk, nothing new', () => {
  const saved: Record<string, string | undefined> = {};
  const SAVED_ENV = ['BLOG0_DATABASE_URL', 'BLOG0_OPENROUTER_API_KEY'] as const;

  function resetSingletons(): void {
    resetConfigForTests();
    resetLlmClientForTests();
    resetCurrentSiteForTests();
    resetLoggerForTests();
    resetStorageForTests();
  }

  beforeAll(async () => {
    for (const name of SAVED_ENV) saved[name] = process.env[name];
    process.env.BLOG0_DATABASE_URL = 'pglite://memory';
    process.env.BLOG0_OPENROUTER_API_KEY = '';
    await resetDbForTests();
    resetSingletons();
    const handle = await initDb();
    expect(handle.engine).toBe('pglite');
    await runMigrations(handle);
    await seedSite(getDb(), 'blog0');
  });

  afterAll(async () => {
    await closeDb();
    for (const name of SAVED_ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    await resetDbForTests();
    resetSingletons();
  });

  it('stores a PNG and serves a 206 range from disk on PGlite', async () => {
    resetStorage();
    writer = await loginAs({ email: 'designer@blog0.local' });
    const body = await uploadPng({ alt: 'designer' });
    expect(body.asset.mimeType).toBe('image/png');
    expect(existsSync(diskPath(body.asset.key))).toBe(true);

    const [row] = await getDb().select().from(mediaAsset).where(eq(mediaAsset.id, body.asset.id));
    expect(row).toMatchObject({ kind: 'image', width: 320, height: 200, byteSize: MANIFEST['sample.png'].bytes });

    const res = await media(mediaGet, body.asset.key, { range: 'bytes=0-1' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-1/${MANIFEST['sample.png'].bytes}`);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(fixture('sample.png').subarray(0, 2));
  });
});
