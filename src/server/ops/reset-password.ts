import 'server-only';

import { and, eq } from 'drizzle-orm';

import { loadDatabaseTarget } from '../config';
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../auth/password';
import { loginDelayKey } from '../auth/rate-limit';
import { createDbHandle } from '../db/client';
import { appUser, rateLimitBucket, session, site } from '../db/schema';
import { log, maskEmail } from '../log';
import { DELAY_WINDOW_START, sha256Hex } from '../rate-window-store';
import { normalizeUserEmail } from '../users/repo';

// Stage A password reset (spec/architecture.md §12.1; capability admin-auth): `pnpm
// admin:reset-password --email <e>` locally and `node reset-password.mjs --email <e>` in the image
// (scripts/reset-password.ts, bundled by scripts/build-release.mjs). One transaction: the new argon2id
// hash (the §6 parameters — the same helper as admin:create), every session of that user deleted, and
// that email's `login.delay` row deleted (a memory store lives in the server process and expires on
// its own), and Stage C: `devices_valid_after` = now, so the user's known-device cookies stop counting. Prints only the masked email and the number of sessions ended; never the password.
// pglite:// is allowed with tsx (designer mode has admins too); the bundle carries no PGlite.

type Env = Record<string, string | undefined>;

/** `exitCode` 1 = nothing to reset (unknown admin / site); 2 = misuse (bad email or password). */
export class ResetPasswordError extends Error {
  readonly exitCode: 1 | 2;
  constructor(message: string, exitCode: 1 | 2) {
    super(message);
    this.name = 'ResetPasswordError';
    this.exitCode = exitCode;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ResetPasswordInput {
  env: Env;
  email: string;
  password: string;
  slug: string;
  out: (line: string) => void;
}

export async function runResetPassword({ env, email, password, slug, out }: ResetPasswordInput): Promise<{ sessionsEnded: number }> {
  // Validate everything before touching the database.
  const target = loadDatabaseTarget(env);
  const normalized = normalizeUserEmail(email);
  if (normalized === '' || normalized.length > 254 || !EMAIL_RE.test(normalized)) {
    throw new ResetPasswordError('--email must be an email address', 2);
  }
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new ResetPasswordError(`the new password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters`, 2);
  }
  const passwordHash = await hashPassword(password);

  const handle = await createDbHandle(target, { max: 1 });
  try {
    const sessionsEnded = await handle.db.transaction(async (tx) => {
      const [siteRow] = await tx.select({ id: site.id }).from(site).where(eq(site.slug, slug)).limit(1);
      if (!siteRow) throw new ResetPasswordError(`site '${slug}' not found — run: pnpm db:seed`, 1);
      const [user] = await tx
        .select({ id: appUser.id })
        .from(appUser)
        .where(and(eq(appUser.siteId, siteRow.id), eq(appUser.email, normalized)))
        .limit(1)
        .for('update');
      if (!user) throw new ResetPasswordError('no admin with that email', 1);

      // Stage C: every known-device cookie of this user issued up to now stops skipping the login delay.
      const now = new Date();
      await tx.update(appUser).set({ passwordHash, devicesValidAfter: now, updatedAt: now }).where(eq(appUser.id, user.id));
      const ended = await tx.delete(session).where(eq(session.userId, user.id)).returning({ id: session.id });
      await tx
        .delete(rateLimitBucket)
        .where(
          and(
            eq(rateLimitBucket.siteId, siteRow.id),
            eq(rateLimitBucket.scope, 'login.delay'),
            eq(rateLimitBucket.keyHash, sha256Hex(loginDelayKey(normalized))),
            eq(rateLimitBucket.windowStart, DELAY_WINDOW_START),
          ),
        );
      return ended.length;
    });

    log.info('auth.password_reset', { msg: 'Admin password reset', email_masked: maskEmail(normalized), sessions_ended: sessionsEnded });
    out(`password reset for ${maskEmail(normalized)} · ${sessionsEnded} session${sessionsEnded === 1 ? '' : 's'} ended`);
    return { sessionsEnded };
  } finally {
    await handle.close();
  }
}
