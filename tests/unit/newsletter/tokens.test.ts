import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  hashConfirmToken,
  isWellFormedConfirmToken,
  isWellFormedUnsubscribeToken,
  newConfirmToken,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from '@/server/newsletter/tokens';

// Newsletter tokens (spec/architecture.md §13.1; capability newsletter-list.md "Unit" criterion):
// the stored confirm hash never equals the token; the unsubscribe token is a signed, stateless id.

const SECRET = 'a-session-secret-of-at-least-32-characters-long';

describe('confirm token', () => {
  it('newConfirmToken gives 32 random bytes as base64url and its sha256 hex hash', () => {
    const a = newConfirmToken();
    const b = newConfirmToken();
    expect(a.token).toHaveLength(43);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toBe(a.token);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });

  it('hashConfirmToken is deterministic and never equals its input', () => {
    const { token, hash } = newConfirmToken();
    expect(hashConfirmToken(token)).toBe(hash);
    expect(hashConfirmToken(token)).toBe(hashConfirmToken(token));
    expect(hashConfirmToken(token)).not.toBe(token);
    expect(hashConfirmToken(token + 'x')).not.toBe(hash);
  });

  it('isWellFormedConfirmToken accepts a real token and refuses everything else', () => {
    expect(isWellFormedConfirmToken(newConfirmToken().token)).toBe(true);
    expect(isWellFormedConfirmToken('not-a-token')).toBe(false);
    expect(isWellFormedConfirmToken('')).toBe(false);
    expect(isWellFormedConfirmToken(42)).toBe(false);
    expect(isWellFormedConfirmToken('a'.repeat(43))).toBe(true);
    expect(isWellFormedConfirmToken('a'.repeat(42))).toBe(false);
    expect(isWellFormedConfirmToken('a'.repeat(42) + '=')).toBe(false);
  });
});

describe('unsubscribe token', () => {
  it('round-trips through verifyUnsubscribeToken', () => {
    const id = randomUUID();
    const token = signUnsubscribeToken(id, SECRET);
    expect(isWellFormedUnsubscribeToken(token)).toBe(true);
    expect(verifyUnsubscribeToken(token, SECRET)).toBe(id);
    expect(signUnsubscribeToken(id, SECRET)).toBe(token); // stateless: the same id signs the same
  });

  it('has the <uuid-as-base64url>.<hmac-as-base64url> shape', () => {
    const token = signUnsubscribeToken('00000000-0000-4000-8000-000000000000', SECRET);
    const [idPart, sig] = token.split('.');
    expect(idPart).toHaveLength(22);
    expect(sig).toHaveLength(43);
    expect(Buffer.from(idPart, 'base64url').toString('hex')).toBe('00000000000040008000000000000000');
  });

  it('fails on a one-character change anywhere, on a different secret, and on garbage', () => {
    const id = randomUUID();
    const token = signUnsubscribeToken(id, SECRET);
    for (const pos of [0, 5, 21, 23, 30, token.length - 1]) {
      const ch = token[pos] === 'A' ? 'B' : 'A';
      const tampered = token.slice(0, pos) + ch + token.slice(pos + 1);
      expect(verifyUnsubscribeToken(tampered, SECRET), `position ${pos}`).toBeNull();
    }
    expect(verifyUnsubscribeToken(token, SECRET + '1')).toBeNull();
    expect(verifyUnsubscribeToken('', SECRET)).toBeNull();
    expect(verifyUnsubscribeToken('x.y', SECRET)).toBeNull();
    expect(isWellFormedUnsubscribeToken('x.y')).toBe(false);
    expect(isWellFormedUnsubscribeToken(null)).toBe(false);
  });

  it('refuses to sign a non-uuid id', () => {
    expect(() => signUnsubscribeToken('not-a-uuid', SECRET)).toThrow(/uuid/);
  });
});
