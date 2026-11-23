import 'server-only';

import { z } from 'zod';

import { ARTICLE_LIMITS as MAX } from '@/lib/articles/limits';

import { SLUG_RE } from './slug';

// Request bodies for /api/admin/* (spec/api.md). Bad input → 400 VALIDATION_FAILED.

const title = z.string().trim().min(1, 'Title is required.').max(MAX.title);
const dek = z.string().trim().max(MAX.dek);
const topic = z.string().trim().max(MAX.topic);
const bodyMd = z.string().max(MAX.body);
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
    .max(MAX.slug)
    .regex(SLUG_RE, 'Use lowercase letters, digits and single hyphens.')
    .optional(),
  isFeatured: z.boolean().optional(),
  featuredRank: z.number().int().min(0).max(10_000).nullable().optional(),
  inProgress: z.boolean().optional(),
  mediaOnly: z.boolean().optional(),
});

export const revisionBody = z.object({ revisionId: id });

export const saveDeckBody = z.object({
  revisionId: id,
  // The count rule (at least 1 line; no upper limit) is a deck rule → 422 DECK_INVALID.
  // Phase 8: a legacy `reason` key (or any other extra key, e.g. a client-sent relevance) is
  // stripped by zod, not refused — relevance is never accepted from the client.
  slides: z
    .array(
      z.discriminatedUnion('source', [
        z.object({ sid: z.string().trim().min(1).max(64), source: z.literal('jev') }),
        z.object({ sid: z.string().trim().min(1).max(64), source: z.literal('writer') }),
        // SMA-49: a hand-placed image slide; the server resolves the asset (key, size) itself.
        z.object({
          sid: z.string().trim().min(1).max(64),
          source: z.literal('image'),
          assetId: z.string().trim().min(1).max(64),
          text: z.string().trim().max(200),
          alt: z.string().trim().max(200),
        }),
      ]),
    ),
});

export type CreateArticleBody = z.infer<typeof createArticleBody>;
export type UpdateArticleBody = z.infer<typeof updateArticleBody>;
export type SaveDeckBody = z.infer<typeof saveDeckBody>;
