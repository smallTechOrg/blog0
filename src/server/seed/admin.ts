import 'server-only';

import { hashPassword, passwordPolicyProblem } from '../auth/password';
import { CONFIG_DEFAULTS } from '../config';
import type { Db } from '../db/client';
import { createUser, findUserByEmail, normalizeUserEmail, setUserPasswordHash, UserExistsError } from '../users/repo';

// Admin seeding (capability admin-auth; spec/data.md → Seed data).
// - seedAdmin(): `pnpm db:seed` — creates the first admin from BLOG0_ADMIN_*; an existing admin is
//   left untouched (password only set on create unless `resetPassword`).
// - createAdmin(): `pnpm admin:create` — adds another admin; refuses an existing email.
// Shared by the E2E global setup. Never logs or returns the password.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254;
const NAME_MAX = 120;

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

export interface AdminCredentials {
  email: string;
  password: string;
  displayName: string;
}

function validateEmail(raw: string | undefined, source: string): string {
  const email = normalizeUserEmail(raw ?? '');
  if (email === '') throw new SeedError(`${source} is missing — set it to the admin's email address.`);
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) throw new SeedError(`${source} is not a valid email address.`);
  return email;
}

/** `.env.example` ships BLOG0_ADMIN_PASSWORD as `replace-with-…`; a copied-but-unedited value is refused. */
const PLACEHOLDER_PREFIX = 'replace-with-';

/**
 * Trim is used only to detect an empty value; the password is hashed exactly as given, because
 * sign-in compares the raw submitted value. The value itself is never echoed.
 */
function validatePassword(raw: string | undefined, source: string): string {
  const password = raw ?? '';
  if (password.trim() === '') throw new SeedError(`${source} is missing — set a password of at least 12 characters.`);
  if (password.trim().startsWith(PLACEHOLDER_PREFIX)) {
    throw new SeedError(`${source} still holds the .env.example placeholder — set a real password.`);
  }
  const problem = passwordPolicyProblem(password);
  if (problem) throw new SeedError(`${source}: ${problem}`);
  return password;
}

function validateName(raw: string | undefined, source: string, fallback?: string): string {
  const name = (raw ?? '').replace(/\s+#.*$/, '').trim() || (fallback ?? '');
  if (name === '') throw new SeedError(`${source} is missing — give the admin a display name.`);
  if (name.length > NAME_MAX) throw new SeedError(`${source} must be at most ${NAME_MAX} characters.`);
  return name;
}

/** Reads + validates BLOG0_ADMIN_EMAIL / BLOG0_ADMIN_PASSWORD / BLOG0_ADMIN_NAME. Throws SeedError. */
export function adminCredentialsFromEnv(env: Record<string, string | undefined>): AdminCredentials {
  const email = validateEmail(env.BLOG0_ADMIN_EMAIL?.replace(/\s+#.*$/, ''), 'BLOG0_ADMIN_EMAIL');
  const password = validatePassword(env.BLOG0_ADMIN_PASSWORD, 'BLOG0_ADMIN_PASSWORD');
  const displayName = validateName(env.BLOG0_ADMIN_NAME, 'BLOG0_ADMIN_NAME', CONFIG_DEFAULTS.adminName);
  return { email, password, displayName };
}

/** Validates `pnpm admin:create` input (email, name, password). Throws SeedError. */
export function validateNewAdmin(input: { email?: string; displayName?: string; password?: string }): AdminCredentials {
  return {
    email: validateEmail(input.email, '--email'),
    displayName: validateName(input.displayName, '--name'),
    password: validatePassword(input.password, 'Password'),
  };
}

export type SeedAdminStatus = 'created' | 'ok' | 'password_reset';

export async function seedAdmin(
  db: Db,
  siteId: string,
  credentials: AdminCredentials,
  options: { resetPassword?: boolean } = {},
): Promise<{ status: SeedAdminStatus; userId: string; email: string }> {
  const existing = await findUserByEmail(siteId, credentials.email, db);
  if (existing) {
    if (options.resetPassword) {
      await setUserPasswordHash(siteId, existing.id, await hashPassword(credentials.password), db);
      return { status: 'password_reset', userId: existing.id, email: existing.email };
    }
    return { status: 'ok', userId: existing.id, email: existing.email };
  }
  try {
    const created = await createUser(
      { siteId, email: credentials.email, displayName: credentials.displayName, passwordHash: await hashPassword(credentials.password) },
      db,
    );
    return { status: 'created', userId: created.id, email: created.email };
  } catch (error) {
    // Lost a race with a concurrent seed: the admin exists now, which is the desired state.
    if (error instanceof UserExistsError) {
      const row = await findUserByEmail(siteId, credentials.email, db);
      if (row) return { status: 'ok', userId: row.id, email: row.email };
    }
    throw error;
  }
}

/** Adds another admin. Throws SeedError when the email is already taken in this site. */
export async function createAdmin(
  db: Db,
  siteId: string,
  credentials: AdminCredentials,
): Promise<{ userId: string; email: string; displayName: string }> {
  try {
    const row = await createUser(
      { siteId, email: credentials.email, displayName: credentials.displayName, passwordHash: await hashPassword(credentials.password) },
      db,
    );
    return { userId: row.id, email: row.email, displayName: row.displayName };
  } catch (error) {
    if (error instanceof UserExistsError) throw new SeedError(error.message);
    throw error;
  }
}
