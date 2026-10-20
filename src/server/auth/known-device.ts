import 'server-only';

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { getConfig } from '../config';

// Known-device cookie (Stage C; spec/architecture.md §6, capability admin-auth). Every successful
// sign-in sets `blog0_device` = `v1.<userId>.<deviceId>.<issuedAtMs>.<sig>`, where sig =
// base64url(HMAC-SHA256(K, "v1.<userId>.<deviceId>.<issuedAtMs>")) and K = HMAC-SHA256(
// BLOG0_SESSION_SECRET, "blog0/known-device/v1") — a key derived only for this purpose, so a device
// signature can never double as a session-token hash. On sign-in a cookie that verifies, is under
// 180 days old, belongs to the account whose email is tried, and was issued after that user's
// `devices_valid_after` (set by reset-password) makes the attempt a "known device": it skips the
// shared per-email delay (auth/rate-limit.ts). Logout leaves the cookie in place.
// > Assumed (Stage C): 180-day lifetime; ±5 min clock skew allowance for the issue time.

export const KNOWN_DEVICE_COOKIE_NAME = 'blog0_device';
export const KNOWN_DEVICE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const VERSION = 'v1';
const KEY_LABEL = 'blog0/known-device/v1';
const MAX_LENGTH = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const SIG_RE = /^[A-Za-z0-9_-]{43}$/;

export interface KnownDevice {
  userId: string;
  deviceId: string;
  issuedAt: Date;
}

export interface IssuedKnownDevice {
  value: string;
  deviceId: string;
  expiresAt: Date;
}

function sessionSecret(secret?: string): string {
  return secret ?? getConfig().sessionSecret.reveal();
}

function sign(payload: string, secret: string): string {
  const key = createHmac('sha256', secret).update(KEY_LABEL).digest();
  return createHmac('sha256', key).update(payload).digest('base64url');
}

/** A fresh signed value for `userId` issued at `now` (a new random device id unless one is given). */
export function issueKnownDevice(userId: string, now: Date, secret?: string, deviceId?: string): IssuedKnownDevice {
  const id = deviceId && DEVICE_ID_RE.test(deviceId) ? deviceId : randomBytes(16).toString('base64url');
  const payload = `${VERSION}.${userId}.${id}.${now.getTime()}`;
  return { value: `${payload}.${sign(payload, sessionSecret(secret))}`, deviceId: id, expiresAt: new Date(now.getTime() + KNOWN_DEVICE_TTL_MS) };
}

/** The verified content of a cookie value, or null (malformed, bad signature, expired, issued in the future). */
export function verifyKnownDevice(value: string | null | undefined, now: Date = new Date(), secret?: string): KnownDevice | null {
  if (!value || value.length > MAX_LENGTH) return null;
  const parts = value.split('.');
  if (parts.length !== 5) return null;
  const [version, userId, deviceId, issued, sig] = parts;
  if (version !== VERSION || !UUID_RE.test(userId) || !DEVICE_ID_RE.test(deviceId) || !/^\d{1,15}$/.test(issued) || !SIG_RE.test(sig)) {
    return null;
  }
  // Compare the base64url strings (not decoded bytes): every character of the value is authenticated.
  const expected = Buffer.from(sign(`${version}.${userId}.${deviceId}.${issued}`, sessionSecret(secret)));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const issuedMs = Number(issued);
  if (now.getTime() - issuedMs >= KNOWN_DEVICE_TTL_MS || issuedMs - now.getTime() > FUTURE_SKEW_MS) return null;
  return { userId, deviceId, issuedAt: new Date(issuedMs) };
}

/** True when a verified device belongs to `user`, the user is enabled, and it postdates the device epoch. */
export function isKnownDeviceFor(
  device: KnownDevice | null,
  user: { id: string; disabledAt: Date | null; devicesValidAfter: Date | null },
): boolean {
  if (!device || device.userId !== user.id || user.disabledAt !== null) return false;
  return user.devicesValidAfter === null || device.issuedAt.getTime() > user.devicesValidAfter.getTime();
}

/** `Set-Cookie` for the device value (HttpOnly, SameSite=Lax, path /, Secure when `secure`). */
export function serializeKnownDeviceCookie(value: string, expiresAt: Date, now: Date = new Date(), secure: boolean = isSecureBase()): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  const parts = [`${KNOWN_DEVICE_COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`, `Expires=${expiresAt.toUTCString()}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function isSecureBase(): boolean {
  return getConfig().publicBaseUrl.startsWith('https://');
}

/** The `blog0_device` value from a raw `Cookie` header, or null. */
export function readKnownDeviceCookie(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === KNOWN_DEVICE_COOKIE_NAME) {
      const value = part.slice(eq + 1).trim();
      return value === '' ? null : value;
    }
  }
  return null;
}
