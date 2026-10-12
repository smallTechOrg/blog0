// Articles API (S1.6) against real blog0_test: create → save (revisions) → conflict → slug rules →
// publish rules → public view model → unpublish/republish → delete rules → desk list + chips.
// No LLM is involved anywhere in this file (publishing never calls the AI).
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { and, count, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { GET as listRoute, POST as createRoute } from '@/app/api/admin/articles/route';
import { DELETE as deleteRoute, GET as getRoute, PATCH as patchRoute } from '@/app/api/admin/articles/[id]/route';
import { POST as publishRoute } from '@/app/api/admin/articles/[id]/publish/route';
import { POST as unpublishRoute } from '@/app/api/admin/articles/[id]/unpublish/route';
import { POST as previewRoute } from '@/app/api/admin/preview/route';
import type {
  ArticleDetailDto,
  ArticleListResponse,
  ArticleResponse,
  PreviewResultDto,
  PublishBlockedDetails,
  UpdateArticleResponse,
} from '@/lib/api/dto';
import type { Envelope, Err } from '@/lib/api/envelope';
import { createArticle as serviceCreateArticle, publishArticle as servicePublishArticle, type ActorContext } from '@/server/articles/service';
import { slugify, uniqueSlug } from '@/server/articles/slug';
import { getDb } from '@/server/db/client';
import { aiGeneration, appUser, article, articleRevision, site } from '@/server/db/schema';
import { getPublishedArticle } from '@/server/public/articles';
import { siteSeedFor } from '@/server/site/defaults';

import { resetDb } from '../helpers/db';
import { loginAs, type TestLogin } from '../helpers/session';

const ORIGIN = 'http://localhost:3410';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const HARD_CASES = readFileSync(path.join(ROOT, 'tests', 'fixtures', 'articles', 'hard-cases.md'), 'utf8');

const BODY = [
  '## Why decks',
  '',
  'The deck shows the strongest lines of the article in order. Each slide holds exactly one sentence from the text.',
  '',
  'Writers pick the lines by hand when the model is unavailable. That keeps publishing moving on a bad day.',
].join('\n');

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

interface CallOptions {
  cookie?: string | null;
  body?: unknown;
  origin?: string | null;
  id?: string;
}

async function call<T>(handler: Handler, method: string, url: string, opts: CallOptions = {}): Promise<{ status: number; env: Envelope<T>; res: Response }> {
  const headers: Record<string, string> = { host: 'localhost:3410' };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin !== null && method !== 'GET') headers.origin = opts.origin ?? ORIGIN;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const request = new Request(`${ORIGIN}${url}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await handler(request, { params: Promise.resolve<Record<string, string>>(opts.id ? { id: opts.id } : {}) });
  return { status: res.status, env: (await res.json()) as Envelope<T>, res };
}

function data<T>(env: Envelope<T>): T {
  if (!env.ok) throw new Error(`expected ok envelope, got ${env.error.code}: ${env.error.message}`);
  return env.data;
}

function err(env: Envelope<unknown>): Err['error'] {
  if (env.ok) throw new Error('expected an error envelope');
  return env.error;
}

let writer: TestLogin;

async function create(body: Record<string, unknown>, who: TestLogin = writer): Promise<ArticleDetailDto> {
  const { status, env } = await call<ArticleResponse>(createRoute, 'POST', '/api/admin/articles', { cookie: who.cookie, body });
  expect(status).toBe(201);
  return data(env).article;
}

async function patch(id: string, body: Record<string, unknown>, who: TestLogin = writer) {
  return call<UpdateArticleResponse>(patchRoute, 'PATCH', `/api/admin/articles/${id}`, { cookie: who.cookie, body, id });
}

async function publish(id: string, revisionId: string) {
  return call<ArticleResponse>(publishRoute, 'POST', `/api/admin/articles/${id}/publish`, {
    cookie: writer.cookie,
    body: { revisionId },
    id,
  });
}

async function revisionsOf(articleId: string): Promise<number> {
  const [row] = await getDb().select({ n: count() }).from(articleRevision).where(eq(articleRevision.articleId, articleId));
  return Number(row.n);
}

beforeEach(async () => {
  await resetDb();
  writer = await loginAs({ displayName: 'Asha Writer' });
});

describe('auth and origin guards', () => {
  it('rejects a request without a session with 401 UNAUTHENTICATED', async () => {
    const { status, env } = await call(listRoute, 'GET', '/api/admin/articles', { cookie: null });

    expect(status).toBe(401);
    expect(err(env).code).toBe('UNAUTHENTICATED');
  });

  it('rejects a cross-origin create with 403 FORBIDDEN_ORIGIN and creates nothing', async () => {
    const { status, env } = await call(createRoute, 'POST', '/api/admin/articles', {
      cookie: writer.cookie,
      origin: 'https://evil.example',
      body: { title: 'Nope' },
    });

    expect(status).toBe(403);
    expect(err(env).code).toBe('FORBIDDEN_ORIGIN');
    const [row] = await getDb().select({ n: count() }).from(article);
    expect(Number(row.n)).toBe(0);
  });
});

describe('POST /api/admin/preview', () => {
  it('renders the hard-cases fixture with blocks, warnings, stats and the eligible sentence count', async () => {
    const { status, env } = await call<PreviewResultDto>(previewRoute, 'POST', '/api/admin/preview', {
      cookie: writer.cookie,
      body: { title: 'Hard cases', dek: '', bodyMd: HARD_CASES },
    });

    expect(status).toBe(200);
    const preview = data(env);
    const html = preview.blocks.map((b) => (b.kind === 'html' ? b.html : '')).join('\n');
    expect(html).toContain('<table');
    expect(html).toContain('<h2');
    expect(preview.blocks).toContainEqual({ kind: 'figure', figureId: 'slide47', known: true });
    expect(preview.blocks).toContainEqual({ kind: 'figure', figureId: 'does-not-exist', known: false });
    const codes = preview.warnings.map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['UNKNOWN_FIGURE', 'RAW_HTML_DROPPED', 'UNKNOWN_CODE_LANG']));
    expect(preview.stats.words).toBeGreaterThan(50);
    expect(preview.stats.readMinutes).toBeGreaterThanOrEqual(1);
    expect(preview.sentenceCount).toBeGreaterThan(5);
  });

  it('returns an empty-body warning and zero sentences for an empty body', async () => {
    const { env } = await call<PreviewResultDto>(previewRoute, 'POST', '/api/admin/preview', {
      cookie: writer.cookie,
      body: { title: '', dek: '', bodyMd: '' },
    });

    const preview = data(env);
    expect(preview.sentenceCount).toBe(0);
    expect(preview.warnings.map((w) => w.code)).toContain('EMPTY_BODY');
  });

  it('rejects a body over 200 000 characters with 400 VALIDATION_FAILED', async () => {
    const { status, env } = await call(previewRoute, 'POST', '/api/admin/preview', {
      cookie: writer.cookie,
      body: { title: 't', dek: '', bodyMd: 'a'.repeat(200_001) },
    });

    expect(status).toBe(400);
    expect(err(env).code).toBe('VALIDATION_FAILED');
  });
});

describe('create and save', () => {
  it('creates revision 1 with a slug derived from the title and the writer as byline', async () => {
    const created = await create({ title: 'Tech Company First — Always!', dek: 'A dek', bodyMd: BODY });

    expect(created.slug).toBe('tech-company-first-always');
    expect(created.slugLocked).toBe(false);
    expect(created.status).toBe('draft');
    expect(created.bylineName).toBe('Asha Writer');
    expect(created.currentRevision.number).toBe(1);
    expect(created.currentRevision.createdBy).toBe('Asha Writer');
    expect(created.currentRevision.bodyMd).toBe(BODY);
    expect(created.currentRevision.wordCount).toBeGreaterThan(20);
    expect(created.currentRevision.eligibleSentenceCount).toBe(4);
    expect(created.revisionCount).toBe(1);
    expect(created.publicUrl).toBeNull();
    expect(created.formats.map((f) => f.kind)).toEqual(['read', 'tldr', 'listen']);
    expect(created.formats.map((f) => f.status)).toEqual(['ready', 'missing', 'missing']);
  });

  it('suffixes -2 and -3 when the derived slug is taken', async () => {
    const a = await create({ title: 'Same Title' });
    const b = await create({ title: 'Same title' });
    const c = await create({ title: 'same  TITLE!' });

    expect([a.slug, b.slug, c.slug]).toEqual(['same-title', 'same-title-2', 'same-title-3']);
  });

  it('rejects a create without a title with 400 VALIDATION_FAILED', async () => {
    const { status, env } = await call(createRoute, 'POST', '/api/admin/articles', { cookie: writer.cookie, body: { title: '   ' } });

    expect(status).toBe(400);
    expect(err(env).code).toBe('VALIDATION_FAILED');
  });

  it('creates revisions 1 and 2 only across a body save and a topic-only save', async () => {
    const created = await create({ title: 'Revisions', bodyMd: BODY });

    const first = await patch(created.id, { baseRevisionId: created.currentRevision.id, bodyMd: `${BODY}\n\nOne more paragraph with enough words in it.` });
    const afterBody = data(first.env);
    const second = await patch(created.id, { baseRevisionId: afterBody.article.currentRevision.id, topic: 'Analysis' });
    const afterTopic = data(second.env);

    expect(afterBody.revisionCreated).toBe(true);
    expect(afterBody.article.currentRevision.number).toBe(2);
    expect(afterTopic.revisionCreated).toBe(false);
    expect(afterTopic.article.currentRevision.id).toBe(afterBody.article.currentRevision.id);
    expect(afterTopic.article.topic).toBe('Analysis');
    expect(afterTopic.article.revisionCount).toBe(2);
    expect(afterTopic.article.topics).toEqual(['Analysis']);
    expect(await revisionsOf(created.id)).toBe(2);
  });

  it('refuses a save on a stale base revision with 409 CONFLICT naming the saver, leaving the body unchanged', async () => {
    const created = await create({ title: 'Conflict', bodyMd: BODY });
    const other = await loginAs({ displayName: 'Ravi Editor' });
    const saved = data((await patch(created.id, { baseRevisionId: created.currentRevision.id, bodyMd: `${BODY}\n\nRavi added this line here.` }, other)).env);

    const { status, env } = await patch(created.id, { baseRevisionId: created.currentRevision.id, bodyMd: 'Overwrite attempt' });

    expect(status).toBe(409);
    expect(err(env).code).toBe('CONFLICT');
    expect(err(env).message).toContain('Ravi Editor');
    const reread = data((await call<ArticleResponse>(getRoute, 'GET', `/api/admin/articles/${created.id}`, { cookie: writer.cookie, id: created.id })).env);
    expect(reread.article.currentRevision.id).toBe(saved.article.currentRevision.id);
    expect(reread.article.currentRevision.bodyMd).toBe(`${BODY}\n\nRavi added this line here.`);
    expect(await revisionsOf(created.id)).toBe(2);
  });

  it('re-derives the slug from a new title until the writer sets one by hand', async () => {
    const created = await create({ title: 'First Title' });

    const renamed = data((await patch(created.id, { baseRevisionId: created.currentRevision.id, title: 'Second Title' })).env).article;
    const custom = data((await patch(created.id, { baseRevisionId: renamed.currentRevision.id, slug: 'my-own-slug' })).env).article;
    const renamedAgain = data((await patch(created.id, { baseRevisionId: custom.currentRevision.id, title: 'Third Title' })).env).article;

    expect(renamed.slug).toBe('second-title');
    expect(custom.slug).toBe('my-own-slug');
    expect(renamedAgain.slug).toBe('my-own-slug');
    expect(renamedAgain.currentRevision.title).toBe('Third Title');
  });

  it('rejects a slug used by another article with 409 SLUG_TAKEN and a malformed slug with 400', async () => {
    await create({ title: 'Taken Slug' });
    const created = await create({ title: 'Other' });

    const taken = await patch(created.id, { baseRevisionId: created.currentRevision.id, slug: 'taken-slug' });
    const malformed = await patch(created.id, { baseRevisionId: created.currentRevision.id, slug: 'Bad Slug!' });

    expect(taken.status).toBe(409);
    expect(err(taken.env).code).toBe('SLUG_TAKEN');
    expect(malformed.status).toBe(400);
    expect(err(malformed.env).code).toBe('VALIDATION_FAILED');
  });

  it('answers 404 NOT_FOUND for a malformed id and for an unknown uuid', async () => {
    const malformed = await call(getRoute, 'GET', '/api/admin/articles/not-a-uuid', { cookie: writer.cookie, id: 'not-a-uuid' });
    const unknown = await call(getRoute, 'GET', '/api/admin/articles/00000000-0000-4000-8000-000000000000', {
      cookie: writer.cookie,
      id: '00000000-0000-4000-8000-000000000000',
    });

    expect(malformed.status).toBe(404);
    expect(err(malformed.env).code).toBe('NOT_FOUND');
    expect(unknown.status).toBe(404);
  });

  it('applies metadata (byline, featured, rank, in-progress badge) without a revision', async () => {
    const created = await create({ title: 'Meta', bodyMd: BODY });

    const res = data(
      (
        await patch(created.id, {
          baseRevisionId: created.currentRevision.id,
          bylineName: 'Sai Krishna V',
          isFeatured: true,
          featuredRank: 2,
          inProgress: true,
        })
      ).env,
    );

    expect(res.revisionCreated).toBe(false);
    expect(res.article).toMatchObject({ bylineName: 'Sai Krishna V', isFeatured: true, featuredRank: 2, inProgress: true });
  });
});

describe('publish, public view, unpublish, delete', () => {
  it('blocks publishing without a topic with 422 PUBLISH_BLOCKED reason TOPIC_REQUIRED', async () => {
    const created = await create({ title: 'No topic', bodyMd: BODY });

    const { status, env } = await publish(created.id, created.currentRevision.id);

    expect(status).toBe(422);
    const e = err(env);
    expect(e.code).toBe('PUBLISH_BLOCKED');
    expect((e.details as PublishBlockedDetails).reasons.map((r) => r.code)).toEqual(['TOPIC_REQUIRED']);
  });

  it('blocks publishing an empty body with BODY_REQUIRED (and a missing topic in the same response)', async () => {
    const created = await create({ title: 'Empty' });

    const { env } = await publish(created.id, created.currentRevision.id);

    expect((err(env).details as PublishBlockedDetails).reasons.map((r) => r.code)).toEqual(['TOPIC_REQUIRED', 'BODY_REQUIRED']);
  });

  it('refuses to publish a revision that is not current with 409 CONFLICT', async () => {
    const created = await create({ title: 'Old rev', topic: 'Analysis', bodyMd: BODY });
    await patch(created.id, { baseRevisionId: created.currentRevision.id, bodyMd: `${BODY}\n\nNewer paragraph with some extra words.` });

    const { status, env } = await publish(created.id, created.currentRevision.id);

    expect(status).toBe(409);
    expect(err(env).code).toBe('CONFLICT');
  });

  it('publishes, keeps readers on the published revision after a save, then moves them on Publish changes', async () => {
    const created = await create({ title: 'Live piece', topic: 'Perspectives', bodyMd: BODY });

    const published = data((await publish(created.id, created.currentRevision.id)).env).article;
    const view1 = await getPublishedArticle(published.slug);
    const saved = data((await patch(created.id, { baseRevisionId: published.currentRevision.id, bodyMd: `${BODY}\n\nA brand new closing paragraph for readers.` })).env).article;
    const list = data((await call<ArticleListResponse>(listRoute, 'GET', '/api/admin/articles', { cookie: writer.cookie })).env).articles;
    const view2 = await getPublishedArticle(published.slug);
    const republished = data((await publish(created.id, saved.currentRevision.id)).env).article;
    const view3 = await getPublishedArticle(published.slug);

    expect(published.status).toBe('published');
    expect(published.slugLocked).toBe(true);
    expect(published.firstPublishedAt).not.toBeNull();
    expect(published.publishedRevisionId).toBe(created.currentRevision.id);
    expect(published.publicUrl).toBe(`${ORIGIN}/p/live-piece`);
    expect(published.formats.find((f) => f.kind === 'read')).toMatchObject({ status: 'ready', published: true, hasUnpublishedChanges: false });
    expect(view1?.title).toBe('Live piece');
    expect(view1?.deck).toBeNull();
    expect(JSON.stringify(view1?.blocks)).not.toContain('brand new closing paragraph');
    expect(list[0].hasUnpublishedChanges).toBe(true);
    expect(list[0].formats.find((f) => f.kind === 'read')?.hasUnpublishedChanges).toBe(true);
    expect(JSON.stringify(view2?.blocks)).not.toContain('brand new closing paragraph');
    expect(republished.publishedRevisionId).toBe(saved.currentRevision.id);
    expect(republished.firstPublishedAt).toBe(published.firstPublishedAt);
    expect(JSON.stringify(view3?.blocks)).toContain('brand new closing paragraph');
  });

  it('locks the slug after the first publish with 409 SLUG_LOCKED', async () => {
    const created = await create({ title: 'Locked', topic: 'Op-Ed', bodyMd: BODY });
    await publish(created.id, created.currentRevision.id);

    const { status, env } = await patch(created.id, { baseRevisionId: created.currentRevision.id, slug: 'another-slug' });
    const renamed = data((await patch(created.id, { baseRevisionId: created.currentRevision.id, title: 'Locked but renamed' })).env).article;

    expect(status).toBe(409);
    expect(err(env).code).toBe('SLUG_LOCKED');
    expect(renamed.slug).toBe('locked');
  });

  it('unpublish hides the article from readers; republish restores the same content', async () => {
    const created = await create({ title: 'Toggle', topic: 'Analysis', bodyMd: BODY });
    const published = data((await publish(created.id, created.currentRevision.id)).env).article;

    const unpublished = data(
      (await call<ArticleResponse>(unpublishRoute, 'POST', `/api/admin/articles/${created.id}/unpublish`, { cookie: writer.cookie, id: created.id })).env,
    ).article;
    const hidden = await getPublishedArticle('toggle');
    const again = data((await publish(created.id, created.currentRevision.id)).env).article;
    const visible = await getPublishedArticle('toggle');

    expect(unpublished.status).toBe('draft');
    expect(unpublished.publishedRevisionId).toBe(published.publishedRevisionId);
    expect(unpublished.publicUrl).toBeNull();
    expect(hidden).toBeNull();
    expect(again.status).toBe('published');
    expect(again.firstPublishedAt).toBe(published.firstPublishedAt);
    expect(visible?.title).toBe('Toggle');
  });

  it('refuses to delete a once-published article with 409 NOT_DELETABLE', async () => {
    const created = await create({ title: 'Keep me', topic: 'Analysis', bodyMd: BODY });
    await publish(created.id, created.currentRevision.id);
    await call(unpublishRoute, 'POST', `/api/admin/articles/${created.id}/unpublish`, { cookie: writer.cookie, id: created.id });

    const { status, env } = await call(deleteRoute, 'DELETE', `/api/admin/articles/${created.id}`, { cookie: writer.cookie, id: created.id });

    expect(status).toBe(409);
    expect(err(env).code).toBe('NOT_DELETABLE');
    expect(await revisionsOf(created.id)).toBe(1);
  });

  it('deletes a never-published draft with its revisions, generations and formats', async () => {
    const created = await create({ title: 'Scratch', bodyMd: BODY });
    await patch(created.id, { baseRevisionId: created.currentRevision.id, bodyMd: `${BODY}\n\nSecond revision text goes right here.` });
    await getDb().insert(aiGeneration).values({
      siteId: writer.user.siteId,
      articleId: created.id,
      revisionId: created.currentRevision.id,
      formatKind: 'tldr',
      task: 'tldr.select',
      status: 'failed',
      requestedBy: writer.user.id,
      model: 'test/model',
      promptVersion: 'jev-select-v1',
      inputFingerprint: 'x',
      sentenceCount: 4,
      boundMin: 4,
      boundMax: 4,
    });

    const { status, env } = await call<{ deleted: true }>(deleteRoute, 'DELETE', `/api/admin/articles/${created.id}`, {
      cookie: writer.cookie,
      id: created.id,
    });
    const after = await call(getRoute, 'GET', `/api/admin/articles/${created.id}`, { cookie: writer.cookie, id: created.id });

    expect(status).toBe(200);
    expect(data(env)).toEqual({ deleted: true });
    expect(after.status).toBe(404);
    expect(await revisionsOf(created.id)).toBe(0);
    const [gens] = await getDb().select({ n: count() }).from(aiGeneration).where(and(eq(aiGeneration.articleId, created.id)));
    expect(Number(gens.n)).toBe(0);
  });
});

describe('GET /api/admin/articles (desk)', () => {
  it('returns an empty list on an empty desk', async () => {
    const { env } = await call<ArticleListResponse>(listRoute, 'GET', '/api/admin/articles', { cookie: writer.cookie });

    expect(data(env).articles).toEqual([]);
  });

  it('lists articles newest-updated first with chips in registry order and the last author', async () => {
    const a = await create({ title: 'Older', bodyMd: BODY });
    await create({ title: 'Newer' });
    const other = await loginAs({ displayName: 'Ravi Editor' });
    await patch(a.id, { baseRevisionId: a.currentRevision.id, bodyMd: `${BODY}\n\nRavi touched this one most recently.` }, other);

    const { env } = await call<ArticleListResponse>(listRoute, 'GET', '/api/admin/articles', { cookie: writer.cookie });
    const list = data(env).articles;

    expect(list.map((x) => x.title)).toEqual(['Older', 'Newer']);
    expect(list[0].updatedBy).toBe('Ravi Editor');
    expect(list[0].hasUnpublishedChanges).toBe(false);
    expect(list[0].firstPublishedAt).toBeNull();
    expect(list[1].formats).toEqual([
      { kind: 'read', status: 'missing', published: false, hasUnpublishedChanges: false },
      { kind: 'tldr', status: 'missing', published: false, hasUnpublishedChanges: false },
      { kind: 'listen', status: 'missing', published: false, hasUnpublishedChanges: false },
    ]);
  });
});

describe('slug helpers', () => {
  it('folds diacritics, drops punctuation, caps at 80 chars and falls back for symbol-only titles', () => {
    expect(slugify('Madhupiṇḍikasutta: It’s “here”')).toBe('madhupindikasutta-its-here');
    expect(slugify('!!!')).toBe('article');
    const long = slugify('word '.repeat(40));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith('-')).toBe(false);
    expect(uniqueSlug('a', new Set(['a', 'a-2']))).toBe('a-3');
  });
});

// =============================================================================================
// Tenant isolation (spec/architecture.md §6: every query filters by the current site id)
// =============================================================================================

/** A second site with its own writer, created directly (the app only ever serves the current site). */
async function otherSiteActor(): Promise<ActorContext> {
  const db = getDb();
  const [other] = await db.insert(site).values(siteSeedFor('other-site')).returning({ id: site.id });
  const [user] = await db
    .insert(appUser)
    .values({ siteId: other.id, email: 'other@example.test', displayName: 'Other Writer', passwordHash: '$test-helper$not-a-real-hash' })
    .returning({ id: appUser.id, email: appUser.email, displayName: appUser.displayName, siteId: appUser.siteId });
  return { siteId: other.id, user };
}

describe('cross-site isolation', () => {
  it('every article read/write against another site\'s id returns NOT_FOUND and changes nothing', async () => {
    const otherCtx = await otherSiteActor();
    const foreign = await serviceCreateArticle(otherCtx, { title: 'Other site draft', topic: 'Elsewhere', bodyMd: BODY });
    const foreignPublished = await serviceCreateArticle(otherCtx, { title: 'Other site live', topic: 'Elsewhere', bodyMd: BODY });
    await servicePublishArticle(otherCtx, foreignPublished.id, foreignPublished.currentRevision.id);
    const snapshot = async () =>
      getDb()
        .select()
        .from(article)
        .where(eq(article.siteId, otherCtx.siteId))
        .orderBy(article.createdAt);
    const before = await snapshot();
    const opts = (id: string, body?: unknown) => ({ cookie: writer.cookie, id, body });

    const results = [
      await call(getRoute, 'GET', `/api/admin/articles/${foreign.id}`, opts(foreign.id)),
      await patch(foreign.id, { baseRevisionId: foreign.currentRevision.id, title: 'Hijacked', bodyMd: `${BODY}\n\nInjected text.` }),
      await publish(foreign.id, foreign.currentRevision.id),
      await call(unpublishRoute, 'POST', `/api/admin/articles/${foreignPublished.id}/unpublish`, opts(foreignPublished.id)),
      await call(deleteRoute, 'DELETE', `/api/admin/articles/${foreign.id}`, opts(foreign.id)),
    ];

    for (const r of results) {
      expect(r.status).toBe(404);
      expect(err(r.env).code).toBe('NOT_FOUND');
    }
    expect(await snapshot()).toEqual(before);
    expect(await revisionsOf(foreign.id)).toBe(1);
    expect(await getPublishedArticle(foreignPublished.slug)).toBeNull(); // the public view is site-scoped too
    const desk = data((await call<ArticleListResponse>(listRoute, 'GET', '/api/admin/articles', { cookie: writer.cookie })).env);
    expect(desk.articles).toEqual([]);
  });

  it('a slug used on another site does not collide with this site\'s slugs', async () => {
    const otherCtx = await otherSiteActor();
    await serviceCreateArticle(otherCtx, { title: 'Shared Title', bodyMd: BODY });

    const mine = await create({ title: 'Shared Title', bodyMd: BODY });

    expect(mine.slug).toBe('shared-title');
  });
});
