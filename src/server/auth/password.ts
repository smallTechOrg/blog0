import 'server-only';

import { hash, verify, type Algorithm } from '@node-rs/argon2';

// Password hashing (spec/architecture.md §6): argon2id, memoryCost 19456 KiB, timeCost 2,
// parallelism 1; PHC string stored in app_user.password_hash. Clear passwords are never stored
// or logged.

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

// `Algorithm` is an ambient const enum (not importable as a value under isolatedModules).
const ARGON2ID = 2 as Algorithm;

const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/** true only when `password` matches the stored PHC hash; malformed hashes verify as false. */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  if (!storedHash.startsWith('$argon2')) return false;
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * Runs one real argon2 verification against a throwaway hash so an unknown email costs the same
 * time as a wrong password (no account enumeration by timing). Always false.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('blog0-dummy-password-for-timing');
  await verifyPassword(await dummyHash, password);
  return false;
}

/** null when acceptable, else a human-readable problem (used by seed, CLI and later the Team page). */
export function passwordPolicyProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  return null;
}
