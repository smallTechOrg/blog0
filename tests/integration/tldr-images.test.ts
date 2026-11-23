// SMA-49: hand-placed image slides in the TLDR deck, and slideshow-only (media-only) posts.
// No LLM anywhere: every deck here is hand-built.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { PATCH as patchRoute } from '@/app/api/admin/articles/[id]/route';
import { GET as tldrRoute, PUT as saveDeckRoute } from '@/app/api/admin/articles/[id]/tldr/route';
import { POST as uploadImageRoute } from '@/app/api/admin/uploads/images/route';
import { GET as mediaListRoute } from '@/app/api/admin/media/route';
import type { Envelope } from '@/lib/api/envelope';
import type { MediaLibraryResponse, PublishBlockedDetails, TldrStateDto, UpdateArticleResponse } from '@/lib/api/dto';
import { getPublishedArticle } from '@/server/public/articles';

import { actAs, call, createArticle, data, err, ORIGIN, publish } from '../helpers/api';
import { resetDb } from '../helpers/db';
import { loginAs, type TestLogin } from '../helpers/session';
import { resetStorage } from '../helpers/storage';

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures', 'images');
let writer: TestLogin;

beforeEach(async () => {
  await resetDb();
  resetStorage();
  writer = actAs(await loginAs({ displayName: 'Asha Writer' }));
});

async function upload(name = 'sample.png', type = 'image/png'): Promise<{ id: string; key: string; url: string; width: number; height: number }> {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(readFileSync(path.join(FIXTURES, name)))], name, { type }));
  form.set('alt', '');
  const res = await uploadImageRoute(
    new Request(`${ORIGIN}/api/admin/uploads/images`, { method: 'POST', headers: { host: 'localhost:3410', cookie: writer.cookie, origin: ORIGIN }, body: form }),
    { params: Promise.resolve({}) },
  );
  expect(res.status).toBe(201);
  return data((await res.json()) as Envelope<{ asset: { id: string; key: string; url: string; width: number; height: number } }>).asset;
}

function putDeck(id: string, body: Record<string, unknown>) {
  return call<{ tldr: TldrStateDto }>(saveDeckRoute, 'PUT', `/api/admin/articles/${id}/tldr`, { body, id });
}

async function tldr(id: string): Promise<TldrStateDto> {
  return data((await call<TldrStateDto>(tldrRoute, 'GET', `/api/admin/articles/${id}/tldr`, { id })).env);
}

const BODY = 'The first line is long enough to pick. A second sentence also long enough here.';

describe('image slides in the deck', () => {
  it('saves a deck mixing a line and an image, resolves the asset server-side, and publishes it', async () => {
    const created = await createArticle({ title: 'Pictures', topic: 'Analysis', bodyMd: BODY });
    const asset = await upload();
    const state = await tldr(created.id);

    const saved = data(
      (
        await putDeck(created.id, {
          revisionId: created.currentRevision.id,
          slides: [
            { sid: state.sentences[0].sid, source: 'writer' },
            // width/height/key sent by a client are never trusted: only assetId, caption and alt are read.
            { sid: `img:${asset.id}`, source: 'image', assetId: asset.id, text: 'A caption', alt: 'A square', key: 'evil', width: 1 },
          ],
        })
      ).env,
    ).tldr;

    expect(saved.status).toBe('ready'); // an image slide never makes the deck stale
    expect(saved.draft!.slides[1]).toMatchObject({
      sid: `img:${asset.id}`,
      source: 'image',
      text: 'A caption',
      missing: false,
      image: { assetId: asset.id, key: asset.key, url: asset.url, alt: 'A square', width: asset.width, height: asset.height },
    });

    const published = data((await publish(created.id, created.currentRevision.id)).env).article;
    const view = await getPublishedArticle(published.slug);
    expect(view!.deck!.slides).toEqual([
      { text: state.sentences[0].text },
      { text: 'A caption', image: { url: asset.url, alt: 'A square' } },
    ]);
  });

  it('refuses an image slide whose asset is not an image of this site, a mismatched sid, or a duplicate (422 DECK_INVALID)', async () => {
    const created = await createArticle({ title: 'Bad images', topic: 'Analysis', bodyMd: BODY });
    const asset = await upload();
    const rev = created.currentRevision.id;
    const image = (over: Record<string, unknown> = {}) => ({ sid: `img:${asset.id}`, source: 'image', assetId: asset.id, text: '', alt: '', ...over });

    const missingAsset = await putDeck(created.id, { revisionId: rev, slides: [image({ assetId: '00000000-0000-4000-8000-000000000000', sid: 'img:00000000-0000-4000-8000-000000000000' })] });
    const wrongSid = await putDeck(created.id, { revisionId: rev, slides: [image({ sid: 'img:other' })] });
    const duplicate = await putDeck(created.id, { revisionId: rev, slides: [image(), image()] });

    for (const res of [missingAsset, wrongSid, duplicate]) {
      expect(res.status).toBe(422);
      expect(err(res.env).code).toBe('DECK_INVALID');
    }
  });

  it('lists the post under the image in the media library, so a used image is not deletable by mistake', async () => {
    const created = await createArticle({ title: 'Used image', topic: 'Analysis', bodyMd: BODY });
    const asset = await upload();
    await putDeck(created.id, { revisionId: created.currentRevision.id, slides: [{ sid: `img:${asset.id}`, source: 'image', assetId: asset.id, text: '', alt: 'x' }] });

    const library = data((await call<MediaLibraryResponse>(mediaListRoute, 'GET', '/api/admin/media')).env);
    const item = library.items.find((i) => i.id === asset.id)!;

    expect(item.usedIn.map((u) => u.articleId)).toEqual([created.id]);
  });
});

