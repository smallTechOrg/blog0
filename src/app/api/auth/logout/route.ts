import type { LogoutResponse } from '@/lib/api/dto';
import {
  deleteSession,
  readSessionTokenFromCookieHeader,
  serializeClearedSessionCookie,
} from '@/server/auth/session';
import { apiResult, withApi } from '@/server/http/api';

// POST /api/auth/logout — ends only the current session and clears the cookie (spec/api.md).
// Also succeeds without a (valid) session, so a stale tab can always sign out. Same-origin only.

export const dynamic = 'force-dynamic';

export const POST = withApi({ auth: 'none' }, async ({ request }) => {
  const token = readSessionTokenFromCookieHeader(request.headers.get('cookie'));
  if (token) await deleteSession(token);
  const data: LogoutResponse = { signedOut: true };
  return apiResult(data, { headers: [['set-cookie', serializeClearedSessionCookie()]] });
});
