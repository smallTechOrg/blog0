import 'server-only';

import { and, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { IssuePost } from '@/lib/api/dto';
import { fmtDate } from '@/lib/format-date';

import { getConfig } from '../../config';
import { getRenderedRevision } from '../../content';
import type { Executor } from '../../db/client';
import { article, articleFormat, articleRevision } from '../../db/schema';
import { readListenPayload, readTldrPayload } from '../../formats/payload';
import { ApiError } from '../../http/api';
import { articlePath, publishedWhere } from '../../public/articles';

import { excerptFrom } from './excerpt';

// Issue post snapshots (spec/architecture.md §13.5 snapshot.ts): built from the PUBLISHED revision
// and the PUBLISHED format payloads only — exactly what a reader sees — with absolute links under
// BLOG0_PUBLIC_BASE_URL. A draft issue re-snapshots on every preview; a sent one is frozen.

const listenFormat = alias(articleFormat, 'issue_listen_format');

function absolute(path: string): string {
  return getConfig().publicBaseUrl.replace(/\/+$/, '') + path;
}

export function postsInvalid(articleIds: string[], message: string): ApiError {
  return new ApiError('ISSUE_POSTS_INVALID', 422, message, { articleIds });
}

/**
 * `IssuePost[]` in the order given. Duplicates, unknown or unpublished ids → 422
 * `ISSUE_POSTS_INVALID` with `details.articleIds` naming the offending ids.
 */
export async function snapshotPosts(db: Executor, siteId: string, articleIds: string[], timezone: string): Promise<IssuePost[]> {
  const dupes = articleIds.filter((id, i) => articleIds.indexOf(id) !== i);
  if (dupes.length > 0) throw postsInvalid([...new Set(dupes)], 'Each article can appear only once in an issue.');
  if (articleIds.length === 0) return [];

  const rows = await db
    .select({
      id: article.id,
      slug: article.slug,
      topic: article.topic,
      firstPublishedAt: article.firstPublishedAt,
      revisionId: articleRevision.id,
      title: articleRevision.title,
      dek: articleRevision.dek,
      bodyMd: articleRevision.bodyMd,
      deckPayload: articleFormat.publishedPayload,
      listenPayload: listenFormat.publishedPayload,
    })
    .from(article)
    .innerJoin(articleRevision, eq(articleRevision.id, article.publishedRevisionId))
    .leftJoin(articleFormat, and(eq(articleFormat.articleId, article.id), eq(articleFormat.kind, 'tldr')))
    .leftJoin(listenFormat, and(eq(listenFormat.articleId, article.id), eq(listenFormat.kind, 'listen')))
    .where(and(publishedWhere(siteId), inArray(article.id, articleIds)));

  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = articleIds.filter((id) => !byId.has(id));
  if (missing.length > 0) throw postsInvalid(missing, 'Only published articles can go in an issue.');

  const posts: IssuePost[] = [];
  for (const id of articleIds) {
    const r = byId.get(id)!;
    const rendered = await getRenderedRevision(r.revisionId, { title: r.title, dek: r.dek, bodyMd: r.bodyMd });
    const path = articlePath(r.slug);
    posts.push({
      articleId: r.id,
      slug: r.slug,
      title: r.title,
      dek: r.dek,
      excerpt: excerptFrom(rendered.paragraphs),
      topic: r.topic ?? '',
      publishedLabel: r.firstPublishedAt ? fmtDate(r.firstPublishedAt, timezone) : '',
      readUrl: absolute(path),
      tldrUrl: readTldrPayload(r.deckPayload) ? absolute(`${path}/tldr`) : null,
      listenUrl: readListenPayload(r.listenPayload) ? absolute(`${path}/listen`) : null,
    });
  }
  return posts;
}

/** The stored jsonb snapshot, typed (rows are written only by this module's output). */
export function postsOf(raw: unknown): IssuePost[] {
  return Array.isArray(raw) ? (raw as IssuePost[]) : [];
}
