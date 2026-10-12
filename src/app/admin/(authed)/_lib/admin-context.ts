import 'server-only';

import { cookies } from 'next/headers';

import { SESSION_COOKIE_NAME, validateSessionToken, type SessionUser } from '@/server/auth/session';
import { getCurrentSite } from '@/server/site/current';

// Shared by the (authed) layout and pages. The redirect to sign-in happens in each page via
// requireAdminPage(<its own path>) so `next` returns the writer to the exact screen; a layout
// cannot see the pathname.

export interface AdminContext {
  user: SessionUser | null;
  wordmark: string;
  timeZone: string;
}

export async function loadAdminContext(): Promise<AdminContext> {
  const site = await getCurrentSite();
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null;
  const validated = token ? await validateSessionToken(token, site.id) : null;
  return { user: validated?.user ?? null, wordmark: site.wordmark, timeZone: site.timezone };
}
