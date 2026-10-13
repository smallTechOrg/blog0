import 'server-only';

import type { ArticleDetailDto, ArticleListItemDto, FormatChipDto, RevisionRefDto } from '@/lib/api/dto';
import type { RenderedArticle } from '@/lib/content/types';

import { getConfig } from '../config';
import { getRenderedRevision } from '../content/cache';
import { getDb, type Executor } from '../db/client';
import type { AiGenerationRow, ArticleFormatRow, ArticleRow, RevisionRow } from '../db/schema';
import { formatAdapters } from '../formats';
import { readAdapter } from '../formats/read';
import { formatRows, latestGeneration, requireCurrentRevision, revisionCount, siteTopics, userNames } from './repo';

// Row → article DTO builders (spec/api.md → Shared DTOs). Read-only; mutations live in service.ts
// (TLDR state: tldr.ts; Listen state: src/server/listen/sync.ts).

export const UNKNOWN_USER = 'Unknown';

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Renders a saved revision through the shared LRU (revisions are immutable). */
export function renderRevision(rev: Pick<RevisionRow, 'id' | 'title' | 'dek' | 'bodyMd'>): Promise<RenderedArticle> {
  return getRenderedRevision(rev.id, { title: rev.title, dek: rev.dek, bodyMd: rev.bodyMd });
}

export function publicUrlFor(slug: string): string {
  return `${getConfig().publicBaseUrl}/p/${slug}`;
}

export function buildChips(args: {
  article: ArticleRow;
  revision: RevisionRow;
  rows: ArticleFormatRow[];
  latestTldrGeneration: AiGenerationRow | null;
  now: Date;
}): FormatChipDto[] {
  return formatAdapters().map((adapter) => {
    const row = args.rows.find((r) => r.kind === adapter.kind) ?? null;
    return {
      kind: adapter.kind,
      status: adapter.computeStatus({
        row,
        currentRevision: args.revision,
        latestGeneration: adapter.kind === 'tldr' ? args.latestTldrGeneration : null,
        now: args.now,
      }),
      published: adapter.isPublished({ article: args.article, row }),
      hasUnpublishedChanges: adapter.hasUnpublishedChanges({ article: args.article, row }),
    };
  });
}

function revisionRef(rev: RevisionRow, names: Map<string, string>): RevisionRefDto {
  return { id: rev.id, number: rev.number, createdAt: rev.createdAt.toISOString(), createdBy: names.get(rev.createdBy) ?? UNKNOWN_USER };
}

export function toListItem(args: {
  article: ArticleRow;
  revision: RevisionRow;
  chips: FormatChipDto[];
  names: Map<string, string>;
}): ArticleListItemDto {
  const { article: a, revision } = args;
  return {
    id: a.id,
    slug: a.slug,
    title: revision.title,
    topic: a.topic,
    status: a.status,
    formats: args.chips,
    hasUnpublishedChanges: readAdapter.hasUnpublishedChanges({ article: a, row: null }),
    updatedAt: a.updatedAt.toISOString(),
    updatedBy: args.names.get(revision.createdBy) ?? UNKNOWN_USER,
    firstPublishedAt: iso(a.firstPublishedAt),
  };
}

export async function buildArticleDetail(siteId: string, row: ArticleRow, now: Date = new Date(), db: Executor = getDb()): Promise<ArticleDetailDto> {
  const revision = await requireCurrentRevision(siteId, row, db);
  const [rows, gen, revCount, topics, names] = await Promise.all([
    formatRows(siteId, [row.id], db),
    latestGeneration(siteId, row.id, 'tldr', db),
    revisionCount(siteId, row.id, db),
    siteTopics(siteId, db),
    userNames(siteId, [revision.createdBy], db),
  ]);
  return {
    id: row.id,
    slug: row.slug,
    slugLocked: row.firstPublishedAt !== null,
    status: row.status,
    topic: row.topic,
    bylineName: row.bylineName,
    isFeatured: row.isFeatured,
    featuredRank: row.featuredRank,
    inProgress: row.inProgress,
    firstPublishedAt: iso(row.firstPublishedAt),
    lastPublishedAt: iso(row.lastPublishedAt),
    currentRevision: {
      ...revisionRef(revision, names),
      title: revision.title,
      dek: revision.dek,
      bodyMd: revision.bodyMd,
      wordCount: revision.wordCount,
      eligibleSentenceCount: revision.eligibleSentenceCount,
    },
    publishedRevisionId: row.publishedRevisionId,
    revisionCount: revCount,
    formats: buildChips({ article: row, revision, rows, latestTldrGeneration: gen, now }),
    topics,
    publicUrl: row.status === 'published' ? publicUrlFor(row.slug) : null,
  };
}
