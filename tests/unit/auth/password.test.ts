import { describe, expect, it } from 'vitest';

import {
  hashPassword,
  passwordPolicyProblem,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
  verifyAgainstDummy,
} from '@/server/auth/password';

describe('password hashing', () => {
  it('hashes with argon2id at the spec parameters and never contains the clear password', async () => {
    const password = 'correct horse battery';

    const hash = await hashPassword(password);

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(hash).not.toContain(password);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');

    const right = await verifyPassword(hash, 'correct horse battery');
    const wrong = await verifyPassword(hash, 'correct horse batterY');

    expect(right).toBe(true);
    expect(wrong).toBe(false);
  });

  it('salts every hash so the same password hashes differently', async () => {
    const first = await hashPassword('same password twice');

    const second = await hashPassword('same password twice');

    expect(first).not.toBe(second);
  });

  it('treats a malformed or placeholder stored hash as a failed verification instead of throwing', async () => {
    const placeholder = await verifyPassword('$test-helper$not-a-real-hash', 'anything at all');
    const empty = await verifyPassword('', 'anything at all');

    expect(placeholder).toBe(false);
    expect(empty).toBe(false);
  });

  it('spends a real verification on unknown emails and always reports failure', async () => {
    const result = await verifyAgainstDummy('whatever password');

    expect(result).toBe(false);
  });
});

describe('password policy', () => {
  it('accepts 12 to 200 characters and explains anything outside that', () => {
    const tooShort = passwordPolicyProblem('a'.repeat(PASSWORD_MIN_LENGTH - 1));
    const shortest = passwordPolicyProblem('a'.repeat(PASSWORD_MIN_LENGTH));
    const longest = passwordPolicyProblem('a'.repeat(PASSWORD_MAX_LENGTH));
    const tooLong = passwordPolicyProblem('a'.repeat(PASSWORD_MAX_LENGTH + 1));

    expect(tooShort).toMatch(/at least 12 characters/);
    expect(shortest).toBeNull();
    expect(longest).toBeNull();
    expect(tooLong).toMatch(/at most 200 characters/);
  });
});
