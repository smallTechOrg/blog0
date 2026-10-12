import 'server-only';

import { and, eq } from 'drizzle-orm';

import type { UserDto } from '@/lib/api/dto';

import { getDb, type Db, type Tx } from '../db/client';
import { appUser, type AppUserRow } from '../db/schema';

// app_user access. Every query filters by site id; emails are stored lower-cased (unique per site).
// Functions take an optional `db` so scripts (pnpm db:seed / admin:create) can pass their own client.

type Executor = Db | Tx;

export function normalizeUserEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toUserDto(row: Pick<AppUserRow, 'id' | 'email' | 'displayName'>): UserDto {
  return { id: row.id, email: row.email, displayName: row.displayName };
}

export async function findUserByEmail(siteId: string, email: string, db: Executor = getDb()): Promise<AppUserRow | null> {
  const [row] = await db
    .select()
    .from(appUser)
    .where(and(eq(appUser.siteId, siteId), eq(appUser.email, normalizeUserEmail(email))))
    .limit(1);
  return row ?? null;
}

export async function findUserById(siteId: string, id: string, db: Executor = getDb()): Promise<AppUserRow | null> {
  const [row] = await db
    .select()
    .from(appUser)
    .where(and(eq(appUser.siteId, siteId), eq(appUser.id, id)))
    .limit(1);
  return row ?? null;
}

export class UserExistsError extends Error {
  constructor(email: string) {
    super(`A user with email ${email} already exists in this site.`);
    this.name = 'UserExistsError';
  }
}

/** Inserts a user; throws UserExistsError when (site, email) is taken. */
export async function createUser(
  input: { siteId: string; email: string; displayName: string; passwordHash: string },
  db: Executor = getDb(),
): Promise<AppUserRow> {
  const email = normalizeUserEmail(input.email);
  const [row] = await db
    .insert(appUser)
    .values({ siteId: input.siteId, email, displayName: input.displayName.trim(), passwordHash: input.passwordHash })
    .onConflictDoNothing({ target: [appUser.siteId, appUser.email] })
    .returning();
  if (!row) throw new UserExistsError(email);
  return row;
}

export async function setUserPasswordHash(
  siteId: string,
  userId: string,
  passwordHash: string,
  db: Executor = getDb(),
): Promise<void> {
  await db
    .update(appUser)
    .set({ passwordHash, updatedAt: new Date() })
    .where(and(eq(appUser.siteId, siteId), eq(appUser.id, userId)));
}

export async function recordUserLogin(siteId: string, userId: string, now: Date, db: Executor = getDb()): Promise<void> {
  await db
    .update(appUser)
    .set({ lastLoginAt: now })
    .where(and(eq(appUser.siteId, siteId), eq(appUser.id, userId)));
}
