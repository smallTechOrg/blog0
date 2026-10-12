import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';

import type {
  ArticleDetailDto,
  ArticleListItemDto,
  PreviewResultDto,
  PublishBlockedDetails,
  PublishBlockedReasonCode,
} from '@/lib/api/dto';
import type { RenderedArticle, RenderInput } from '@/lib/content/types';

import type { SessionUser } from '../auth/session';
import { getRenderedRevision } from '../content/cache';
import { renderArticle } from '../content/render';
import { getDb, type Tx } from '../db/client';
import { article, articleRevision, type ArticleRow, type RevisionRow } from '../db/schema';
import { formatAdapters } from '../formats';
import { ApiError } from '../http/api';
import { log } from '../log';
import {
  findArticle,
  findRevision,
  formatRows,
  latestGenerations,
  listArticlesWithRevision,
  lockArticle,
  nextRevisionNumber,
  slugInUse,
  takenSlugs,
  userNames,
} from './repo';
import type { CreateArticleBody, UpdateArticleBody } from './schemas';
import { slugify, uniqueSlug } from './slug';
import { buildArticleDetail, buildChips, renderRevision, toListItem } from './views';

// Article lifecycle (spec/architecture.md §3): create (revision 1), save (a revision only when
// title/dek/body changed), publish/unpublish, delete a never-published draft. Publishing never
// calls the AI.

export interface ActorContext {
  siteId: string;
  user: SessionUser;
}

export function notFound(id: string): ApiError {
  return new ApiError('NOT_FOUND', 404, `Article ${String(id).slice(0, 40)} not found.`);
}

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}

// ---------------------------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------------------------