describe('images the article already shows (SMA-53)', () => {
  it('offers the article\'s own images, in document order and once each, ready to add to the deck', async () => {
    const first = await upload('sample.png', 'image/png');
    const second = await upload('sample.jpg', 'image/jpeg');
    const unused = await upload('sample.webp', 'image/webp');
    const created = await createArticle({
      title: 'Has pictures',
      topic: 'Analysis',
      bodyMd: `Intro line that is long enough.\n\n![b](${second.url})\n\nMiddle line that is long enough.\n\n![a](${first.url})\n\n![again](${second.url})`,
    });

    const state = await tldr(created.id);

    expect(state.articleImages.map((i) => i.assetId)).toEqual([second.id, first.id]);
    expect(state.articleImages.map((i) => i.assetId)).not.toContain(unused.id);
    expect(state.articleImages[0]).toMatchObject({ key: second.key, url: second.url, width: second.width, height: second.height });

    // an offered image can go straight into the deck (same save as an uploaded one)
    const saved = data(
      (await putDeck(created.id, { revisionId: created.currentRevision.id, slides: [{ sid: `img:${first.id}`, source: 'image', assetId: first.id, text: '', alt: 'a' }] })).env,
    ).tldr;
    expect(saved.draft!.slides[0].image!.key).toBe(first.key);
  });

  it('offers nothing for an article with no images', async () => {
    const created = await createArticle({ title: 'No pictures', topic: 'Analysis', bodyMd: BODY });
    expect((await tldr(created.id)).articleImages).toEqual([]);
  });
});

describe('slideshow-only posts', () => {
  async function patch(id: string, body: Record<string, unknown>) {
    return data((await call<UpdateArticleResponse>(patchRoute, 'PATCH', `/api/admin/articles/${id}`, { body, id })).env);
  }

  it('publishes with an empty body once it has a deck, and the public page is a deck with no Read or Listen', async () => {
    const created = await createArticle({ title: 'Just pictures', topic: 'Photos' });
    const asset = await upload();
    const { article } = await patch(created.id, { baseRevisionId: created.currentRevision.id, mediaOnly: true });
    expect(article.mediaOnly).toBe(true);

    // no deck yet → blocked with DECK_REQUIRED (and no BODY_REQUIRED)
    const blocked = await publish(created.id, article.currentRevision.id);
    expect(blocked.status).toBe(422);
    expect((err(blocked.env).details as PublishBlockedDetails).reasons.map((r) => r.code)).toEqual(['DECK_REQUIRED']);

    await putDeck(created.id, { revisionId: article.currentRevision.id, slides: [{ sid: `img:${asset.id}`, source: 'image', assetId: asset.id, text: '', alt: 'A square' }] });
    const published = data((await publish(created.id, article.currentRevision.id)).env).article;
    const view = await getPublishedArticle(published.slug);

    expect(view!.mediaOnly).toBe(true);
    expect(view!.deck!.slides).toEqual([{ text: '', image: { url: asset.url, alt: 'A square' } }]);
    expect(view!.listen).toBeNull();
  });

  it('a normal post with an empty body is still refused (BODY_REQUIRED)', async () => {
    const created = await createArticle({ title: 'Empty', topic: 'Photos' });
    const res = await publish(created.id, created.currentRevision.id);
    expect(res.status).toBe(422);
    expect((err(res.env).details as PublishBlockedDetails).reasons.map((r) => r.code)).toContain('BODY_REQUIRED');
  });
});
