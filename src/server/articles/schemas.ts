import 'server-only';

import { z } from 'zod';

import { TLDR_REASON_MAX } from '../formats/payload';
import { SLUG_MAX, SLUG_RE } from './slug';

// Request bodies for /api/admin/* (spec/api.md → Phase 1). Bad input → 400 VALIDATION_FAILED.

export const TITLE_MAX = 200;
export const DEK_MAX = 400;
export const TOPIC_MAX = 40;
export const BODY_MAX = 200_000;
export const BYLINE_MAX = 80;

const title = z.string().trim().min(1, 'Title is required.').max(TITLE_MAX);
const dek = z.string().trim().max(DEK_MAX);
const topic = z.string().trim().max(TOPIC_MAX);
const bodyMd = z.string().max(BODY_MAX);
const id = z.string().trim().min(1).max(64);

export const previewBody = z.object({
  title: z.string().max(2_000),
  dek: z.string().max(4_000),
  bodyMd,
});

export const createArticleBody = z.object({
  title,
  dek: dek.optional(),
  topic: topic.optional(),
  bodyMd: bodyMd.optional(),
});

export const updateArticleBody = z.object({
  baseRevisionId: id,
  title: title.optional(),
  dek: dek.optional(),
  bodyMd: bodyMd.optional(),
  topic: topic.optional(),
  slug: z
    .string()
    .trim()
    .max(SLUG_MAX)
    .regex(SLUG_RE, 'Use lowercase letters, digits and single hyphens.')
    .optional(),
  bylineName: z.string().trim().min(1).max(BYLINE_MAX).optional(),
  isFeatured: z.boolean().optional(),
  featuredRank: z.number().int().min(0).max(10_000).nullable().optional(),
  inProgress: z.boolean().optional(),
});

export const revisionBody = z.object({ revisionId: id });

export const saveDeckBody = z.object({
  revisionId: id,
  // Count rules (1–12) are a deck rule → 422 DECK_INVALID; the 100 cap only bounds the payload.
  slides: z
    .array(
      z.object({
        sid: z.string().trim().min(1).max(64),
        source: z.enum(['jev', 'writer']),
        reason: z.string().trim().max(TLDR_REASON_MAX).nullable().optional(),
      }),
    )
    .max(100),
});

export type CreateArticleBody = z.infer<typeof createArticleBody>;
export type UpdateArticleBody = z.infer<typeof updateArticleBody>;
export type SaveDeckBody = z.infer<typeof saveDeckBody>;
