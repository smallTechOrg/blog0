import 'server-only';

import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { buildDeckSlides, tldrMinutes } from '@/lib/deck/timing';
import { fmtDate } from '@/lib/format-date';
import type { RenderedArticle } from '@/lib/content/types';
import { resolveMarks, toTimedParagraphs } from '@/lib/listen/estimate';
import { listenMinutes } from '@/lib/listen/marks';
import {
  deckDisclosure,
  type ArticleViewModel,
  type ListenViewModel,
  type PostCardViewModel,
} from '@/lib/view-models';

import { isValidSlug } from '../articles/slug';
import { getConfig } from '../config';
import { getRenderedRevision } from '../content';
import { getDb } from '../db/client';
import { article, articleFormat, articleRevision } from '../db/schema';
import { readListenPayload, readTldrPayload, type ListenPayload, type TldrPayload } from '../formats/payload';
import { log } from '../log';
import { getCurrentSite } from '../site/current';

// Published-only reads for the reader site (spec/architecture.md §3 "Public article"). Every
// query filters by the current site AND `status = 'published'` AND a non-null published revision
// (publishedWhere), so drafts, submitted/approved pieces and unpublished articles (status back to
// 'draft', pointers kept) are invisible. Readers get the PUBLISHED revision and the PUBLISHED
// TLDR / Listen payloads only — never the current revision, the draft deck or the draft recording.
// No AI call happens here.

/** The published-only filter, shared by every public query (pages, proxy, metadata, sitemap). */
export function publishedWhere(siteId: string) {
  return and(
    eq(article.siteId, siteId),
    eq(article.status, 'published'),
    isNotNull(article.publishedRevisionId),
    isNotNull(article.firstPublishedAt),
  );
}

/** The `listen` format row joined beside the `tldr` one (two rows of the same table). */
const listenFormat = alias(articleFormat, 'listen_format');

/** Join conditions: the published revision, the tldr format row, the listen format row. */
const onPublishedRevision = eq(articleRevision.id, article.publishedRevisionId);
const onTldr = and(eq(articleFormat.articleId, article.id), eq(articleFormat.kind, 'tldr'));
const onListen = and(eq(listenFormat.articleId, article.id), eq(listenFormat.kind, 'listen'));

/** A stored published payload, validated; null (with a warning log) when malformed — readers then simply don't get that format. */
function published<T>(read: (raw: unknown) => T | null, raw: unknown, event: string, articleId: string): T | null {
  const payload = read(raw);
  if (payload === null && raw != null) {
    log.warn(event, { msg: 'Published payload failed validation — format not offered to readers', article_id: articleId });
  }
  return payload;
}

/** Minutes for the capsule/card TLDR badge: the design's formula over the whole deck (intro included). */
function deckMinutes(title: string, dek: string, deck: TldrPayload | null): number | null {
  return deck ? tldrMinutes(buildDeckSlides(title, dek, deck.slides.map((s) => s.text))) : null;
}

function absolute(path: string): string {
  return getConfig().publicBaseUrl + path;
}

export function articlePath(slug: string): string {
  return '/p/' + slug;
}

/**
 * The reader's Listen view model from a published payload (reader-facing fields only). Marks are
 * resolved per request over the CURRENTLY PUBLISHED revision's paragraphs and the published
 * recording's duration (spec/capabilities/listen-sync.md → resolveMarks): stored marks covering
 * the text are served as 'synced', otherwise estimated from word counts.
 */
