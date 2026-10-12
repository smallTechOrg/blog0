import 'server-only';

import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';

import { buildDeckSlides, tldrMinutes } from '@/lib/deck/timing';
import { fmtDate } from '@/lib/format-date';
import { deckDisclosure, type ArticleViewModel, type DeckViewModel, type PostCardViewModel } from '@/lib/view-models';

import { getConfig } from '../config';
import { getRenderedRevision } from '../content';
import { getDb } from '../db/client';
import { article, articleFormat, articleRevision } from '../db/schema';
import { log } from '../log';
import { getCurrentSite } from '../site/current';

// Published-only reads for the reader site (spec/architecture.md §3 "Public article", S1.7).
// Every query filters by the current site AND `status = 'published'` AND a non-null published
// revision, so drafts, submitted/approved pieces and unpublished articles (status back to
// 'draft', pointers kept) are invisible. Readers get the PUBLISHED revision and the PUBLISHED
// TLDR payload only — never the current revision or the draft deck. No AI call happens here.

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 80;

/** Published TLDR payload as stored in article_format.published_payload (spec/data.md). */
const tldrPayloadSchema = z.object({
  slides: z
    .array(
      z.object({
        sid: z.string(),
        text: z.string().min(1),
        source: z.enum(['jev', 'writer']),
        reason: z.string().nullable().optional(),
      }),
    )
    .min(1)
    .max(12),
  generationId: z.string().nullable().optional(),
});
export type PublishedTldrPayload = z.infer<typeof tldrPayloadSchema>;

/** Validates a stored published deck; null (with a warning log) when absent or malformed. */
export function parsePublishedDeck(raw: unknown, ctx: { articleId: string }): PublishedTldrPayload | null {
  if (raw == null) return null;
  const parsed = tldrPayloadSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  log.warn('public.deck_invalid', {
    msg: 'Published TLDR payload failed validation — deck not offered to readers',
    article_id: ctx.articleId,
    issues: parsed.error.issues.length,
  });
  return null;
}

export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= SLUG_MAX && SLUG_RE.test(slug);
}

function absolute(path: string): string {
  return getConfig().publicBaseUrl.replace(/\/+$/, '') + path;
}

export function articlePath(slug: string): string {
  return '/p/' + slug;
}

/** Minutes for the capsule/card TLDR badge: the design's formula over the whole deck (intro included). */
function deckMinutes(title: string, dek: string, lines: readonly string[]): number {
  return tldrMinutes(buildDeckSlides(title, dek, lines));
}

/** The published-only filter, shared by every public query. */
function publishedWhere(siteId: string) {
  return and(
    eq(article.siteId, siteId),
    eq(article.status, 'published'),
    isNotNull(article.publishedRevisionId),
    isNotNull(article.firstPublishedAt),
  );
}

export interface NextCandidate {
  slug: string;
  title: string;
  firstPublishedAt: Date;
}

/**
 * "Next: <title> →" (divergence 24): the next newer published article by first-published
 * date, wrapping to the oldest. Null when the article is the only one (or not in the list).
 */
export function nextArticleOf(list: readonly NextCandidate[], slug: string): { slug: string; title: string } | null {
  const sorted = [...list].sort(
    (a, b) => a.firstPublishedAt.getTime() - b.firstPublishedAt.getTime() || a.slug.localeCompare(b.slug),
  );
  const i = sorted.findIndex((c) => c.slug === slug);
  if (i === -1 || sorted.length < 2) return null;
  const n = sorted[(i + 1) % sorted.length];
  return { slug: n.slug, title: n.title };
}

async function publishedCandidates(siteId: string): Promise<NextCandidate[]> {
  const rows = await getDb()
    .select({ slug: article.slug, title: articleRevision.title, firstPublishedAt: article.firstPublishedAt })
    .from(article)
    .innerJoin(articleRevision, eq(articleRevision.id, article.publishedRevisionId))
    .where(publishedWhere(siteId));
  return rows.map((r) => ({ slug: r.slug, title: r.title, firstPublishedAt: r.firstPublishedAt as Date }));
}

export interface PublishedArticlePage {
  article: ArticleViewModel;
  /** Instants for OG tags (`article:published_time`, `article:modified_time`). */
  publishedAt: Date;
  updatedAt: Date | null;
  site: { wordmark: string; timezone: string };
}

