// Stage C known-device cookie (spec/architecture.md §6; capability admin-auth): the signed
// `blog0_device` value — format, HMAC verification, tamper / expiry / future-skew rejection,
// epoch invalidation and the Set-Cookie attributes. Pure: an explicit secret, injected `now`.
import { describe, expect, it } from 'vitest';

import {
  KNOWN_DEVICE_COOKIE_NAME,
  KNOWN_DEVICE_TTL_MS,
  isKnownDeviceFor,
  issueKnownDevice,
  readKnownDeviceCookie,
  serializeKnownDeviceCookie,
  verifyKnownDevice,
} from '@/server/auth/known-device';

const SECRET = 'unit-test-session-secret-0123456789abcdef';
const OTHER_SECRET = 'another-session-secret-0123456789abcdef!';
const USER = '0b6c6f0e-1d1e-4c55-9a43-2f7f3c1e8a11';
const OTHER_USER = '5a1d3c47-8e2b-4f0a-b1c9-6d2e7f8a9b00';
const T0 = new Date(Date.UTC(2026, 9, 19, 9, 0, 0));

describe('known-device cookie value', () => {
  it('issues a value that verifies to the same user, a random device id and the issue time', () => {
    const a = issueKnownDevice(USER, T0, SECRET);
    const b = issueKnownDevice(USER, T0, SECRET);
    expect(a.value).toMatch(/^v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{22}\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(a.expiresAt.getTime()).toBe(T0.getTime() + KNOWN_DEVICE_TTL_MS);
    expect(KNOWN_DEVICE_TTL_MS).toBe(180 * 24 * 60 * 60 * 1000);
    expect(a.value).not.toBe(b.value);

    const parsed = verifyKnownDevice(a.value, T0, SECRET);
    expect(parsed).toEqual({ userId: USER, deviceId: a.deviceId, issuedAt: T0 });
  });

  it('keeps a given device id when re-issued', () => {
    const first = issueKnownDevice(USER, T0, SECRET);
    const again = issueKnownDevice(USER, new Date(T0.getTime() + 1000), SECRET, first.deviceId);
    expect(again.deviceId).toBe(first.deviceId);
    expect(verifyKnownDevice(again.value, new Date(T0.getTime() + 1000), SECRET)?.deviceId).toBe(first.deviceId);
  });

  it('rejects tampering: another user id, device id, issue time, signature or secret', () => {
    const { value } = issueKnownDevice(USER, T0, SECRET);
    const [v, user, device, issued, sig] = value.split('.');
    expect(verifyKnownDevice([v, OTHER_USER, device, issued, sig].join('.'), T0, SECRET)).toBeNull();
    expect(verifyKnownDevice([v, user, `${device.slice(0, -1)}${device.endsWith('A') ? 'B' : 'A'}`, issued, sig].join('.'), T0, SECRET)).toBeNull();
    expect(verifyKnownDevice([v, user, device, String(Number(issued) + 1), sig].join('.'), T0, SECRET)).toBeNull();
    expect(verifyKnownDevice([v, user, device, issued, `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`].join('.'), T0, SECRET)).toBeNull();
    expect(verifyKnownDevice(['v2', user, device, issued, sig].join('.'), T0, SECRET)).toBeNull();
    expect(verifyKnownDevice(value, T0, OTHER_SECRET)).toBeNull();
  });

  it('rejects malformed values (empty, too long, wrong part count, non-numeric time)', () => {
    for (const bad of ['', 'v1', 'v1....', 'x'.repeat(400), 'v1.a.b.c', `v1.${USER}.abc.notanumber.sig`]) {
      expect(verifyKnownDevice(bad, T0, SECRET)).toBeNull();
    }
  });

  it('expires after 180 days and rejects an issue time far in the future', () => {
    const { value } = issueKnownDevice(USER, T0, SECRET);
    expect(verifyKnownDevice(value, new Date(T0.getTime() + KNOWN_DEVICE_TTL_MS - 1), SECRET)).not.toBeNull();
    expect(verifyKnownDevice(value, new Date(T0.getTime() + KNOWN_DEVICE_TTL_MS), SECRET)).toBeNull();
    const future = issueKnownDevice(USER, new Date(T0.getTime() + 10 * 60 * 1000), SECRET);
    expect(verifyKnownDevice(future.value, T0, SECRET)).toBeNull();
  });

  it('isKnownDeviceFor: same user, enabled, issued after the device epoch', () => {
    const parsed = verifyKnownDevice(issueKnownDevice(USER, T0, SECRET).value, T0, SECRET)!;
    const user = { id: USER, disabledAt: null, devicesValidAfter: null };
    expect(isKnownDeviceFor(parsed, user)).toBe(true);
    expect(isKnownDeviceFor(parsed, { ...user, id: OTHER_USER })).toBe(false);
    expect(isKnownDeviceFor(parsed, { ...user, disabledAt: T0 })).toBe(false);
    expect(isKnownDeviceFor(parsed, { ...user, devicesValidAfter: new Date(T0.getTime() - 1) })).toBe(true);
    expect(isKnownDeviceFor(parsed, { ...user, devicesValidAfter: T0 })).toBe(false);
    expect(isKnownDeviceFor(parsed, { ...user, devicesValidAfter: new Date(T0.getTime() + 1) })).toBe(false);
    expect(isKnownDeviceFor(null, user)).toBe(false);
  });
});

describe('known-device Set-Cookie / Cookie header', () => {
  it('serializes HttpOnly, SameSite=Lax, path /, 180-day Max-Age; Secure only when asked', () => {
    const { value, expiresAt } = issueKnownDevice(USER, T0, SECRET);
    const plain = serializeKnownDeviceCookie(value, expiresAt, T0, false);
    expect(plain).toBe(
      `${KNOWN_DEVICE_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=15552000; Expires=${expiresAt.toUTCString()}`,
    );
    expect(serializeKnownDeviceCookie(value, expiresAt, T0, true).split('; ')).toContain('Secure');
    expect(KNOWN_DEVICE_COOKIE_NAME).toBe('blog0_device');
  });

  it('reads blog0_device from a Cookie header beside other cookies', () => {
    expect(readKnownDeviceCookie('blog0_session=abc; blog0_device=v1.x.y.1.z; other=1')).toBe('v1.x.y.1.z');
    expect(readKnownDeviceCookie('blog0_session=abc')).toBeNull();
    expect(readKnownDeviceCookie('blog0_device=')).toBeNull();
    expect(readKnownDeviceCookie(null)).toBeNull();
  });
});
