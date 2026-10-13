import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Newsletter tokens (spec/architecture.md §13.1, pure):
// - confirm token: 32 random bytes → base64url; only sha256hex(token) is stored, so a database copy
//   cannot confirm anyone;
// - unsubscribe token: stateless, `<uuid-as-base64url>.<base64url(HMAC-SHA256(secret, DOMAIN + id))>`
//   signed with the session secret (domain-separated), never expiring — an unsubscribe must always
//   work, and Listmonk-sent issues can carry the link as a subscriber attribute.

const UNSUBSCRIBE_DOMAIN = 'blog0.newsletter.unsubscribe:';
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ConfirmToken {
  /** The secret the email carries (43 chars base64url). */
  token: string;
  /** sha256 hex of `token` — what the row stores. */
  hash: string;
}

export function newConfirmToken(): ConfirmToken {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashConfirmToken(token) };
}

export function hashConfirmToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Shape check before any lookup or rate counting: 43 base64url chars (32 bytes). */
export function isWellFormedConfirmToken(value: unknown): value is string {
  return typeof value === 'string' && value.length === 43 && BASE64URL_RE.test(value);
}

function uuidToBase64url(id: string): string {
  return Buffer.from(id.replace(/-/g, ''), 'hex').toString('base64url');
}

function base64urlToUuid(value: string): string | null {
  const hex = Buffer.from(value, 'base64url').toString('hex');
  if (hex.length !== 32) return null;
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return UUID_RE.test(id) ? id : null;
}

function unsubscribeSignature(subscriberId: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(UNSUBSCRIBE_DOMAIN + subscriberId, 'utf8').digest();
}

export function signUnsubscribeToken(subscriberId: string, secret: string): string {
  if (!UUID_RE.test(subscriberId)) throw new Error('signUnsubscribeToken: subscriberId must be a uuid');
  return `${uuidToBase64url(subscriberId)}.${unsubscribeSignature(subscriberId, secret).toString('base64url')}`;
}

/** `<22 base64url>.<43 base64url>` — checked before any lookup or rate counting. */
export function isWellFormedUnsubscribeToken(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const dot = value.indexOf('.');
  if (dot !== 22 || value.length !== 22 + 1 + 43) return false;
  return BASE64URL_RE.test(value.slice(0, dot)) && BASE64URL_RE.test(value.slice(dot + 1));
}

/** The subscriber id the token names, or null when malformed or tampered (constant-time compare). */
export function verifyUnsubscribeToken(token: string, secret: string): string | null {
  if (!isWellFormedUnsubscribeToken(token)) return null;
  const [idPart, sigPart] = token.split('.');
  const id = base64urlToUuid(idPart);
  if (!id) return null;
  const given = Buffer.from(sigPart, 'base64url');
  const expected = unsubscribeSignature(id, secret);
  if (given.length !== expected.length) return null;
  return timingSafeEqual(given, expected) ? id : null;
}