function listenViewModel(payload: ListenPayload, paragraphs: RenderedArticle['paragraphs'], slug: string): ListenViewModel {
  const { marks, timing } = resolveMarks(payload.marks, toTimedParagraphs(paragraphs), payload.audio.durationMs);
  return {
    audioUrl: '/media/' + payload.audio.key,
    mimeType: payload.audio.mimeType,
    durationMs: payload.audio.durationMs,
    marks,
    timing,
    shareUrl: absolute(articlePath(slug) + '/listen'),
  };
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

export interface PublishedArticlePage {
  article: ArticleViewModel;
  /** Instants for OG tags (`article:published_time`, `article:modified_time`). */
  publishedAt: Date;
  /** When the article last changed for readers: the body-change date when known, else the last publish. */
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
      lastPublishedAt: article.lastPublishedAt,
      contentUpdatedAt: article.contentUpdatedAt,
      revisionId: articleRevision.id,
      title: articleRevision.title,
      dek: articleRevision.dek,
      bodyMd: articleRevision.bodyMd,
      deckPayload: articleFormat.publishedPayload,
      listenPayload: listenFormat.publishedPayload,
    })
    .from(article)
    .innerJoin(articleRevision, onPublishedRevision)
    .leftJoin(articleFormat, onTldr)
    .leftJoin(listenFormat, onListen)
    .where(and(publishedWhere(site.id), eq(article.slug, slug)))
    .limit(1);
  if (!row) return null;

  const rendered = await getRenderedRevision(row.revisionId, { title: row.title, dek: row.dek, bodyMd: row.bodyMd });
  const deck = published(readTldrPayload, row.deckPayload, 'public.deck_invalid', row.id);
  const listenPayload = published(readListenPayload, row.listenPayload, 'public.listen_invalid', row.id);
  const listen = listenPayload ? listenViewModel(listenPayload, rendered.paragraphs, row.slug) : null;
  const candidates = await getDb()
    .select({ slug: article.slug, title: articleRevision.title, firstPublishedAt: article.firstPublishedAt })
    .from(article)
    .innerJoin(articleRevision, onPublishedRevision)
    .where(publishedWhere(site.id));
  const publishedAt = row.firstPublishedAt as Date;

  return {
    article: {
      slug: row.slug,
      title: row.title,
      dek: row.dek,
      topic: row.topic,
      bylineName: row.bylineName,
      publishedLabel: fmtDate(publishedAt, site.timezone),
      updatedLabel: null, // revision history (content_updated_at label) is deferred
      inProgress: row.inProgress,
      blocks: rendered.blocks,
      times: {
        read: rendered.stats.readMinutes,
        tldr: deckMinutes(row.title, row.dek, deck),
        listen: listen ? listenMinutes(listen.durationMs) : null,
      },
      deck: deck
        ? {
            slides: deck.slides.map((s) => ({ text: s.text })),
            disclosure: deckDisclosure(deck.slides.map((s) => s.source)),
            shareUrl: absolute(articlePath(row.slug) + '/tldr'),
          }
        : null,
      listen,
      correctionsHtml: null, // revision history (corrections) is deferred
      next: nextArticleOf(candidates as NextCandidate[], row.slug),
      articleUrl: absolute(articlePath(row.slug)),
    },
    publishedAt,
    updatedAt: row.contentUpdatedAt ?? row.lastPublishedAt ?? null,
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

/** One published article as a card, plus what the home page's Featured/Latest split needs. */
export interface PublishedCard {
  card: PostCardViewModel;
  slug: string;
  firstPublishedAt: Date;
  isFeatured: boolean;
  featuredRank: number | null;
}

/** Every published article of the current site as a card row, newest first (first-published date). */
export async function publishedCards(): Promise<PublishedCard[]> {
  const site = await getCurrentSite();
  const rows = await getDb()
    .select({
      id: article.id,
      slug: article.slug,
      topic: article.topic,
      inProgress: article.inProgress,
      isFeatured: article.isFeatured,
      featuredRank: article.featuredRank,
      firstPublishedAt: article.firstPublishedAt,
      title: articleRevision.title,
      dek: articleRevision.dek,
      deckPayload: articleFormat.publishedPayload,
      listenPayload: listenFormat.publishedPayload,
    })
    .from(article)
    .innerJoin(articleRevision, onPublishedRevision)
    .leftJoin(articleFormat, onTldr)
    .leftJoin(listenFormat, onListen)
    .where(publishedWhere(site.id))
    .orderBy(desc(article.firstPublishedAt), article.slug);

  return rows.map((r) => {
    const firstPublishedAt = r.firstPublishedAt as Date;
    const listen = published(readListenPayload, r.listenPayload, 'public.listen_invalid', r.id);
    return {
      slug: r.slug,
      firstPublishedAt,
      isFeatured: r.isFeatured,
      featuredRank: r.featuredRank,
      card: {
        slug: r.slug,
        title: r.title,
        dek: r.dek,
        topic: r.topic,
        publishedLabel: fmtDate(firstPublishedAt, site.timezone),
        inProgress: r.inProgress,
        times: {
          tldr: deckMinutes(r.title, r.dek, published(readTldrPayload, r.deckPayload, 'public.deck_invalid', r.id)),
          // the published recording's minutes — never the draft's (spec/capabilities/listen-audio.md)
          listen: listen ? listenMinutes(listen.audio.durationMs) : null,
        },
      },
    };
  });
}

/** Home "Latest" / the archive: every published article as a card, newest first. */
export async function listPublishedPostCards(): Promise<PostCardViewModel[]> {
  return (await publishedCards()).map((r) => r.card);
}
