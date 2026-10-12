import 'server-only';

import { and, desc, eq, isNotNull } from 'drizzle-orm';

import { buildDeckSlides, tldrMinutes } from '@/lib/deck/timing';
import { fmtDate } from '@/lib/format-date';
import type { PostCardViewModel } from '@/lib/view-models';

import { validateSessionToken } from '../auth/session';
import { getDb } from '../db/client';
import { article, articleFormat, articleRevision } from '../db/schema';
import { getCurrentSite } from '../site/current';

import { parsePublishedDeck } from './articles';

// Home page data (spec/ui.md §3 "Home"; spec/capabilities/reader-site.md "Business Rules"):
// Featured = published articles flagged featured, by rank (then newest), max FEATURED_MAX;
// Latest = every other published article, newest first. Published-only, current site only;
// no AI call happens here.

/** Three or four reads well as a pile; more than that is a scroll tax (design). */
export const FEATURED_MAX = 4;

export interface HomeViewModel {
  /** Every published article, newest first (the flat list). */
  posts: PostCardViewModel[];
  signedIn: boolean;
}

export interface HomeSections {
  featured: PostCardViewModel[];
  latest: PostCardViewModel[];
  /** Only looked up when nothing is published (the empty state then links to the desk). */
  signedIn: boolean;
}

/** One published article with what the split needs; `card` is whatever the caller renders. */
export interface HomeRow<T> {
  card: T;
  slug: string;
  firstPublishedAt: Date;
  isFeatured: boolean;
  featuredRank: number | null;
}

function newestFirst<T>(a: HomeRow<T>, b: HomeRow<T>): number {
  return b.firstPublishedAt.getTime() - a.firstPublishedAt.getTime() || a.slug.localeCompare(b.slug);
}

/**
 * Splits published rows into the Featured stack and the Latest feed. A featured article past
 * the cap is listed in Latest (spec: Latest = "all other published articles"), so nothing
 * published ever disappears from the home page.
 */
export function splitHomeSections<T>(rows: readonly HomeRow<T>[]): { featured: T[]; latest: T[] } {
  const featuredRows = rows
    .filter((r) => r.isFeatured)
    .sort((a, b) => {
      const ra = a.featuredRank ?? Number.POSITIVE_INFINITY;
      const rb = b.featuredRank ?? Number.POSITIVE_INFINITY;
      return ra === rb ? newestFirst(a, b) : ra - rb;
    })
    .slice(0, FEATURED_MAX);
  const shown = new Set(featuredRows.map((r) => r.slug));
  const latestRows = rows.filter((r) => !shown.has(r.slug)).sort(newestFirst);
  return { featured: featuredRows.map((r) => r.card), latest: latestRows.map((r) => r.card) };
}

/** True when `token` (the `blog0_session` cookie value) is a live admin session for this site. */
export async function isAdminSignedIn(token: string | null | undefined): Promise<boolean> {
  if (!token) return false;
  const site = await getCurrentSite();
  return (await validateSessionToken(token, site.id)) !== null;
}

/** Every published article of the current site as a card row (newest first). */
async function publishedHomeRows(): Promise<HomeRow<PostCardViewModel>[]> {
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
    })
    .from(article)
    .innerJoin(articleRevision, eq(articleRevision.id, article.publishedRevisionId))
    .leftJoin(articleFormat, and(eq(articleFormat.articleId, article.id), eq(articleFormat.kind, 'tldr')))
    .where(
      and(
        eq(article.siteId, site.id),
        eq(article.status, 'published'),
        isNotNull(article.publishedRevisionId),
        isNotNull(article.firstPublishedAt),
      ),
    )
    .orderBy(desc(article.firstPublishedAt), article.slug);

  return rows.map((r) => {
    const payload = parsePublishedDeck(r.deckPayload, { articleId: r.id });
    const publishedAt = r.firstPublishedAt as Date;
    return {
      slug: r.slug,
      firstPublishedAt: publishedAt,
      isFeatured: r.isFeatured,
      featuredRank: r.featuredRank,
      card: {
        slug: r.slug,
        title: r.title,
        dek: r.dek,
        topic: r.topic,
        publishedLabel: fmtDate(publishedAt, site.timezone),
        inProgress: r.inProgress,
        times: {
          // the design's formula over the whole deck (intro slide included), as on the article page
          tldr: payload ? tldrMinutes(buildDeckSlides(r.title, r.dek, payload.slides.map((s) => s.text))) : null,
          listen: null, // Phase 3
        },
      },
    };
  });
}

/** The home page: Featured stack + Latest feed (+ whether an empty site's visitor is an admin). */
export async function getHomeSections(sessionToken: string | null | undefined): Promise<HomeSections> {
  const rows = await publishedHomeRows();
  const { featured, latest } = splitHomeSections(rows);
  const signedIn = rows.length === 0 ? await isAdminSignedIn(sessionToken) : false;
  return { featured, latest, signedIn };
}

/** The flat list: every published article newest first (Phase 1 contract, kept for callers/tests). */
export async function getHomeViewModel(sessionToken: string | null | undefined): Promise<HomeViewModel> {
  const rows = await publishedHomeRows();
  // Only the empty state uses the session, so skip the lookup when there is something to list.
  const signedIn = rows.length === 0 ? await isAdminSignedIn(sessionToken) : false;
  return { posts: rows.map((r) => r.card), signedIn };
}
