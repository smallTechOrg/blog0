// loginAs(): creates an admin user + a real DB session and returns the Cookie header to send.
// The user's password_hash is a placeholder (not a valid argon2 hash) — it signs in by session
// only; the auth tests exercise the real login path.
import { appUser } from '@/server/db/schema';
import { getDb } from '@/server/db/client';
import { createSession, SESSION_COOKIE_NAME } from '@/server/auth/session';
import { getCurrentSite } from '@/server/site/current';

export interface TestLogin {
  user: { id: string; email: string; displayName: string; siteId: string };
  token: string;
  cookie: string;
  sessionId: string;
  expiresAt: Date;
}

let counter = 0;

export async function loginAs(options: { email?: string; displayName?: string; now?: Date } = {}): Promise<TestLogin> {
  const site = await getCurrentSite();
  counter += 1;
  const email = (options.email ?? `writer${counter}@example.test`).toLowerCase();
  const displayName = options.displayName ?? `Test Writer ${counter}`;
  const [user] = await getDb()
    .insert(appUser)
    .values({ siteId: site.id, email, displayName, passwordHash: '$test-helper$not-a-real-hash' })
    .returning({ id: appUser.id, email: appUser.email, displayName: appUser.displayName, siteId: appUser.siteId });
  const created = await createSession({ userId: user.id, siteId: site.id, userAgent: 'vitest', ip: '127.0.0.1', now: options.now });
  return {
    user,
    token: created.token,
    cookie: `${SESSION_COOKIE_NAME}=${created.token}`,
    sessionId: created.sessionId,
    expiresAt: created.expiresAt,
  };
}
