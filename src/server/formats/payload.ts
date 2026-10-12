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
