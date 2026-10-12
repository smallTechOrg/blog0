import 'server-only';

import type {
  ArticleDetailDto,
  ArticleListItemDto,
  DeckSlideDto,
  FormatChipDto,
  GenerationDto,
  RevisionRefDto,
  SentenceDto,
  TldrStateDto,
} from '@/lib/api/dto';
import type { RenderedArticle } from '@/lib/content/types';
import type { FormatKind } from '@/lib/formats/registry';

import { getConfig } from '../config';
import { getRenderedRevision } from '../content/cache';
import type { AiGenerationRow, ArticleFormatRow, ArticleRow, RevisionRow } from '../db/schema';
import { formatAdapters, isGenerationActive, missingSlides, readTldrPayload } from '../formats';
import { computeBounds } from '../jev/bounds';
import { getDb } from '../db/client';
import {
  findFormatRow,
  findRevision,
  formatRows,
  latestGeneration,
  revisionCount,
  siteTopics,
  userNames,
  type Executor,
} from './repo';

// Row → DTO builders (spec/api.md → Shared DTOs). Read-only; mutations live in service.ts / tldr.ts.

export const ABANDONED_CODE = 'GENERATION_ABANDONED';
export const ABANDONED_MESSAGE = 'This generation never finished (the server may have restarted) — try again.';
const UNKNOWN_USER = 'Unknown';

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Renders a saved revision through the shared LRU (revisions are immutable). */
export function renderRevision(rev: Pick<RevisionRow, 'id' | 'title' | 'dek' | 'bodyMd'>): Promise<RenderedArticle> {
  return getRenderedRevision(rev.id, { title: rev.title, dek: rev.dek, bodyMd: rev.bodyMd });
}

export function publicUrlFor(slug: string): string {
  return `${getConfig().publicBaseUrl.replace(/\/+$/, '')}/p/${slug}`;
}

export async function requireCurrentRevision(siteId: string, row: ArticleRow, db: Executor = getDb()): Promise<RevisionRow> {
  const rev = await findRevision(siteId, row.currentRevisionId, db);
  if (!rev) throw new Error(`Article ${row.id} has no current revision`);
  return rev;
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

export function articleHasUnpublishedChanges(row: ArticleRow): boolean {
  return row.status === 'published' && row.currentRevisionId !== row.publishedRevisionId;
}

export function revisionRef(rev: RevisionRow, names: Map<string, string>): RevisionRefDto {
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
    hasUnpublishedChanges: articleHasUnpublishedChanges(a),
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

interface StoredPicks {
  picks: Array<{ index: number; sid: string; reason: string }>;
}

function storedPicks(output: unknown): GenerationDto['picks'] {
  if (!output || typeof output !== 'object' || !Array.isArray((output as StoredPicks).picks)) return null;
  return (output as StoredPicks).picks.map((p) => ({ index: p.index, sid: p.sid, reason: p.reason }));
}

export function toGenerationDto(gen: AiGenerationRow, names: Map<string, string>, now: Date = new Date()): GenerationDto {
  const abandoned = gen.status === 'running' && !isGenerationActive(gen, now);
  return {
    id: gen.id,
    status: abandoned ? 'failed' : gen.status,
    model: gen.model,
    promptVersion: gen.promptVersion,
    requestedBy: names.get(gen.requestedBy) ?? UNKNOWN_USER,
    startedAt: gen.startedAt.toISOString(),
    finishedAt: iso(gen.finishedAt),
    latencyMs: gen.latencyMs,
    attempts: gen.attempts,
    promptTokens: gen.promptTokens,
    completionTokens: gen.completionTokens,
    totalTokens: gen.totalTokens,
    costUsd: gen.costUsd === null ? null : Number(gen.costUsd),
    picks: gen.status === 'succeeded' ? storedPicks(gen.output) : null,
    errorCode: abandoned ? ABANDONED_CODE : gen.errorCode,
    errorMessage: abandoned ? ABANDONED_MESSAGE : gen.errorMessage,
  };
}

export function toSentenceDtos(rendered: RenderedArticle): SentenceDto[] {
  const headingByPid = new Map(rendered.paragraphs.map((p) => [p.pid, p.headingPath]));
  return rendered.sentences.map((s) => ({
    sid: s.sid,
    index: s.index,
    pid: s.pid,
    text: s.text,
    words: s.words,
    headingPath: headingByPid.get(s.pid) ?? [],
  }));
}

const TLDR: FormatKind = 'tldr';

export async function buildTldrState(siteId: string, row: ArticleRow, now: Date = new Date(), db: Executor = getDb()): Promise<TldrStateDto> {
  const revision = await requireCurrentRevision(siteId, row, db);
  const [rendered, formatRow, gen] = await Promise.all([
    renderRevision(revision),
    findFormatRow(siteId, row.id, TLDR, db),
    latestGeneration(siteId, row.id, TLDR, db),
  ]);
  const names = await userNames(siteId, [formatRow?.draftUpdatedBy, gen?.requestedBy], db);
  const tldr = formatAdapters().find((a) => a.kind === TLDR)!;

  const draftPayload = readTldrPayload(formatRow?.draftPayload);
  let draft: TldrStateDto['draft'] = null;
  if (formatRow && draftPayload) {
    const missing = new Set(missingSlides(draftPayload.slides, rendered.sentences));
    draft = {
      slides: draftPayload.slides.map(
        (s): DeckSlideDto => ({ sid: s.sid, text: s.text, source: s.source, reason: s.reason, missing: missing.has(s.sid) }),
      ),
      revisionId: formatRow.draftRevisionId ?? revision.id,
      updatedAt: (formatRow.draftUpdatedAt ?? formatRow.updatedAt).toISOString(),
      updatedBy: (formatRow.draftUpdatedBy && names.get(formatRow.draftUpdatedBy)) || UNKNOWN_USER,
    };
  }

  const publishedPayload = readTldrPayload(formatRow?.publishedPayload);
  const published: TldrStateDto['published'] =
    formatRow && publishedPayload && formatRow.publishedAt
      ? { slides: publishedPayload.slides.map((s) => ({ text: s.text })), publishedAt: formatRow.publishedAt.toISOString() }
      : null;

  return {
    status: tldr.computeStatus({ row: formatRow, currentRevision: revision, latestGeneration: gen, now }),
    bounds: rendered.sentences.length === 0 ? null : computeBounds(rendered.sentences),
    sentences: toSentenceDtos(rendered),
    draft,
    published,
    latestGeneration: gen ? toGenerationDto(gen, names, now) : null,
  };
}
