import { describe, expect, it } from 'vitest';

import { open, seal } from '@/server/ai/secret-box';
import { Secret } from '@/server/config';

// SMA-44: the AI provider key at rest — AES-256-GCM under a key derived from the session secret.

const SECRET = new Secret('unit-test-session-secret-0123456789-abcdefgh');

describe('secret-box', () => {
  it('round-trips, never contains the plain text, and differs per seal (random IV)', () => {
    const a = seal('sk-live-123', SECRET);
    const b = seal('sk-live-123', SECRET);
    expect(a).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(a).not.toContain('sk-live-123');
    expect(a).not.toBe(b);
    expect(open(a, SECRET)).toBe('sk-live-123');
  });

  it('returns null under another secret, for a tampered box, or for garbage', () => {
    const box = seal('sk-live-123', SECRET);
    expect(open(box, new Secret('another-session-secret-0123456789-abcdefgh'))).toBeNull();
    const parts = box.split('.');
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('A') ? 'BB' : 'AA');
    expect(open(parts.join('.'), SECRET)).toBeNull();
    expect(open('v2.a.b.c', SECRET)).toBeNull();
    expect(open('nope', SECRET)).toBeNull();
  });
});
