// Media library against real blog0_test + real files under var/storage-test: GET /api/admin/media
// (every image, newest first, with the articles that show it) and POST /api/admin/media/:id/replace
// (new bytes behind the same /media/<key>; refusals leave the old file untouched).
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { POST as replaceRoute } from '@/app/api/admin/media/[id]/replace/route';
import { GET as listRoute } from '@/app/api/admin/media/route';
import { POST as uploadImageRoute } from '@/app/api/admin/uploads/images/route';
import { GET as mediaGet } from '@/app/media/[...key]/route';
import type { MediaLibraryResponse, MediaReplaceResponse } from '@/lib/api/dto';
import type { Envelope } from '@/lib/api/envelope';
import { createArticle, type ActorContext } from '@/server/articles/service';
import { getRenderedRevision, renderCacheSize } from '@/server/content';
import { getDb } from '@/server/db/client';
import { mediaAsset } from '@/server/db/schema';
import { getStorage } from '@/server/storage';

import { call, data, err, ORIGIN } from '../helpers/api';
import { resetDb } from '../helpers/db';
import { loginAs, type TestLogin } from '../helpers/session';
import { resetStorage } from '../helpers/storage';

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures', 'images');
type Manifest = Record<string, { type: string; mime: string | null; width: number; height: number; bytes: number }>;
const MANIFEST = JSON.parse(readFileSync(path.join(FIXTURES, 'sample.json'), 'utf8')) as Manifest;
const fixture = (name: string): Buffer => readFileSync(path.join(FIXTURES, name));

let writer: TestLogin;

beforeEach(async () => {
  await resetDb();
  resetStorage();
  writer = await loginAs({ displayName: 'Vennamaneni Sai Krishna' });
});

function formWith(name: string, type: string): FormData {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(fixture(name))], name, { type }));
  return form;
}

