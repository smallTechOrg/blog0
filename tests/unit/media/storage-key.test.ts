import { describe, expect, it } from 'vitest';

import { isValidStorageKey, makeStorageKey, STORAGE_EXTENSIONS, STORAGE_KEY_RE } from '@/server/storage/types';

// Storage keys (spec/architecture.md §9.1): `<siteSlug>/<audio|image>/<yyyy>/<mm>/<uuid v4>.<ext>`
// is the only accepted shape; everything else is refused before any filesystem access.

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const GOOD = `blog0/audio/2026/10/${UUID}.mp3`;

describe('isValidStorageKey', () => {
  it('accepts the canonical shape for every stored extension', () => {
    for (const ext of Object.values(STORAGE_EXTENSIONS)) {
      const kind = ext === 'mp3' || ext === 'm4a' ? 'audio' : 'image';
      expect(isValidStorageKey(`blog0/${kind}/2026/10/${UUID}.${ext}`)).toBe(true);
    }
    expect(isValidStorageKey(`my-site-2/image/1999/01/${UUID}.png`)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['leading slash', `/${GOOD}`],
    ['dot-dot segment', `blog0/audio/2026/10/../${UUID}.mp3`],
    ['encoded traversal', `..%2F..%2Fetc%2Fpasswd`],
    ['plain traversal', `../../etc/passwd`],
    ['unknown kind', `blog0/video/2026/10/${UUID}.mp3`],
    ['unknown extension', `blog0/image/2026/10/${UUID}.svg`],
    ['uppercase uuid', `blog0/image/2026/10/${UUID.toUpperCase()}.png`],
    ['uppercase slug', `Blog0/image/2026/10/${UUID}.png`],
    ['slug with trailing dash', `blog0-/image/2026/10/${UUID}.png`],
    ['short year', `blog0/image/26/10/${UUID}.png`],
    ['missing month', `blog0/image/2026/${UUID}.png`],
    ['trailing newline', `${GOOD}\n`],
    ['null byte', `blog0/audio/2026/10/${UUID}.mp3\0`],
    ['backslash', `blog0\\audio\\2026\\10\\${UUID}.mp3`],
    ['query string', `${GOOD}?x=1`],
  ])('rejects %s', (_label, key) => {
    expect(isValidStorageKey(key)).toBe(false);
  });

  it('rejects keys longer than 160 characters even when the regex matches', () => {
    const longSlug = 'a'.repeat(120);
    const key = `${longSlug}/image/2026/10/${UUID}.png`;
    expect(STORAGE_KEY_RE.test(key)).toBe(true);
    expect(key.length).toBeGreaterThan(160);
    expect(isValidStorageKey(key)).toBe(false);
  });
});

describe('makeStorageKey', () => {
  it('builds <slug>/<kind>/<yyyy>/<mm>/<uuid>.<ext> from the mime and the date (UTC, zero-padded month)', () => {
    const key = makeStorageKey('blog0', 'image', 'image/jpeg', new Date('2026-03-05T23:59:59Z'));
    expect(key).toMatch(/^blog0\/image\/2026\/03\/[0-9a-f-]{36}\.jpg$/);
    expect(isValidStorageKey(key)).toBe(true);
  });

  it('maps every stored mime to its extension and yields a fresh uuid per call', () => {
    const now = new Date('2026-12-31T00:00:00Z');
    expect(makeStorageKey('blog0', 'audio', 'audio/mpeg', now)).toMatch(/\/2026\/12\/.*\.mp3$/);
    expect(makeStorageKey('blog0', 'audio', 'audio/mp4', now)).toMatch(/\.m4a$/);
    expect(makeStorageKey('blog0', 'image', 'image/png', now)).toMatch(/\.png$/);
    expect(makeStorageKey('blog0', 'image', 'image/webp', now)).toMatch(/\.webp$/);
    expect(makeStorageKey('blog0', 'image', 'image/gif', now)).toMatch(/\.gif$/);
    expect(makeStorageKey('blog0', 'image', 'image/png', now)).not.toBe(makeStorageKey('blog0', 'image', 'image/png', now));
  });
});
