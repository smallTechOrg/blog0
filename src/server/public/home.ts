import 'server-only';

import type { PostCardViewModel } from '@/lib/view-models';

import { validateSessionToken } from '../auth/session';
import { getCurrentSite } from '../site/current';

import { listPublishedPostCards } from './articles';

// Home page data (spec/ui.md §3 "Home", Phase 1): the published "Latest" list, plus whether the
// visitor holds a valid admin session (the empty state then links to the desk).

export interface HomeViewModel {
  posts: PostCardViewModel[];
  signedIn: boolean;
}

/** True when `token` (the `blog0_session` cookie value) is a live admin session for this site. */
export async function isAdminSignedIn(token: string | null | undefined): Promise<boolean> {
  if (!token) return false;
  const site = await getCurrentSite();
  return (await validateSessionToken(token, site.id)) !== null;
}

export async function getHomeViewModel(sessionToken: string | null | undefined): Promise<HomeViewModel> {
  const posts = await listPublishedPostCards();
  // Only the empty state uses the session, so skip the lookup when there is something to list.
  const signedIn = posts.length === 0 ? await isAdminSignedIn(sessionToken) : false;
  return { posts, signedIn };
}
