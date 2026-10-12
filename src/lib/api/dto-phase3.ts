// Phase 3 DTOs (spec/api.md → "Phase 3 DTOs" + "Endpoints — Phase 3"), transcribed for the
// Phase 3 slices to import. Phase 1/2 shapes stay in ./dto.ts and ./dto-phase2.ts; this file only
// adds. Pure types + the error-code constants the Listen routes answer with.

import type { FormatStatus } from './dto';

/**
 * Phase 3 fix: missing = no draft audio; ready = audio uploaded and the paragraph text unchanged
 * since; text_changed = the current paragraphs fingerprint ≠ the draft's uploadFingerprint
 * (warning only, never blocks publishing).
 */
export type ListenStatus = Extract<FormatStatus, 'missing' | 'ready' | 'text_changed'>;
/** resolveMarks (spec/capabilities/listen-sync.md): stored marks covering the text, else estimated. */
export type ListenTiming = 'synced' | 'estimated';
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

/** PUT /api/admin/articles/:id/listen (revisionId must be current). Aligner-facing (Phase 6) — no admin UI caller. */
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
  /** resolveMarks(published stored marks, published revision's paragraphs, durationMs) — per request, one per published paragraph. */
  marks: ListenMarkDto[];
  timing: ListenTiming;
  bylineName: string;
  times: { read: number; tldr: number | null; listen: number };
  /** Absolute …/p/<slug>/listen. */
  shareUrl: string;
}
