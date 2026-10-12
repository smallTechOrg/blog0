import 'server-only';

import type { PostCardViewModel } from '@/lib/view-models';

import { validateSessionToken } from '../auth/session';
import { getCurrentSite } from '../site/current';

import { publishedCards, type PublishedCard } from './articles';

// Home page data (spec/ui.md §3 "Home"; spec/capabilities/reader-site.md "Business Rules"):
// Featured = published articles flagged featured, by rank (then newest), max FEATURED_MAX;
// Latest = every other published article, newest first. Published-only, current site only;
// no AI call happens here.

/** Three or four reads well as a pile; more than that is a scroll tax (design). */
export const FEATURED_MAX = 4;

export interface HomeSections {
  featured: PostCardViewModel[];
  latest: PostCardViewModel[];
  /** Only looked up when nothing is published (the empty state then links to the desk). */
  signedIn: boolean;
}

/** One published article with what the split needs; `card` is whatever the caller renders. */
export type HomeRow<T> = Omit<PublishedCard, 'card'> & { card: T };

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

/** The home page: Featured stack + Latest feed (+ whether an empty site's visitor is an admin). */
export async function getHomeSections(sessionToken: string | null | undefined): Promise<HomeSections> {
  const rows = await publishedCards();
  const { featured, latest } = splitHomeSections(rows);
  const signedIn = rows.length === 0 ? await isAdminSignedIn(sessionToken) : false;
  return { featured, latest, signedIn };
}
