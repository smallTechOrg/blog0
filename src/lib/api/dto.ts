// Every API DTO (spec/api.md), one file grouped by domain section. Pure + isomorphic: imported by
// route handlers, services and admin/reader client components.

import type { FormatKind, FormatStatus } from '@/lib/formats/registry';
import type { ListenTiming } from '@/lib/listen/estimate';
import type { MarkIssueCode } from '@/lib/listen/marks';

export type { FormatKind, FormatStatus, ListenTiming, MarkIssueCode };

// ---------------------------------------------------------------------------------------------
// Shared: users, health
// ---------------------------------------------------------------------------------------------

export interface UserDto { id: string; email: string; displayName: string }

/** GET /api/health → data. DB down → 503 DB_UNAVAILABLE. */
export interface HealthDto {
  status: 'ok'; db: 'ok'; dbLatencyMs: number; version: string; uptimeSec: number;
  dbEngine: 'postgres' | 'pglite';
}

/** POST /api/auth/login */
export interface LoginRequest { email: string; password: string }
export interface LoginResponse { user: UserDto }
/** POST /api/auth/logout */
export interface LogoutResponse { signedOut: true }
/** GET /api/auth/me */
export interface MeResponse { user: UserDto }

// ---------------------------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------------------------

export type ArticleStatus = 'draft' | 'submitted' | 'approved' | 'published';

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

/** POST /api/admin/preview (bodyMd <= 200 000 chars) */
export interface PreviewRequest { title: string; dek: string; bodyMd: string }
export type PreviewResponse = PreviewResultDto;

/** GET /api/admin/articles — newest updatedAt first */
export interface ArticleListResponse { articles: ArticleListItemDto[] }

/** POST /api/admin/articles → 201; GET /api/admin/articles/:id */
export interface CreateArticleRequest { title: string; dek?: string; topic?: string; bodyMd?: string }
export interface ArticleResponse { article: ArticleDetailDto }
export type CreateArticleResponse = ArticleResponse;
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

/** POST /api/admin/articles/:id/publish and …/unpublish */
export interface PublishRequest { revisionId: string }
export type PublishResponse = ArticleResponse;
export type UnpublishResponse = ArticleResponse;
/** 422 PUBLISH_BLOCKED → error.details. Listen never blocks publishing. */
export type PublishBlockedReasonCode = 'TITLE_REQUIRED' | 'TOPIC_REQUIRED' | 'BODY_REQUIRED' | 'TLDR_DECK_STALE';
/** `sids` for TLDR_DECK_STALE. */
export interface PublishBlockedReason { code: PublishBlockedReasonCode; message: string; sids?: string[] }
export interface PublishBlockedDetails { reasons: PublishBlockedReason[] }

// ---------------------------------------------------------------------------------------------
// TLDR
// ---------------------------------------------------------------------------------------------

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
  /** False only when no OpenRouter key is configured (designer mode): Generate is disabled. */
  jevAvailable: boolean;
}

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

/** 422 DECK_INVALID → error.details */
export interface DeckInvalidDetails { sids: string[] }

// ---------------------------------------------------------------------------------------------
// Listen
// ---------------------------------------------------------------------------------------------

/**
 * missing = no draft audio; ready = audio uploaded and the paragraph text unchanged since;
 * text_changed = the current paragraphs fingerprint ≠ the draft's uploadFingerprint (warning only).
 */
export type ListenStatus = Extract<FormatStatus, 'missing' | 'ready' | 'text_changed'>;
export type AudioMime = 'audio/mpeg' | 'audio/mp4';

/** One paragraph start: integer ms into the recording. */
export interface ListenMarkDto { pid: string; tMs: number }

export interface ListenParagraphDto { pid: string; index: number; text: string; kind: 'p' | 'li' | 'quote'; headingPath: string[] }

export interface ListenAudioDto {
  assetId: string; key: string;
  url: string;                                   // '/media/' + key (same-origin, relative)
  mimeType: AudioMime; bytes: number; durationMs: number;
  originalFilename: string; uploadedAt: string;
  uploadedBy: string;                            // display name
}