export async function previewArticle(input: RenderInput): Promise<PreviewResultDto> {
  const rendered = await renderArticle(input);
  return {
    blocks: rendered.blocks,
    warnings: rendered.warnings,
    stats: rendered.stats,
    sentenceCount: rendered.sentences.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export async function listArticles(siteId: string, now: Date = new Date()): Promise<ArticleListItemDto[]> {
  const db = getDb();
  const rows = await listArticlesWithRevision(siteId, db);
  const ids = rows.map((r) => r.article.id);
  const [formats, gens, names] = await Promise.all([
    formatRows(siteId, ids, db),
    latestGenerations(siteId, ids, 'tldr', db),
    userNames(siteId, rows.map((r) => r.revision?.createdBy), db),
  ]);
  const items: ArticleListItemDto[] = [];
  for (const { article: a, revision } of rows) {
    if (!revision) continue; // only possible mid-create inside a transaction
    items.push(
      toListItem({
        article: a,
        revision,
        names,
        chips: buildChips({
          article: a,
          revision,
          rows: formats.filter((f) => f.articleId === a.id),
          latestTldrGeneration: gens.get(a.id) ?? null,
          now,
        }),
      }),
    );
  }
  return items;
}

export async function getArticleDetail(siteId: string, id: string): Promise<ArticleDetailDto> {
  const row = await findArticle(siteId, id);
  if (!row) throw notFound(id);
  return buildArticleDetail(siteId, row);
}

// ---------------------------------------------------------------------------------------------
// Create + save
// ---------------------------------------------------------------------------------------------

async function insertRevision(
  tx: Tx,
  args: { siteId: string; articleId: string; userId: string; content: RenderInput },
): Promise<RevisionRow> {
  const rendered = await renderArticle(args.content);
  const number = await nextRevisionNumber(tx, args.siteId, args.articleId);
  const [rev] = await tx
    .insert(articleRevision)
    .values({
      siteId: args.siteId,
      articleId: args.articleId,
      number,
      title: args.content.title,
      dek: args.content.dek,
      bodyMd: args.content.bodyMd,
      bodyFingerprint: rendered.fingerprints.body,
      paragraphsFingerprint: rendered.fingerprints.paragraphs,
      sentencesFingerprint: rendered.fingerprints.sentences,
      wordCount: rendered.stats.words,
      eligibleSentenceCount: rendered.sentences.length,
      createdBy: args.userId,
    })
    .returning();
  // Prime the render cache (revisions are immutable; harmless if the transaction rolls back).
  void getRenderedRevision(rev.id, args.content).catch(() => {});
  return rev;
}

export async function createArticle(ctx: ActorContext, body: CreateArticleBody): Promise<ArticleDetailDto> {
  const content: RenderInput = { title: body.title, dek: body.dek ?? '', bodyMd: body.bodyMd ?? '' };
  const base = slugify(content.title);
  const db = getDb();

  for (let attempt = 1; ; attempt += 1) {
    try {
      const id = await db.transaction(async (tx) => {
        const slug = uniqueSlug(base, await takenSlugs(ctx.siteId, base, null, tx));
        const [row] = await tx
          .insert(article)
          .values({
            siteId: ctx.siteId,
            slug,
            topic: body.topic ?? '',
            bylineName: ctx.user.displayName,
            createdBy: ctx.user.id,
          })
          .returning({ id: article.id });
        const rev = await insertRevision(tx, { siteId: ctx.siteId, articleId: row.id, userId: ctx.user.id, content });
        await tx.update(article).set({ currentRevisionId: rev.id }).where(and(eq(article.id, row.id), eq(article.siteId, ctx.siteId)));
        return row.id;
      });
      return getArticleDetail(ctx.siteId, id);
    } catch (error) {
      // Two creates racing for the same derived slug: the loser retries with a fresh suffix.
      if (pgCode(error) === '23505' && attempt < 3) continue;
      throw error;
    }
  }
}

function conflictError(current: RevisionRow, savedBy: string): ApiError {
  return new ApiError(
    'CONFLICT',
    409,
    `A newer version (rev ${current.number}) was saved by ${savedBy} at ${current.createdAt.toISOString()}. Reload to see it — nothing was overwritten.`,
    { currentRevisionId: current.id, currentRevisionNumber: current.number, savedBy },
  );
}

async function assertCurrentRevision(tx: Tx, siteId: string, row: ArticleRow, revisionId: string): Promise<RevisionRow> {
  const current = await findRevision(siteId, row.currentRevisionId, tx);
  if (!current) throw new Error(`Article ${row.id} has no current revision`);
  if (current.id !== revisionId) {
    const names = await userNames(siteId, [current.createdBy], tx);
    throw conflictError(current, names.get(current.createdBy) ?? 'another writer');
  }
  return current;
}

export async function updateArticle(
  ctx: ActorContext,
  id: string,
  body: UpdateArticleBody,
): Promise<{ article: ArticleDetailDto; revisionCreated: boolean }> {
  try {
    const revisionCreated = await getDb().transaction(async (tx) => {
      const row = await lockArticle(tx, ctx.siteId, id);
      if (!row) throw notFound(id);
      const current = await assertCurrentRevision(tx, ctx.siteId, row, body.baseRevisionId);

      const content: RenderInput = {
        title: body.title ?? current.title,
        dek: body.dek ?? current.dek,
        bodyMd: body.bodyMd ?? current.bodyMd,
      };
      const contentChanged =
        content.title !== current.title || content.dek !== current.dek || content.bodyMd !== current.bodyMd;

      const patch: Partial<typeof article.$inferInsert> = {};
      if (body.topic !== undefined && body.topic !== row.topic) patch.topic = body.topic;
      if (body.bylineName !== undefined && body.bylineName !== row.bylineName) patch.bylineName = body.bylineName;
      if (body.isFeatured !== undefined && body.isFeatured !== row.isFeatured) patch.isFeatured = body.isFeatured;
      if (body.featuredRank !== undefined && body.featuredRank !== row.featuredRank) patch.featuredRank = body.featuredRank;
      if (body.inProgress !== undefined && body.inProgress !== row.inProgress) patch.inProgress = body.inProgress;

      if (body.slug !== undefined && body.slug !== row.slug) {
        if (row.firstPublishedAt) {
          throw new ApiError('SLUG_LOCKED', 409, `The slug can't change after the first publish (it stays '${row.slug}').`);
        }
        if (await slugInUse(ctx.siteId, body.slug, row.id, tx)) {
          throw new ApiError('SLUG_TAKEN', 409, `The slug '${body.slug}' is already used by another article.`);
        }
        patch.slug = body.slug;
        patch.slugIsCustom = true;
      } else if (body.slug === undefined && !row.slugIsCustom && !row.firstPublishedAt && content.title !== current.title) {
        // Never published + slug never set by hand → the slug follows the title.
        const base = slugify(content.title);
        const derived = uniqueSlug(base, await takenSlugs(ctx.siteId, base, row.id, tx));
        if (derived !== row.slug) patch.slug = derived;
      }

      if (contentChanged) {
        const rev = await insertRevision(tx, { siteId: ctx.siteId, articleId: row.id, userId: ctx.user.id, content });
        patch.currentRevisionId = rev.id;
      }
      if (Object.keys(patch).length > 0) {
        await tx.update(article).set(patch).where(and(eq(article.id, row.id), eq(article.siteId, ctx.siteId)));
      }
      return contentChanged;
    });
    return { article: await getArticleDetail(ctx.siteId, id), revisionCreated };
  } catch (error) {
    if (pgCode(error) === '23505') throw new ApiError('SLUG_TAKEN', 409, 'That slug was just taken by another article — try another.');
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------------------------

export async function deleteArticle(ctx: ActorContext, id: string): Promise<{ deleted: true }> {
  const row = await findArticle(ctx.siteId, id);
  if (!row) throw notFound(id);
  const deleted = await getDb()
    .delete(article)
    .where(and(eq(article.id, row.id), eq(article.siteId, ctx.siteId), isNull(article.firstPublishedAt)))
    .returning({ id: article.id });
  if (deleted.length === 0) {
    throw new ApiError('NOT_DELETABLE', 409, 'This article has been published, so it can’t be deleted. Unpublish it to hide it from readers.');
  }
  return { deleted: true };
}

// ---------------------------------------------------------------------------------------------
// Publish / unpublish
// ---------------------------------------------------------------------------------------------

type Reason = PublishBlockedDetails['reasons'][number];

async function publishReasons(
  siteId: string,
  row: ArticleRow,
  revision: RevisionRow,
  rendered: RenderedArticle,
  tx: Tx,
): Promise<Reason[]> {
  const reasons: Reason[] = [];
  if (revision.title.trim() === '') reasons.push({ code: 'TITLE_REQUIRED', message: 'Add a title before publishing.' });
  if (row.topic.trim() === '') reasons.push({ code: 'TOPIC_REQUIRED', message: 'Choose a topic before publishing.' });
  if (revision.bodyMd.trim() === '') reasons.push({ code: 'BODY_REQUIRED', message: 'The article body is empty.' });
  const rows = await formatRows(siteId, [row.id], tx);
  for (const adapter of formatAdapters()) {
    const check = adapter.validateForPublish({ row: rows.find((r) => r.kind === adapter.kind) ?? null, revision, rendered });
    if (!check.ok) {
      const details = (check.details ?? {}) as { sids?: string[]; missingPids?: string[]; orphanPids?: string[] };
      reasons.push({
        code: check.code as PublishBlockedReasonCode,
        message: check.message,
        ...(details.sids ? { sids: details.sids } : {}),
        ...(details.missingPids ? { missingPids: details.missingPids } : {}),
        ...(details.orphanPids ? { orphanPids: details.orphanPids } : {}),
      });
    }
  }
  return reasons;
}

export async function publishArticle(ctx: ActorContext, id: string, revisionId: string, now: Date = new Date()): Promise<ArticleDetailDto> {
  await getDb().transaction(async (tx) => {
    const row = await lockArticle(tx, ctx.siteId, id);
    if (!row) throw notFound(id);
    const revision = await assertCurrentRevision(tx, ctx.siteId, row, revisionId);
    const rendered = await renderRevision(revision);

    const reasons = await publishReasons(ctx.siteId, row, revision, rendered, tx);
    if (reasons.length > 0) {
      throw new ApiError(
        'PUBLISH_BLOCKED',
        422,
        `This article can't be published yet: ${reasons.map((r) => r.message).join(' ')}`,
        { reasons } satisfies PublishBlockedDetails,
      );
    }

    let contentUpdatedAt = row.contentUpdatedAt;
    if (row.firstPublishedAt && row.publishedRevisionId && row.publishedRevisionId !== revision.id) {
      const previous = await findRevision(ctx.siteId, row.publishedRevisionId, tx);
      if (!previous || previous.bodyFingerprint !== revision.bodyFingerprint) contentUpdatedAt = now;
    }

    await tx
      .update(article)
      .set({
        status: 'published',
        publishedRevisionId: revision.id,
        firstPublishedAt: row.firstPublishedAt ?? now,
        lastPublishedAt: now,
        contentUpdatedAt,
      })
      .where(and(eq(article.id, row.id), eq(article.siteId, ctx.siteId)));

    const rows = await formatRows(ctx.siteId, [row.id], tx);
    for (const adapter of formatAdapters()) {
      await adapter.publish(tx, { row: rows.find((r) => r.kind === adapter.kind) ?? null, revision, userId: ctx.user.id, now });
    }
    log.info('article.publish', {
      article_id: row.id,
      revision_id: revision.id,
      revision_number: revision.number,
      user_id: ctx.user.id,
      first_publish: row.firstPublishedAt === null,
    });
  });
  return getArticleDetail(ctx.siteId, id);
}

export async function unpublishArticle(ctx: ActorContext, id: string): Promise<ArticleDetailDto> {
  const row = await findArticle(ctx.siteId, id);
  if (!row) throw notFound(id);
  if (row.status === 'published') {
    await getDb()
      .update(article)
      .set({ status: 'draft' })
      .where(and(eq(article.id, row.id), eq(article.siteId, ctx.siteId)));
    log.info('article.unpublish', { article_id: row.id, user_id: ctx.user.id });
  }
  return getArticleDetail(ctx.siteId, id);
}

