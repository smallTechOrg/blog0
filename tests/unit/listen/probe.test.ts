// Audio probe (spec/architecture.md §9.3): content-detected type + duration via music-metadata,
// checked against the committed fixtures and the durations recorded in sample.json.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { describeDetected, probeAudio } from '@/server/listen/probe';

const FIXTURES = path.join(import.meta.dirname, '..', '..', 'fixtures', 'audio');
const known = JSON.parse(readFileSync(path.join(FIXTURES, 'sample.json'), 'utf8')) as {
  mp3: { durationMs: number; bytes: number };
  m4a: { durationMs: number; bytes: number };
  wav: { durationMs: number; bytes: number };
};

function fixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURES, name));
}

describe('probeAudio', () => {
  it('detects sample.mp3 as audio/mpeg with the recorded duration (±500 ms)', async () => {
    const buf = fixture('sample.mp3');
    expect(buf.byteLength).toBe(known.mp3.bytes);
    const result = await probeAudio(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.mimeType).toBe('audio/mpeg');
    expect(result.probe.container).toBe('MPEG');
    expect(Number.isInteger(result.probe.durationMs)).toBe(true);
    expect(Math.abs(result.probe.durationMs - known.mp3.durationMs)).toBeLessThanOrEqual(500);
  });

  it('detects sample.m4a as audio/mp4 (AAC in an M4A/isom container) with the recorded duration', async () => {
    const buf = fixture('sample.m4a');
    expect(buf.byteLength).toBe(known.m4a.bytes);
    const result = await probeAudio(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.mimeType).toBe('audio/mp4');
    expect(result.probe.codec).toContain('AAC');
    expect(Math.abs(result.probe.durationMs - known.m4a.durationMs)).toBeLessThanOrEqual(500);
  });

  it('refuses a WAV file by content, naming the detected container', async () => {
    const result = await probeAudio(fixture('not-audio.wav'));
    expect(result).toEqual({ ok: false, reason: 'unsupported', detected: 'WAVE audio' });
    if (!result.ok) expect(describeDetected(result)).toBe('WAVE audio');
  });

  it('refuses a renamed text file (1 byte) as "not an audio file"', async () => {
    const result = await probeAudio(Buffer.from('x'));
    expect(result).toEqual({ ok: false, reason: 'unsupported', detected: 'not an audio file' });
  });

  it('refuses an empty buffer and a buffer that only looks like an mp3 header', async () => {
    expect((await probeAudio(Buffer.alloc(0))).ok).toBe(false);
    // "ID3" tag header followed by garbage: no decodable MPEG frame, so no accepted type.
    const fake = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x0a'), Buffer.alloc(10, 0x41)]);
    expect((await probeAudio(fake)).ok).toBe(false);
  });
});
