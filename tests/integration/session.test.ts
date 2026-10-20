import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAdminFromRequest, requireAdmin } from '@/server/auth/guard';
import {
  deleteSession,
  hashSessionToken,
  readSessionTokenFromCookieHeader,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  SESSION_SLIDE_AFTER_MS,
  SESSION_TTL_MS,
  validateSessionToken,
} from '@/server/auth/session';
import { getDb } from '@/server/db/client';
import { appUser, session } from '@/server/db/schema';
import { ApiError } from '@/server/http/api';

import { resetDb } from '../helpers/db';
import { loginAs } from '../helpers/session';

function requestWithCookie(cookie: string | null): Request {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return new Request('http://localhost:3410/api/auth/me', { headers });
}

describe('DB-backed sessions', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('stores only the HMAC of the token and resolves the cookie back to the user', async () => {
    const login = await loginAs({ displayName: 'Sai Krishna V' });

    const [row] = await getDb().select().from(session).where(eq(session.id, login.sessionId));
    const auth = await requireAdmin(requestWithCookie(`theme=dark; ${login.cookie}`));

    expect(row.tokenHash).toBe(hashSessionToken(login.token));
    expect(row.tokenHash).not.toContain(login.token);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(auth.user).toMatchObject({ id: login.user.id, displayName: 'Sai Krishna V' });
    expect(auth.setCookie).toBeNull();
  });

  it('slides the expiry once the session is older than a day and survives a second request', async () => {
    const start = new Date('2026-10-01T09:00:00Z');
    const login = await loginAs({ now: start });
    const later = new Date(start.getTime() + SESSION_SLIDE_AFTER_MS + 60_000);

    const first = await getAdminFromRequest(requestWithCookie(login.cookie), later);
    const second = await getAdminFromRequest(requestWithCookie(login.cookie), new Date(later.getTime() + 1000));

    expect(first?.setCookie).toMatch(/^blog0_session=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000/);
    const [row] = await getDb().select().from(session).where(eq(session.id, login.sessionId));
    expect(row.expiresAt.getTime()).toBe(later.getTime() + SESSION_TTL_MS);
    expect(second?.user.id).toBe(login.user.id);
    expect(second?.setCookie).toBeNull();
  });

  it('rejects missing, unknown, expired and disabled-user sessions with 401 UNAUTHENTICATED', async () => {
    const login = await loginAs();
    const afterExpiry = new Date(login.expiresAt.getTime() + 1);

    const missing = await requireAdmin(requestWithCookie(null)).catch((e: unknown) => e);
    const unknown = await requireAdmin(requestWithCookie('blog0_session=not-a-real-token')).catch((e: unknown) => e);
    const expired = await validateSessionToken(login.token, login.user.siteId, afterExpiry);

    expect(missing).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    expect(unknown).toBeInstanceOf(ApiError);
    expect(expired).toBeNull();
    const rows = await getDb().select().from(session).where(eq(session.id, login.sessionId));
    expect(rows).toHaveLength(0);

    const other = await loginAs();
    await getDb().update(appUser).set({ disabledAt: new Date() }).where(eq(appUser.id, other.user.id));
    await expect(requireAdmin(requestWithCookie(other.cookie))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('deletes the session on logout so the cookie stops working', async () => {
    const login = await loginAs();

    await deleteSession(login.token);

    await expect(requireAdmin(requestWithCookie(login.cookie))).rejects.toMatchObject({ status: 401 });
  });

  it('parses and serialises the session cookie', () => {
    const expires = new Date('2026-11-01T00:00:00Z');

    const header = serializeSessionCookie('abc', expires, new Date('2026-10-01T00:00:00Z'));
    const cleared = serializeClearedSessionCookie();

    expect(header).toContain('blog0_session=abc');
    expect(header).toContain(`Max-Age=${31 * 24 * 60 * 60}`);
    expect(header).not.toContain('Secure');
    expect(cleared).toContain('Max-Age=0');
    expect(readSessionTokenFromCookieHeader('a=1; blog0_session=tok; b=2')).toBe('tok');
    expect(readSessionTokenFromCookieHeader('a=1; blog0_session=')).toBeNull();
    expect(readSessionTokenFromCookieHeader(null)).toBeNull();
  });
});
