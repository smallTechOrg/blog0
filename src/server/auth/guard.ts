import 'server-only';

import { ApiError } from '../http/api';
import { getCurrentSite } from '../site/current';
import {
  readSessionTokenFromCookieHeader,
  SESSION_COOKIE_NAME,
  serializeSessionCookie,
  validateSessionToken,
  type SessionUser,
} from './session';

// Guards (spec/architecture.md §6).
// - requireAdmin(request): route handlers; reads the Cookie header (never next/headers) so
//   handlers are directly testable. Throws ApiError 401 UNAUTHENTICATED.
// - requireAdminPage(path): server components; redirects to /admin/login?next=<path>.

export interface AdminAuth {
  user: SessionUser;
  sessionId: string;
  /** Set-Cookie value to send when the session expiry slid; null otherwise. */
  setCookie: string | null;
}

export const UNAUTHENTICATED_MESSAGE = 'Your session has ended — sign in again to continue.';

export async function getAdminFromRequest(request: Request, now: Date = new Date()): Promise<AdminAuth | null> {
  const token = readSessionTokenFromCookieHeader(request.headers.get('cookie'));
  if (!token) return null;
  const site = await getCurrentSite();
  const validated = await validateSessionToken(token, site.id, now);
  if (!validated) return null;
  return {
    user: validated.user,
    sessionId: validated.session.id,
    setCookie: validated.refreshed ? serializeSessionCookie(token, validated.session.expiresAt, now) : null,
  };
}

export async function requireAdmin(request: Request, now: Date = new Date()): Promise<AdminAuth> {
  const auth = await getAdminFromRequest(request, now);
  if (!auth) throw new ApiError('UNAUTHENTICATED', 401, UNAUTHENTICATED_MESSAGE);
  return auth;
}

/** Server-component guard: the signed-in admin, or a redirect to the sign-in page. */
export async function requireAdminPage(nextPath = '/admin'): Promise<SessionUser> {
  const { cookies } = await import('next/headers');
  const { redirect } = await import('next/navigation');
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value ?? null;
  if (token) {
    const site = await getCurrentSite();
    const validated = await validateSessionToken(token, site.id);
    if (validated) return validated.user;
  }
  const safeNext = nextPath.startsWith('/') && !nextPath.startsWith('//') ? nextPath : '/admin';
  return redirect(`/admin/login?next=${encodeURIComponent(safeNext)}`);
}
