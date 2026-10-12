import 'server-only';

import type { RenderedArticle } from '@/lib/content/types';
import type { FormatKind, FormatStatus } from '@/lib/formats/registry';

import type { Tx } from '../db/client';
import type { AiGenerationRow, ArticleFormatRow, ArticleRow, RevisionRow } from '../db/schema';

// Format adapter contract (spec/architecture.md §5). One adapter per kind in FORMAT_KINDS,
// registered in src/server/formats/index.ts. Status is computed, never stored.

export type PublishCheck = { ok: true } | { ok: false; code: string; message: string; details?: unknown };

export interface StatusContext {
  row: ArticleFormatRow | null;
  currentRevision: RevisionRow;
  latestGeneration?: AiGenerationRow | null;
  now: Date;
}

export interface ChipContext {
  article: Pick<ArticleRow, 'status' | 'currentRevisionId' | 'publishedRevisionId'>;
  row: ArticleFormatRow | null;
}

export interface FormatAdapter {
  kind: FormatKind;
  computeStatus(ctx: StatusContext): FormatStatus;
  /** Readers currently get this format (article published and the format has published content). */
  isPublished(ctx: ChipContext): boolean;
  /** The writer's working copy differs from what readers get (only meaningful while published). */
  hasUnpublishedChanges(ctx: ChipContext): boolean;
  validateForPublish(ctx: { row: ArticleFormatRow | null; revision: RevisionRow; rendered: RenderedArticle }): PublishCheck;
  publish(tx: Tx, ctx: { row: ArticleFormatRow | null; revision: RevisionRow; userId: string; now: Date }): Promise<void>;
}

/** A `running` generation older than this is abandoned: it no longer blocks or shows as generating. */
export const GENERATION_STALE_MS = 3 * 60 * 1000;

export function isGenerationActive(gen: Pick<AiGenerationRow, 'status' | 'startedAt'> | null | undefined, now: Date): boolean {
  return !!gen && gen.status === 'running' && now.getTime() - gen.startedAt.getTime() < GENERATION_STALE_MS;
}