/** The reader page's data for `/p/<slug>` — null for unknown, malformed or unpublished slugs. */
export async function loadPublishedArticle(slug: string): Promise<PublishedArticlePage | null> {
  if (!isValidSlug(slug)) return null;
  const site = await getCurrentSite();

  const [row] = await getDb()
    .select({
      id: article.id,
      slug: article.slug,
      topic: article.topic,
      bylineName: article.bylineName,
      inProgress: article.inProgress,
      firstPublishedAt: article.firstPublishedAt,
      revisionId: articleRevision.id,
      title: articleRevision.title,
      dek: articleRevision.dek,
      bodyMd: articleRevision.bodyMd,
      deckPayload: articleFormat.publishedPayload,
    })
    .from(article)
    .innerJoin(articleRevision, eq(articleRevision.id, article.publishedRevisionId))
    .leftJoin(articleFormat, and(eq(articleFormat.articleId, article.id), eq(articleFormat.kind, 'tldr')))
    .where(and(publishedWhere(site.id), eq(article.slug, slug)))
    .limit(1);
  if (!row) return null;

  const rendered = await getRenderedRevision(row.revisionId, { title: row.title, dek: row.dek, bodyMd: row.bodyMd });
  const payload = parsePublishedDeck(row.deckPayload, { articleId: row.id });
  const lines = payload ? payload.slides.map((s) => s.text) : [];
  const deck: DeckViewModel | null = payload
    ? {
        slides: lines.map((text) => ({ text })),
        disclosure: deckDisclosure(payload.slides.map((s) => s.source)),
        shareUrl: absolute(articlePath(row.slug) + '/tldr'),
      }
    : null;

  const next = nextArticleOf(await publishedCandidates(site.id), row.slug);
  const publishedAt = row.firstPublishedAt as Date;

  return {
    article: {
      slug: row.slug,
      title: row.title,
      dek: row.dek,
      topic: row.topic,
      bylineName: row.bylineName,
      publishedLabel: fmtDate(publishedAt, site.timezone),
      updatedLabel: null, // Phase 4 (content_updated_at)
      inProgress: row.inProgress,
      blocks: rendered.blocks,
      times: {
        read: rendered.stats.readMinutes,
        tldr: payload ? deckMinutes(row.title, row.dek, lines) : null,
        listen: null, // Phase 3
      },
      deck,
      listen: null,
      correctionsHtml: null, // Phase 4
      next,
      articleUrl: absolute(articlePath(row.slug)),
    },
    publishedAt,
    updatedAt: null,
    site: { wordmark: site.wordmark, timezone: site.timezone },
  };
}

/**
 * Cheap existence check for `/p/<slug>` (src/proxy.ts): true only when the slug is a published
 * article of the current site — the same filter `loadPublishedArticle` applies, without rendering.
 */
export async function publishedSlugExists(slug: string): Promise<boolean> {
  if (!isValidSlug(slug)) return false;
  const site = await getCurrentSite();
  const [row] = await getDb()
    .select({ id: article.id })
    .from(article)
    .where(and(publishedWhere(site.id), eq(article.slug, slug)))
    .limit(1);
  return Boolean(row);
}

/** The `ArticleViewModel` for a published slug, or null. */
export async function getPublishedArticle(slug: string): Promise<ArticleViewModel | null> {
  return (await loadPublishedArticle(slug))?.article ?? null;
}

/** Home "Latest": every published article, newest first (first-published date). */
export async function listPublishedPostCards(): Promise<PostCardViewModel[]> {
  const site = await getCurrentSite();
  const rows = await getDb()
    .select({
      id: article.id,
      slug: article.slug,
      topic: article.topic,
      inProgress: article.inProgress,
      firstPublishedAt: article.firstPublishedAt,
      title: articleRevision.title,
      dek: articleRevision.dek,
      deckPayload: articleFormat.publishedPayload,
    })
    .from(article)
    .innerJoin(articleRevision, eq(articleRevision.id, article.publishedRevisionId))
    .leftJoin(articleFormat, and(eq(articleFormat.articleId, article.id), eq(articleFormat.kind, 'tldr')))
    .where(publishedWhere(site.id))
    .orderBy(desc(article.firstPublishedAt), article.slug);

  return rows.map((r) => {
    const payload = parsePublishedDeck(r.deckPayload, { articleId: r.id });
    return {
      slug: r.slug,
      title: r.title,
      dek: r.dek,
      topic: r.topic,
      publishedLabel: fmtDate(r.firstPublishedAt as Date, site.timezone),
      inProgress: r.inProgress,
      times: {
        tldr: payload ? deckMinutes(r.title, r.dek, payload.slides.map((s) => s.text)) : null,
        listen: null,
      },
    };
  });
}
