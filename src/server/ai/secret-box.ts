import 'server-only';

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import type { Secret } from '../config';

// Seals the AI provider's API key at rest (SMA-44). AES-256-GCM with a key derived (HKDF-SHA256)
// from BLOG0_SESSION_SECRET, so a database dump alone never reveals the key. Format:
// `v1.<iv b64url>.<tag b64url>.<ciphertext b64url>`. Rotating the session secret makes a stored
// key unreadable: `open` then returns null and the admin re-enters the key.

const VERSION = 'v1';
const INFO = 'blog0 ai-provider api key v1';

function keyFrom(secret: Secret): Buffer {
  return Buffer.from(hkdfSync('sha256', secret.reveal(), 'blog0', INFO, 32));
}

export function seal(plain: string, secret: Secret): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
}

/** The plain text, or null when the box is malformed or was sealed under another secret. */
export function open(sealed: string, secret: Secret): string | null {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const [, iv, tag, data] = parts;
    const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
