import 'server-only';

import { z } from 'zod';

// Format payload shapes (spec/data.md → article_format), validated with zod on write and read.

export const TLDR_MIN_SLIDES = 1;
export const TLDR_MAX_SLIDES = 12;

// Phase 8: slides carry no `reason` (Jev ranks; relevance lives only in ai_generation.output.scores).
// Legacy payloads whose slides have `reason: string | null` parse unchanged — zod strips the
// unknown key — so pre-Phase-8 decks still read, edit and publish. No migration.
const tldrSlideSchema = z.object({
  sid: z.string().min(1),
  text: z.string().min(1),
  source: z.enum(['jev', 'writer']),
});

const tldrPayloadSchema = z.object({
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
// listen (spec/data.md → ListenPayload). A row exists from the first upload; draft null after
// Remove audio. `marks` are STORED marks written only by PUT …/listen (aligner; legacy tap data)
// — [] normally, cleared on every upload. `uploadFingerprint` = the paragraphs fingerprint at
// upload (drives `text_changed`); legacy rows parse with null and fall back to `syncFingerprint`
// (listenBaseline). Unknown keys (e.g. a future `sentenceMarks`) are stripped, not refused.
// ---------------------------------------------------------------------------------------------

const listenPayloadSchema = z.object({
  audio: z.object({
    assetId: z.string().uuid(),
    key: z.string().min(1).max(160),
    mimeType: z.enum(['audio/mpeg', 'audio/mp4']),
    bytes: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  }),
  marks: z.array(z.object({ pid: z.string().min(1).max(64), tMs: z.number().int().nonnegative() })),
  syncFingerprint: z.string().min(1).nullable(),
  uploadFingerprint: z.string().nullable().optional().default(null),
});

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
