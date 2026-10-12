import 'server-only';

import { z } from 'zod';

// Format payload shapes (spec/data.md → article_format), validated with zod on write and read.

export const TLDR_MIN_SLIDES = 1;
export const TLDR_MAX_SLIDES = 12;
export const TLDR_REASON_MAX = 200;

export const tldrSlideSchema = z.object({
  sid: z.string().min(1),
  text: z.string().min(1),
  source: z.enum(['jev', 'writer']),
  reason: z.string().max(TLDR_REASON_MAX).nullable(),
});

export const tldrPayloadSchema = z.object({
  slides: z.array(tldrSlideSchema).min(TLDR_MIN_SLIDES).max(TLDR_MAX_SLIDES),
  generationId: z.string().uuid().nullable(),
});

export type TldrSlide = z.infer<typeof tldrSlideSchema>;
export type TldrPayload = z.infer<typeof tldrPayloadSchema>;

/** Parses a stored payload; a corrupt/unknown payload reads as "no deck" (never crashes a page). */
export function readTldrPayload(value: unknown): TldrPayload | null {
  if (value === null || value === undefined) return null;
  const parsed = tldrPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------------------------
// listen (Phase 3 + fix, spec/data.md → ListenPayload). A row exists from the first upload; draft
// null after Remove audio. `marks` are STORED marks written only by PUT …/listen (Phase 6 aligner;
// legacy tap data) — [] normally, cleared on every upload. `uploadFingerprint` = the paragraphs
// fingerprint at upload (drives `text_changed`); legacy rows parse with null and fall back to
// `syncFingerprint` (listenBaseline). Phase 6 adds optional `sentenceMarks` beside `marks`
// (unknown keys are stripped, not refused).
// ---------------------------------------------------------------------------------------------

export const AUDIO_MIMES = ['audio/mpeg', 'audio/mp4'] as const;

export const listenAudioSchema = z.object({
  assetId: z.string().uuid(),
  key: z.string().min(1).max(160),
  mimeType: z.enum(AUDIO_MIMES),
  bytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});

export const listenMarkSchema = z.object({
  pid: z.string().min(1).max(64),
  tMs: z.number().int().nonnegative(),
});

export const listenPayloadSchema = z.object({
  audio: listenAudioSchema,
  marks: z.array(listenMarkSchema),
  syncFingerprint: z.string().min(1).nullable(),
  uploadFingerprint: z.string().nullable().optional().default(null),
});

export type ListenAudio = z.infer<typeof listenAudioSchema>;
export type ListenMark = z.infer<typeof listenMarkSchema>;
export type ListenPayload = z.infer<typeof listenPayloadSchema>;

/** The fingerprint the `text_changed` warning compares against: uploadFingerprint, else (legacy) syncFingerprint. */
export function listenBaseline(payload: Pick<ListenPayload, 'uploadFingerprint' | 'syncFingerprint'>): string | null {
  return payload.uploadFingerprint ?? payload.syncFingerprint ?? null;
}

/** Parses a stored Listen payload; a corrupt/unknown payload reads as "no draft" (never crashes a page). */
export function readListenPayload(value: unknown): ListenPayload | null {
  if (value === null || value === undefined) return null;
  const parsed = listenPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
