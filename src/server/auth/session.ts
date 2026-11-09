import 'server-only';

import { createHmac, randomBytes } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { getConfig } from '../config';
import { getDb } from '../db/client';
import { appUser, session, type AppUserRow, type SessionRow } from '../db/schema';

// DB-backed opaque sessions (spec/architecture.md §6). The cookie carries a random token; the DB
// stores only HMAC-SHA256(BLOG0_SESSION_SECRET, token) hex. Sliding expiry: expires_at and the
// cookie are extended when last_seen_at is older than 24 h. Logout deletes the row.

export const SESSION_COOKIE_NAME = 'blog0_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_SLIDE_AFTER_MS = 24 * 60 * 60 * 1000;
const USER_AGENT_MAX = 200;

export interface SessionUser {
  id: string;
  siteId: string;
  email: string;
  displayName: string;
}

export interface ValidatedSession {
  session: Pick<SessionRow, 'id' | 'expiresAt' | 'lastSeenAt'>;
  user: SessionUser;
  /** true when this validation slid the expiry — the caller should re-send the cookie. */
  refreshed: boolean;
  token: string;
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHmac('sha256', getConfig().sessionSecret.reveal()).update(token).digest('hex');
}

function toSessionUser(row: Pick<AppUserRow, 'id' | 'siteId' | 'email' | 'displayName'>): SessionUser {
  return { id: row.id, siteId: row.siteId, email: row.email, displayName: row.displayName };
}

export async function createSession(input: {
  userId: string;
  siteId: string;
  userAgent?: string | null;
  ip?: string | null;
  now?: Date;
}): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const token = generateSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const [row] = await getDb()
    .insert(session)
    .values({
      siteId: input.siteId,
      userId: input.userId,
      tokenHash: hashSessionToken(token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      userAgent: input.userAgent ? input.userAgent.slice(0, USER_AGENT_MAX) : null,
      ip: input.ip ?? null,
    })
    .returning({ id: session.id });
  return { token, sessionId: row.id, expiresAt };
}

/**
 * Resolves a cookie token to its session + user within `siteId`. Returns null for unknown,
 * expired (row deleted), other-site or disabled-user sessions.
 */
export async function validateSessionToken(
  token: string,
  siteId: string,
  now: Date = new Date(),
): Promise<ValidatedSession | null> {
  if (!token || token.length > 200) return null;
  const db = getDb();
  const tokenHash = hashSessionToken(token);
  const [row] = await db
    .select({
      id: session.id,
      siteId: session.siteId,
      expiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt,
      user: {
        id: appUser.id,
        siteId: appUser.siteId,
        email: appUser.email,
        displayName: appUser.displayName,
        disabledAt: appUser.disabledAt,
      },
    })
    .from(session)
    .innerJoin(appUser, eq(appUser.id, session.userId))
    .where(and(eq(session.tokenHash, tokenHash), eq(session.siteId, siteId)))
    .limit(1);
  if (!row) return null;

  if (row.expiresAt.getTime() <= now.getTime()) {
    await db.delete(session).where(eq(session.id, row.id));
    return null;
  }
  if (row.user.disabledAt !== null) return null;

  let { expiresAt, lastSeenAt } = row;
  let refreshed = false;
  if (now.getTime() - lastSeenAt.getTime() > SESSION_SLIDE_AFTER_MS) {
    lastSeenAt = now;
    expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await db.update(session).set({ lastSeenAt, expiresAt }).where(eq(session.id, row.id));
    refreshed = true;
  }
  return { session: { id: row.id, expiresAt, lastSeenAt }, user: toSessionUser(row.user), refreshed, token };
}

/** Deletes the session for this token (logout). No-op when unknown. */
export async function deleteSession(token: string): Promise<void> {
  if (!token) return;
  await getDb().delete(session).where(eq(session.tokenHash, hashSessionToken(token)));
}

function isSecureCookie(): boolean {
  return getConfig().publicBaseUrl.startsWith('https://');
}

/** `Set-Cookie` value for a session token (httpOnly, SameSite=Lax, path /, Secure on https). */
export function serializeSessionCookie(token: string, expiresAt: Date, now: Date = new Date()): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (isSecureCookie()) parts.push('Secure');
  return parts.join('; ');
}

/** `Set-Cookie` value that clears the session cookie. */
export function serializeClearedSessionCookie(): string {
  const parts = [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
  if (isSecureCookie()) parts.push('Secure');
  return parts.join('; ');
}

/** Extracts the session token from a raw `Cookie` request header. */
export function readSessionTokenFromCookieHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE_NAME) {
      const value = part.slice(eq + 1).trim();
      return value === '' ? null : value;
    }
  }
  return null;
}
