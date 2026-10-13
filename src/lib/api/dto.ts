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

/** GET /api/health/live → data. Always 200 while the process serves; never touches the DB. */
export interface HealthLiveDto { status: 'live'; version: string; uptimeSec: number; shuttingDown: boolean }

/** GET /api/health/ready → data. Not ready → 503 NOT_READY with `NotReadyDetails`. */
export interface HealthReadyDto {
  status: 'ready'; db: 'ok'; dbLatencyMs: number; dbEngine: 'postgres' | 'pglite';
  migrations: { applied: number; pending: 0; latest: string | null };
  version: string;
}

/** `error.details` of a 503 NOT_READY from /api/health/ready. */
export interface NotReadyDetails {
  reason: 'SHUTTING_DOWN' | 'DB_UNAVAILABLE' | 'MIGRATIONS_PENDING';
  pending?: string[];
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

// Phase 8: `reason` is gone from every TLDR DTO; `relevance` (Jev's score in [0,1], or null when the sentence
// has no score in the article's latest succeeded generation — never scored, changed since, or a pre-Phase-8 generation)
// takes its place. Source of every relevance value: spec/architecture.md §3 "Relevance in the editor".
export interface SentenceDto { sid: string; index: number; pid: string; text: string; words: number; headingPath: string[]; relevance: number | null }
export interface DeckSlideDto { sid: string; text: string; source: 'jev' | 'writer'; relevance: number | null; missing: boolean } // missing = sid/text no longer in current revision
export interface GenerationDto {
  id: string; status: 'running' | 'succeeded' | 'failed'; model: string; promptVersion: string;
  requestedBy: string; startedAt: string; finishedAt: string | null; latencyMs: number | null;
  attempts: number;                              // decisions requests sent (1 unless the article was batched)
  sentenceCount: number;                         // sentences sent to Jev (= scored on success)
  promptTokens: number | null; completionTokens: number | null; totalTokens: number | null; costUsd: number | null;   // input / output / sum
  picks: Array<{ index: number; sid: string; relevance: number | null }> | null;   // the k selected sentences, document order; null unless succeeded
                                                                                    // (legacy generations: their picks with relevance null)
  errorCode: string | null; errorMessage: string | null;
}
export interface TldrStateDto {
  status: FormatStatus;
  bounds: { min: number; max: number; target: number } | null;   // null when 0 eligible sentences
  sentences: SentenceDto[];                                       // current revision, eligible only, DOCUMENT order (the client sorts by relevance)
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

/**
 * PUT /api/admin/articles/:id/tldr (1–12 slides; text resolved server-side from sid).
 * A legacy `reason` key is stripped, not refused; relevance is never accepted from the client.
 */
export interface SaveDeckRequest {
  revisionId: string;
  slides: Array<{ sid: string; source: 'jev' | 'writer' }>;
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
// Site settings
// ---------------------------------------------------------------------------------------------

/** The admin-editable part of the site record (wordmark, slug, timezone are not editable here). */
export interface SiteSettingsDto {
  tagline: string; contactEmail: string; aboutStrap: string; aboutStand: string; aboutBodyMd: string;
  socialXUrl: string | null; socialLinkedinUrl: string | null;
  /** Phase 7: read-only here — edited via PATCH /api/admin/newsletter/settings. */
  newsletter: NewsletterSettingsDto;
}
/** GET / PATCH /api/admin/site → data. */
export interface SiteSettingsResponse { site: SiteSettingsDto }
/**
 * PATCH body: any subset of the editable fields (never `newsletter`). Texts are trimmed; required
 * texts must be non-blank; social URLs are http(s) or blank/null (blank clears it, and the footer
 * hides that icon). Unknown keys → 400.
 */
export type SiteSettingsPatch = Partial<Omit<SiteSettingsDto, 'newsletter'>>;

/** Max lengths, shared by the server schema and the admin form. */
export const SITE_SETTINGS_LIMITS = {
  tagline: 160,
  contactEmail: 254,
  aboutStrap: 120,
  aboutStand: 400,
  aboutBodyMd: 10_000,
  socialUrl: 500,
} as const;

// ---------------------------------------------------------------------------------------------
// Newsletter (Phase 7 — spec/api.md "Newsletter DTOs"; owned by slice S7.1, imported by S7.3/S7.4)
// ---------------------------------------------------------------------------------------------

export type SubscriberStatus = 'pending' | 'confirmed' | 'unsubscribed' | 'bounced' | 'legacy_unconfirmed';
export type SubscriberEventKind =
  | 'signup' | 'confirmation_sent' | 'confirmed' | 'resubscribed' | 'unsubscribed' | 'bounced'
  | 'legacy_confirmation_sent' | 'provider_synced' | 'provider_removed' | 'ip_pruned';
export type NewsletterSource = 'footer' | 'email_link' | 'one_click' | 'admin' | 'provider' | 'webhook' | 'migration' | 'system';
export type SuppressionReason = 'unsubscribed' | 'bounced' | 'complaint' | 'admin';

/** POST /api/newsletter — the same shape for a new, pending, confirmed or suppressed address (no enumeration). */
export interface NewsletterSubscribeRequest { email: string; name?: string; sourceUrl?: string }
export interface NewsletterSubscribeResponse { subscribed: true }

/** POST /api/newsletter/confirm → data. */
export interface NewsletterConfirmRequest { token: string }
export interface NewsletterConfirmResponse { confirmed: true; alreadyConfirmed: boolean }
/** POST /api/newsletter/unsubscribe → data (JSON `{ token }` or RFC 8058 one-click with `?t=`). */
export interface NewsletterUnsubscribeRequest { token: string }
export interface NewsletterUnsubscribeResponse { unsubscribed: true; alreadyUnsubscribed: boolean }

/** GET /api/admin/subscribers rows (the CSV uses the same fields). */
export interface SubscriberDto {
  id: string; email: string; name: string | null; status: SubscriberStatus; source: string;
  createdAt: string; consentedAt: string | null; confirmedAt: string | null; unsubscribedAt: string | null;
  /** status === 'pending' && confirm_token_expires_at < now */
  pendingExpired: boolean;
  consentVersion: string | null; sourceUrl: string | null;
  providerSyncedAt: string | null;
  /** legacy: not yet sent; pending: under the 3-per-24 h cap */
  canSendConfirmation: boolean;
}
export interface SubscriberCounts { all: number; pending: number; confirmed: number; unsubscribed: number; bounced: number; legacy_unconfirmed: number }
export interface SubscriberListResponse { subscribers: SubscriberDto[]; total: number; counts: SubscriberCounts; now: string }

export interface SubscriberEventDto {
  id: string; kind: SubscriberEventKind; source: NewsletterSource; actor: string | null;
  ip: string | null; userAgent: string | null; details: Record<string, unknown>; createdAt: string;
}
export interface SuppressionDto { id: string; reason: SuppressionReason; source: NewsletterSource; details: Record<string, unknown>; createdAt: string }
export interface SubscriberMessageDto { id: string; kind: 'confirmation' | 'issue'; subject: string; transport: string; status: string; createdAt: string }
export interface SubscriberDetailDto extends SubscriberDto {
  signupIp: string | null; signupUserAgent: string | null; consentText: string | null;
  confirmedIp: string | null; confirmedUserAgent: string | null; confirmTokenExpiresAt: string | null;
  confirmationSentCount: number; legacyConfirmationSentAt: string | null; providerId: string | null; ipPrunedAt: string | null;
  /** oldest first */
  events: SubscriberEventDto[];
  /** for this email, oldest first */
  suppressions: SuppressionDto[];
  messages: SubscriberMessageDto[];
}
export interface SubscriberDetailResponse { subscriber: SubscriberDetailDto }

/** POST /api/admin/subscribers/:id/send-confirmation → data. */
export interface SendConfirmationResponse { subscriber: SubscriberDetailDto; sentTo: string; transport: 'smtp' | 'stub' }
/** POST /api/admin/subscribers/send-legacy-confirmations. */
export interface SendLegacyConfirmationsRequest { confirm: true }
export interface SendLegacyConfirmationsResponse { sent: number; skipped: number }
/** POST /api/admin/subscribers/:id/unsubscribe. */
export interface AdminUnsubscribeRequest { note?: string }
export interface AdminUnsubscribeResponse { subscriber: SubscriberDetailDto }

/** GET /api/admin/subscribers?format=audit — the whole proof bundle. */
export interface NewsletterAuditBundle {
  format: 'blog0-newsletter-audit/1'; exportedAt: string; exportedBy: string; site: { slug: string; brandName: string };
  settings: NewsletterSettingsDto;
  subscribers: Array<Omit<SubscriberDetailDto, 'messages' | 'canSendConfirmation' | 'pendingExpired'>>;
  suppressions: Array<SuppressionDto & { email: string; subscriberId: string }>;
}

export type NewsletterMode = 'per_post' | 'digest' | 'manual';
export interface NewsletterSettingsDto {
  mode: NewsletterMode; autoSend: boolean; digestDays: number; digestPosts: number;
  consentText: string; consentVersion: string; modeSetAt: string | null;
}
/** PATCH /api/admin/newsletter/settings body — `modeSetAt` is server-set and rejected. */
export type NewsletterSettingsPatch = Partial<Omit<NewsletterSettingsDto, 'modeSetAt'>>;
export interface NewsletterStatusDto {
  sender: { kind: 'listmonk' | 'stub'; configured: boolean; listId: string | null; listName: string | null; lastSyncAt: string | null; healthy: boolean | null; message: string | null };
  mail: { transport: 'smtp' | 'stub'; from: string | null };
  counts: SubscriberCounts;
  /** only in digest mode */
  digest: { lastIssueAt: string | null; newPostsSince: number; dueAt: string | null } | null;
}
export interface NewsletterSettingsResponse { settings: NewsletterSettingsDto; status: NewsletterStatusDto }
export const NEWSLETTER_SETTINGS_LIMITS = {
  consentText: 300,
  consentVersion: 20,
  digestDays: [1, 60],
  digestPosts: [1, 20],
  issueTitle: 150,
  issueIntroMd: 5_000,
  issuePosts: [1, 10],
} as const;

/** POST /api/admin/newsletter/sync. */
export interface NewsletterSyncRequest { confirm: true }
/** `suppressedFromProvider`: confirmed rows suppressed in blog0 because the provider holds a newer opt-out (never re-added). */
export interface NewsletterSyncResponse { synced: number; blocklisted: number; skipped: number; suppressedFromProvider: number; changed: number; errors: Array<{ email: string; message: string }> }

export type IssueStatus = 'draft' | 'sending' | 'sent' | 'failed';
export type IssueOrigin = NewsletterMode;
export type IssueEventKind =
  | 'created' | 'updated' | 'test_sent' | 'send_requested' | 'provider_created' | 'provider_started'
  | 'sent' | 'failed' | 'stats_fetched' | 'deleted';
export interface IssuePost {
  articleId: string; slug: string; title: string; dek: string; excerpt: string; topic: string; publishedLabel: string;
  readUrl: string; tldrUrl: string | null; listenUrl: string | null;
}
export interface IssueStatsDto {
  recipients: number; sent: number; delivered: number | null; opens: number | null; clicks: number | null;
  bounces: number | null; unsubscribes: number | null; fetchedAt: string;
}
export interface IssueListItemDto {
  id: string; number: number; status: IssueStatus; origin: IssueOrigin; title: string; postCount: number;
  recipientCount: number | null; createdAt: string; sentAt: string | null; lastError: string | null;
}
export interface IssueListResponse { issues: IssueListItemDto[]; total: number; confirmedCount: number }
export interface IssueEventDto { id: string; kind: IssueEventKind; actor: string | null; details: Record<string, unknown>; createdAt: string }
export interface IssueDetailDto extends IssueListItemDto {
  introMd: string; posts: IssuePost[]; providerCampaignId: string | null; stats: IssueStatsDto | null;
  createdBy: string | null; sentBy: string | null;
  /** oldest first */
  events: IssueEventDto[];
  /** status === 'draft' */
  editable: boolean;
  /** status === 'sending' with no progress for 10 min (crashed send): Try again is offered and allowed. */
  stuckSending: boolean;
}
export interface IssueDetailResponse { issue: IssueDetailDto }
export interface IssueCreateRequest { title: string; introMd?: string; articleIds: string[] }
/** articleIds = new order / subset (manual + automatic drafts alike). */
export interface IssueUpdateRequest { title?: string; introMd?: string; articleIds?: string[] }
export interface IssuePreviewDto { subject: string; html: string; text: string; sampleRecipient: { email: string; consentLine: string } }
export interface IssueSendRequest { confirm: true }
export interface IssueTestResponse { sentTo: string; transport: 'smtp' | 'stub'; messageId: string }
export interface IssueDeleteResponse { deleted: true }
/** 422 ISSUE_POSTS_INVALID → error.details. */
export interface IssuePostsInvalidDetails { articleIds: string[] }
export interface NewsletterWebhookRequest { event: 'unsubscribe' | 'bounce' | 'complaint'; email: string; reason?: string; occurredAt?: string; providerRef?: string }
export interface NewsletterWebhookResponse { accepted: boolean }
