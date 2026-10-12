// Phase 3 DTOs (spec/api.md → "Phase 3 DTOs" + "Endpoints — Phase 3"), transcribed for the
// Phase 3 slices to import. Phase 1/2 shapes stay in ./dto.ts and ./dto-phase2.ts; this file only
// adds. Pure types + the error-code constants the Listen routes answer with.

import type { FormatStatus } from './dto';

export type ListenStatus = Extract<FormatStatus, 'missing' | 'needs_sync' | 'ready' | 'stale'>;
export type AudioMime = 'audio/mpeg' | 'audio/mp4';
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** One paragraph start: integer ms into the recording. */
export interface ListenMarkDto {
  pid: string;
  tMs: number;
}

export interface ListenParagraphDto {
  pid: string;
  index: number;
  text: string;
  kind: 'p' | 'li' | 'quote';
  headingPath: string[];
}

export interface ListenAudioDto {
  assetId: string;
  key: string;
  /** '/media/' + key (same-origin, relative). */
  url: string;
  mimeType: AudioMime;
  bytes: number;
  durationMs: number;
  originalFilename: string;
  uploadedAt: string;
  /** Display name. */
  uploadedBy: string;
}

export interface ListenStateDto {
  status: ListenStatus;
  /** The current revision the paragraphs come from. */
  revisionId: string;
  /** Current revision, document order (all of them). */
  paragraphs: ListenParagraphDto[];
  /** Draft recording. */
  audio: ListenAudioDto | null;
  /** Draft marks ([] until synced); may reference vanished pids (see orphanPids). */
  marks: ListenMarkDto[];
  syncFingerprint: string | null;
  syncedAt: string | null;
  syncedBy: string | null;
  /** Current paragraphs without a mark (document order). */
  missingPids: string[];
  /** Marks whose paragraph is no longer in the text. */
  orphanPids: string[];
  published: { durationMs: number; markCount: number; publishedAt: string; matchesCurrentText: boolean } | null;
  limits: { maxAudioMb: number; maxAudioMinutes: number };
}

/** PUT /api/admin/articles/:id/listen (revisionId must be current). */
export interface ListenSaveRequest {
  revisionId: string;
  marks: ListenMarkDto[];
}
/** PUT …/listen, POST …/audio, DELETE …/audio → data. */
export interface ListenResponse {
  listen: ListenStateDto;
}
/** GET …/listen → data. */
export type GetListenResponse = ListenStateDto;

/** 422 MARKS_INVALID → error.details (every reason listed). */
export type MarkIssueCode = 'UNKNOWN_PID' | 'MISSING_PID' | 'DUPLICATE_PID' | 'OUT_OF_ORDER' | 'NOT_INCREASING' | 'OUT_OF_RANGE';
export interface MarksInvalidDetails {
  reasons: Array<{ code: MarkIssueCode; pid?: string; index?: number }>;
}

/** Error codes the Listen sync save answers with (spec/api.md → Error codes). */
export const MARKS_INVALID = 'MARKS_INVALID';
export const LISTEN_NO_AUDIO = 'LISTEN_NO_AUDIO';
export const LISTEN_STALE = 'LISTEN_STALE';

/** POST /api/admin/uploads/images → 201 data. */
export interface ImageUploadResponse {
  asset: { id: string; key: string; url: string; mimeType: ImageMime; bytes: number; width: number; height: number };
  /** '![alt](/media/<key>)' or '![alt](/media/<key> "caption")'. */
  markdown: string;
}

// Public (reader) — the Listen view model (also in src/lib/view-models.ts as ListenViewModel)
export interface PublicListenDto {
  slug: string;
  title: string;
  topic: string;
  dek: string;
  /** "<date> · <read> min read" as the deck's. */
  meta: string;
  audio: { url: string; mimeType: AudioMime; durationMs: number };
  /** Published marks over the published revision. */
  marks: ListenMarkDto[];
  bylineName: string;
  times: { read: number; tldr: number | null; listen: number };
  /** Absolute …/p/<slug>/listen. */
  shareUrl: string;
}