export interface ListenStateDto {
  status: ListenStatus;
  /** The current revision the paragraphs come from. */
  revisionId: string;
  /** Current revision, document order (all of them). */
  paragraphs: ListenParagraphDto[];
  /** Draft recording. */
  audio: ListenAudioDto | null;
  /** STORED draft marks (aligner / legacy tap data; [] normally) — not what readers get. */
  marks: ListenMarkDto[];
  /** What readers would get over the CURRENT text (resolveMarks); null without audio. */
  timing: ListenTiming | null;
  /** Paragraphs fingerprint at upload (legacy rows: syncFingerprint). */
  uploadFingerprint: string | null;
  /** === (status === 'text_changed'). */
  textChangedSinceUpload: boolean;
  /** Set by PUT …/listen only. */
  syncFingerprint: string | null;
  syncedAt: string | null;
  syncedBy: string | null;
  /** sameAudioAsDraft: published audio.key === draft audio.key. */
  published: { durationMs: number; publishedAt: string; sameAudioAsDraft: boolean } | null;
  limits: { maxAudioMb: number; maxAudioMinutes: number };
}

/** PUT /api/admin/articles/:id/listen (revisionId must be current). Aligner-facing — no admin UI caller. */
export interface ListenSaveRequest { revisionId: string; marks: ListenMarkDto[] }
/** PUT …/listen, POST …/audio, DELETE …/audio → data. */
export interface ListenResponse { listen: ListenStateDto }
/** GET …/listen → data. */
export type GetListenResponse = ListenStateDto;

/** 422 MARKS_INVALID → error.details (every reason listed). */
export interface MarksInvalidDetails {
  reasons: Array<{ code: MarkIssueCode; pid?: string; index?: number }>;
}

// ---------------------------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------------------------

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** POST /api/admin/uploads/images → 201 data. */
export interface ImageUploadResponse {
  asset: { id: string; key: string; url: string; mimeType: ImageMime; bytes: number; width: number; height: number };
  /** '![alt](/media/<key>)' or '![alt](/media/<key> "caption")'. */
  markdown: string;
}

// ---------------------------------------------------------------------------------------------
// Public (reader)
// ---------------------------------------------------------------------------------------------

/** GET /api/public/articles/:slug/tldr — published only, else 404. */
export interface PublicTldrDto {
  slug: string; title: string; topic: string; dek: string; meta: string;
  slides: Array<{ text: string }>;
  disclosure: string;
  times: { read: number; tldr: number; listen: number | null };
  shareUrl: string;
}

/** GET /api/public/articles/:slug/listen — published only, else 404. */
export interface PublicListenDto {
  slug: string; title: string; topic: string; dek: string;
  /** "<date> · <read> min read" as the deck's. */
  meta: string;
  audio: { url: string; mimeType: AudioMime; durationMs: number };
  /** resolveMarks(published stored marks, published revision's paragraphs, durationMs) — per request. */
  marks: ListenMarkDto[];
  timing: ListenTiming;
  bylineName: string;
  times: { read: number; tldr: number | null; listen: number };
  /** Absolute …/p/<slug>/listen. */
  shareUrl: string;
}

// ---------------------------------------------------------------------------------------------
// Site settings + newsletter
// ---------------------------------------------------------------------------------------------

/** The admin-editable part of the site record (wordmark, slug, timezone are not editable here). */
export interface SiteSettingsDto {
  tagline: string; contactEmail: string; aboutStrap: string; aboutStand: string; aboutBodyMd: string;
  socialXUrl: string | null; socialLinkedinUrl: string | null;
}
/** GET / PATCH /api/admin/site → data. */
export interface SiteSettingsResponse { site: SiteSettingsDto }
/**
 * PATCH body: any subset. Texts are trimmed; required texts must be non-blank; social URLs are
 * http(s) or blank/null (blank clears it, and the footer hides that icon). Unknown keys → 400.
 */
export type SiteSettingsPatch = Partial<SiteSettingsDto>;

/** Max lengths, shared by the server schema and the admin form. */
export const SITE_SETTINGS_LIMITS = {
  tagline: 160,
  contactEmail: 254,
  aboutStrap: 120,
  aboutStand: 400,
  aboutBodyMd: 10_000,
  socialUrl: 500,
} as const;

/** POST /api/newsletter — also returned for an already-subscribed address (no enumeration). */
export interface NewsletterSubscribeResponse { subscribed: true }

/** GET /api/admin/subscribers (admin) — `?format=csv` downloads CSV instead. */
export interface SubscriberDto { email: string; name: string | null; createdAt: string; status: 'subscribed' | 'unsubscribed' }
export interface SubscriberListResponse { subscribers: SubscriberDto[]; total: number }
