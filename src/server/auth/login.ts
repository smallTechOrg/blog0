import 'server-only';

import { and, eq, lt } from 'drizzle-orm';

import type { UserDto } from '@/lib/api/dto';

import { getDb } from '../db/client';
import { session } from '../db/schema';
import { getConfig } from '../config';
import { ApiError } from '../http/api';
import { log, maskEmail } from '../log';
import { findUserByEmail, normalizeUserEmail, recordUserLogin, toUserDto } from '../users/repo';
import { verifyAgainstDummy, verifyPassword } from './password';
import { getLoginRateLimiter, rateLimitMessage } from './rate-limit';
import { createSession } from './session';

// Sign-in service (capability admin-auth). Wrong email and wrong password are indistinguishable
// (same code, message and — via a dummy argon2 verify — similar timing). Every attempt emits one
// `auth.login` log line with the outcome and a masked email; never the password.

export const BAD_CREDENTIALS_MESSAGE = 'Email or password is incorrect.';
const DEFAULT_NEXT = '/admin';

export { normalizeUserEmail as normalizeEmail } from '../users/repo';

/** Throttling key when no trusted proxy is configured: forwarding headers are client-controlled. */
export const DIRECT_CLIENT = 'direct';
/** Throttling key when the trusted proxies did not supply enough X-Forwarded-For hops. */
export const UNKNOWN_CLIENT = 'unknown';

/**
 * Client identity for throttling (spec/architecture.md §6). With `trustedProxyHops` = 0 (no proxy)
 * X-Forwarded-For and X-Real-IP are ignored — any client can set them — and every request maps to
 * "direct", so the limit is effectively per email. With N > 0 the Nth entry from the right of
 * X-Forwarded-For is the address the outermost trusted proxy saw; entries left of it are
 * client-supplied and ignored. Too few entries → "unknown". X-Real-IP is never trusted.
 */
export function clientIpFromRequest(request: Request, trustedProxyHops: number = getConfig().trustedProxyHops): string {
  if (trustedProxyHops <= 0) return DIRECT_CLIENT;
  const hops = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '');
  const hop = hops.length >= trustedProxyHops ? hops[hops.length - trustedProxyHops] : undefined;
  return hop ? hop.slice(0, 64) : UNKNOWN_CLIENT;
}

/** A same-site return path for `?next=`; anything else (absolute, `//`, `/\`, the login page) → /admin. */
export function safeNextPath(next: string | string[] | undefined | null): string {
  const value = Array.isArray(next) ? next[0] : next;
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return DEFAULT_NEXT;
  if (/[\u0000-\u001f]/.test(value)) return DEFAULT_NEXT;
  if (value === '/admin/login' || value.startsWith('/admin/login?') || value.startsWith('/admin/login/')) {
    return DEFAULT_NEXT;
  }
  return value;
}

export interface LoginInput {
  siteId: string;
  email: string;
  password: string;
  ip: string;
  userAgent: string | null;
  requestId?: string;
  now?: Date;
}

export interface LoginSuccess {
  user: UserDto;
  token: string;
  expiresAt: Date;
  /** The instant the session was issued (use it to compute the cookie Max-Age). */
  issuedAt: Date;
}

function logAttempt(outcome: 'ok' | 'bad_credentials' | 'rate_limited', email: string, requestId?: string): void {
  log.info('auth.login', {
    msg: `sign-in ${outcome}`,
    outcome,
    email_masked: maskEmail(email),
    request_id: requestId,
  });
}

/**
 * Verifies credentials and opens a session. Throws ApiError RATE_LIMITED (429, Retry-After) while
 * the (email, IP) pair or the email itself is locked — even for a correct password — or BAD_CREDENTIALS (401).
 */
export async function login(input: LoginInput): Promise<LoginSuccess> {
  const now = input.now ?? new Date();
  const email = normalizeUserEmail(input.email);
  const limiter = getLoginRateLimiter();

  // Check AND reserve this attempt synchronously (before the first await), so concurrent wrong
  // attempts are all counted; a correct password clears the reservation below.
  const check = limiter.attempt(email, input.ip, now.getTime());
  if (check.limited) {
    logAttempt('rate_limited', email, input.requestId);
    throw new ApiError('RATE_LIMITED', 429, rateLimitMessage(check.retryAfterSec), undefined, {
      'retry-after': String(check.retryAfterSec),
    });
  }

  const user = await findUserByEmail(input.siteId, email);
  const ok =
    user !== null && user.disabledAt === null
      ? await verifyPassword(user.passwordHash, input.password)
      : await verifyAgainstDummy(input.password);

  if (!ok || user === null) {
    logAttempt('bad_credentials', email, input.requestId);
    throw new ApiError('BAD_CREDENTIALS', 401, BAD_CREDENTIALS_MESSAGE);
  }

  limiter.recordSuccess(email, input.ip);
  const db = getDb();
  // Expired sessions are purged lazily at login (spec/data.md → Session).
  await db.delete(session).where(and(eq(session.siteId, input.siteId), lt(session.expiresAt, now)));
  const created = await createSession({
    userId: user.id,
    siteId: input.siteId,
    userAgent: input.userAgent,
    ip: input.ip === UNKNOWN_CLIENT || input.ip === DIRECT_CLIENT ? null : input.ip,
    now,
  });
  await recordUserLogin(input.siteId, user.id, now);
  logAttempt('ok', email, input.requestId);
  return { user: toUserDto(user), token: created.token, expiresAt: created.expiresAt, issuedAt: now };
}
