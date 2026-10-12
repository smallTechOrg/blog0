// Shared DTOs + every Phase 1 request/response type, transcribed from spec/api.md.
// Pure + isomorphic (imported by route handlers and by admin client components).
// DTOs introduced in Phase N >= 2 live in src/lib/api/dto-phase<N>.ts (see spec/api.md).

import type { FormatKind, FormatStatus } from '@/lib/formats/registry';

export type { FormatKind, FormatStatus };

// ---------------------------------------------------------------------------------------------
// Shared DTOs
// ---------------------------------------------------------------------------------------------

export type ArticleStatus = 'draft' | 'submitted' | 'approved' | 'published';

export interface UserDto { id: string; email: string; displayName: string }
export interface FormatChipDto { kind: FormatKind; status: FormatStatus; published: boolean; hasUnpublishedChanges: boolean }
export interface ArticleListItemDto {
  id: string; slug: string; title: string; topic: string; status: ArticleStatus;
  formats: FormatChipDto[];                     // always all registered kinds, in registry order
  hasUnpublishedChanges: boolean;               // current_revision_id !== published_revision_id (when published)
  updatedAt: string; updatedBy: string;        // display name of the last revision author
  firstPublishedAt: string | null;
}
export interface RevisionRefDto { id: string; number: number; createdAt: string; createdBy: string }
export interface ArticleDetailDto {
  id: string; slug: string; slugLocked: boolean; status: ArticleStatus;
  topic: string; bylineName: string; isFeatured: boolean; featuredRank: number | null; inProgress: boolean;
  firstPublishedAt: string | null; lastPublishedAt: string | null;
  currentRevision: RevisionRefDto & { title: string; dek: string; bodyMd: string; wordCount: number; eligibleSentenceCount: number };
  publishedRevisionId: string | null;
  revisionCount: number;
  formats: FormatChipDto[];
  topics: string[];                              // existing topics in the site, for the datalist
  publicUrl: string | null;                      // absolute, when published
}
export interface PreviewResultDto {
  blocks: Array<{ kind: 'html'; html: string } | { kind: 'figure'; figureId: string; known: boolean }>;
  warnings: Array<{ code: string; message: string; line?: number }>;
  stats: { words: number; readMinutes: number };
  sentenceCount: number;                         // eligible
}
export interface SentenceDto { sid: string; index: number; pid: string; text: string; words: number; headingPath: string[] }
export interface DeckSlideDto { sid: string; text: string; source: 'jev' | 'writer'; reason: string | null; missing: boolean } // missing = sid/text no longer in current revision
export interface GenerationDto {
  id: string; status: 'running' | 'succeeded' | 'failed'; model: string; promptVersion: string;
  requestedBy: string; startedAt: string; finishedAt: string | null; latencyMs: number | null; attempts: number;
  promptTokens: number | null; completionTokens: number | null; totalTokens: number | null; costUsd: number | null;
  picks: Array<{ index: number; sid: string; reason: string }> | null;
  errorCode: string | null; errorMessage: string | null;
}
export interface TldrStateDto {
  status: FormatStatus;
  bounds: { min: number; max: number; target: number } | null;   // null when 0 eligible sentences
  sentences: SentenceDto[];                                       // current revision, eligible only
  draft: { slides: DeckSlideDto[]; revisionId: string; updatedAt: string; updatedBy: string } | null;
  published: { slides: Array<{ text: string }>; publishedAt: string } | null;
  latestGeneration: GenerationDto | null;
}

// ---------------------------------------------------------------------------------------------
// Scaffold endpoints
// ---------------------------------------------------------------------------------------------

/** GET /api/health → data. DB down → 503 DB_UNAVAILABLE. */
export interface HealthDto { status: 'ok'; db: 'ok'; dbLatencyMs: number; version: string; uptimeSec: number }

// ---------------------------------------------------------------------------------------------
// Phase 1 endpoints (request bodies + response `data`)
// ---------------------------------------------------------------------------------------------

/** POST /api/auth/login */
export interface LoginRequest { email: string; password: string }
export interface LoginResponse { user: UserDto }

/** POST /api/auth/logout */
export interface LogoutResponse { signedOut: true }

/** GET /api/auth/me */
export interface MeResponse { user: UserDto }

/** POST /api/admin/preview (bodyMd <= 200 000 chars) */
export interface PreviewRequest { title: string; dek: string; bodyMd: string }
export type PreviewResponse = PreviewResultDto;

/** GET /api/admin/articles — newest updatedAt first */
export interface ArticleListResponse { articles: ArticleListItemDto[] }

/** POST /api/admin/articles → 201 */
export interface CreateArticleRequest { title: string; dek?: string; topic?: string; bodyMd?: string }
export interface ArticleResponse { article: ArticleDetailDto }
export type CreateArticleResponse = ArticleResponse;

/** GET /api/admin/articles/:id */
export type GetArticleResponse = ArticleResponse;

/** PATCH /api/admin/articles/:id */
export interface UpdateArticleRequest {
  baseRevisionId: string;
  title?: string; dek?: string; bodyMd?: string; topic?: string; slug?: string; bylineName?: string;
  isFeatured?: boolean; featuredRank?: number | null; inProgress?: boolean;
}
export interface UpdateArticleResponse { article: ArticleDetailDto; revisionCreated: boolean }

/** DELETE /api/admin/articles/:id */
export interface DeleteArticleResponse { deleted: true }

/** GET /api/admin/articles/:id/tldr */
export type GetTldrResponse = TldrStateDto;

/** POST /api/admin/articles/:id/tldr/generate (revisionId must be current) */
export interface GenerateTldrRequest { revisionId: string }
export interface GenerateTldrResponse { tldr: TldrStateDto; generation: GenerationDto }
/** On a failed generation the failed GenerationDto is in error.details.generation. */
export interface GenerateTldrErrorDetails { generation: GenerationDto }

/** PUT /api/admin/articles/:id/tldr (1–12 slides; text resolved server-side from sid) */
export interface SaveDeckRequest {
  revisionId: string;
  slides: Array<{ sid: string; source: 'jev' | 'writer'; reason?: string | null }>;
}
export interface TldrResponse { tldr: TldrStateDto }
export type SaveDeckResponse = TldrResponse;

/** DELETE /api/admin/articles/:id/tldr (draft cleared; published deck untouched) */
export type ClearDeckResponse = TldrResponse;

/** POST /api/admin/articles/:id/publish */
export interface PublishRequest { revisionId: string }
export type PublishResponse = ArticleResponse;
/** 422 PUBLISH_BLOCKED → error.details */
export type PublishBlockedReasonCode = 'TITLE_REQUIRED' | 'TOPIC_REQUIRED' | 'BODY_REQUIRED' | 'TLDR_DECK_STALE' | 'LISTEN_STALE';
/** `sids` for TLDR_DECK_STALE; `missingPids` / `orphanPids` for LISTEN_STALE (Phase 3). */
export interface PublishBlockedReason { code: PublishBlockedReasonCode; message: string; sids?: string[]; missingPids?: string[]; orphanPids?: string[] }
export interface PublishBlockedDetails { reasons: PublishBlockedReason[] }

/** 422 DECK_INVALID → error.details */
export interface DeckInvalidDetails { sids: string[] }

/** POST /api/admin/articles/:id/unpublish */
export type UnpublishResponse = ArticleResponse;