async function uploadImage(name = 'sample.png', type = 'image/png'): Promise<{ id: string; key: string; url: string }> {
  const form = formWith(name, type);
  form.set('alt', 'x');
  const res = await uploadImageRoute(
    new Request(`${ORIGIN}/api/admin/uploads/images`, { method: 'POST', headers: { host: 'localhost:3410', cookie: writer.cookie, origin: ORIGIN }, body: form }),
    { params: Promise.resolve({}) },
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as Envelope<{ asset: { id: string; key: string; url: string } }>;
  return data(body).asset;
}

const actor = (): ActorContext => ({ siteId: writer.user.siteId, user: writer.user }) as ActorContext;

function replace(id: string, form: FormData | null, opts: { who?: TestLogin | null; origin?: string | null } = {}) {
  const who = opts.who === undefined ? writer : opts.who;
  return call<MediaReplaceResponse>(replaceRoute, 'POST', `/api/admin/media/${id}/replace`, {
    id,
    form: form ?? new FormData(),
    cookie: who ? who.cookie : null,
    origin: opts.origin,
  });
}

describe('GET /api/admin/media', () => {
  it('lists every image newest first, with who uploaded it and the articles whose Markdown shows it', async () => {
    const first = await uploadImage('sample.png', 'image/png');
    const second = await uploadImage('sample.jpg', 'image/jpeg');
    const article = await createArticle(actor(), { title: 'Has the first image', topic: 'Images', bodyMd: `Some words before.\n\n![a chart](${first.url})\n\nAnd after it.` });

    const { status, env } = await call<MediaLibraryResponse>(listRoute, 'GET', '/api/admin/media', { who: writer });

    expect(status).toBe(200);
    const items = data(env).items;
    expect(items.map((i) => i.id)).toEqual([second.id, first.id]);
    expect(items[1]).toMatchObject({
      key: first.key,
      url: first.url,
      mimeType: 'image/png',
      width: MANIFEST['sample.png'].width,
      height: MANIFEST['sample.png'].height,
      uploadedBy: 'Vennamaneni Sai Krishna',
      usedIn: [{ articleId: article.id, title: 'Has the first image', status: 'draft' }],
    });
    expect(items[0].usedIn).toEqual([]);
  });

  it('401 without a session; audio is not listed', async () => {
    const { status, env } = await call<MediaLibraryResponse>(listRoute, 'GET', '/api/admin/media', { cookie: null });
    expect(status).toBe(401);
    expect(err(env).code).toBe('UNAUTHENTICATED');

    await getDb().insert(mediaAsset).values({
      siteId: writer.user.siteId, kind: 'audio', storageKey: 'blog0/audio/2026/11/x.mp3', originalFilename: 'x.mp3',
      mimeType: 'audio/mpeg', byteSize: 1, sha256: 'a'.repeat(64), createdBy: writer.user.id,
    });
    const listed = await call<MediaLibraryResponse>(listRoute, 'GET', '/api/admin/media', { who: writer });
    expect(data(listed.env).items).toEqual([]);
  });
});

describe('POST /api/admin/media/:id/replace', () => {
  it('puts the new file behind the SAME /media/<key>: new bytes, type, size, dimensions and ETag; usage unchanged', async () => {
    const asset = await uploadImage('sample.png', 'image/png');
    const article = await createArticle(actor(), { title: 'Uses it', topic: 'Images', bodyMd: `![alt](${asset.url})` });
    const before = await mediaGet(new Request(`${ORIGIN}${asset.url}`), { params: Promise.resolve({ key: asset.key.split('/') }) });
    const etagBefore = before.headers.get('etag');
    await before.arrayBuffer();

    const { status, env } = await replace(asset.id, formWith('sample.jpg', 'image/jpeg'));

    expect(status).toBe(200);
    const { item } = data(env);
    expect(item).toMatchObject({
      id: asset.id, key: asset.key, url: asset.url, filename: 'sample.jpg', mimeType: 'image/jpeg',
      width: MANIFEST['sample.jpg'].width, height: MANIFEST['sample.jpg'].height, bytes: MANIFEST['sample.jpg'].bytes,
    });
    expect(item.usedIn.map((u) => u.articleId)).toEqual([article.id]);

    const after = await mediaGet(new Request(`${ORIGIN}${asset.url}`), { params: Promise.resolve({ key: asset.key.split('/') }) });
    expect(after.status).toBe(200);
    expect(after.headers.get('content-type')).toBe('image/jpeg');
    expect(after.headers.get('etag')).not.toBe(etagBefore);
    expect(after.headers.get('cache-control')).toBe('public, no-cache');
    expect(Buffer.from(await after.arrayBuffer()).equals(fixture('sample.jpg'))).toBe(true);
    expect((await getStorage().get(asset.key))!.equals(fixture('sample.jpg'))).toBe(true);
    const [row] = await getDb().select().from(mediaAsset).where(eq(mediaAsset.id, asset.id));
    expect(row).toMatchObject({ storageKey: asset.key, mimeType: 'image/jpeg', byteSize: MANIFEST['sample.jpg'].bytes });
  });

  it('clears the render cache (it embeds the old width and height)', async () => {
    const asset = await uploadImage();
    await getRenderedRevision('rev-for-cache-test', { title: 'T', dek: '', bodyMd: 'A body with enough words to render.' });
    expect(renderCacheSize()).toBeGreaterThan(0);

    expect((await replace(asset.id, formWith('sample.webp', 'image/webp'))).status).toBe(200);

    expect(renderCacheSize()).toBe(0);
  });

  it('refusals leave the old file and row untouched: SVG 415, not an image 415, no file 400, unknown id 404', async () => {
    const asset = await uploadImage();
    const old = fixture('sample.png');

    const svg = await replace(asset.id, formWith('sample.svg', 'image/svg+xml'));
    expect(svg.status).toBe(415);
    expect(err(svg.env).code).toBe('UNSUPPORTED_MEDIA');

    const text = new FormData();
    text.set('file', new File(['not an image at all'], 'fake.png', { type: 'image/png' }));
    expect((await replace(asset.id, text)).status).toBe(415);

    const none = await replace(asset.id, null);
    expect(none.status).toBe(400);
    expect(err(none.env).code).toBe('VALIDATION_FAILED');

    const unknown = await replace('0f8fad5b-d9cb-469f-a165-70867728950e', formWith('sample.jpg', 'image/jpeg'));
    expect(unknown.status).toBe(404);
    expect(err(unknown.env).code).toBe('NOT_FOUND');
    const malformed = await replace('not-a-uuid', formWith('sample.jpg', 'image/jpeg'));
    expect(malformed.status).toBe(404);

    expect((await getStorage().get(asset.key))!.equals(old)).toBe(true);
    const [row] = await getDb().select().from(mediaAsset).where(eq(mediaAsset.id, asset.id));
    expect(row.mimeType).toBe('image/png');
  });

  it('401 without a session, 403 cross-origin; nothing changes', async () => {
    const asset = await uploadImage();

    const anon = await replace(asset.id, formWith('sample.jpg', 'image/jpeg'), { who: null });
    expect(anon.status).toBe(401);
    const cross = await replace(asset.id, formWith('sample.jpg', 'image/jpeg'), { origin: 'https://evil.example' });
    expect(cross.status).toBe(403);

    expect((await getStorage().get(asset.key))!.equals(fixture('sample.png'))).toBe(true);
  });
});
