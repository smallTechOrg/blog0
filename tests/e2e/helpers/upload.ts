// Upload + media helpers for the Phase 3 E2E walks (S3.6): the committed audio / image fixtures,
// the E2E server's storage dir, and small API round trips (upload a recording, read a byte range
// from /media/<key>). No server-only imports — playwright.config.ts imports E2E_STORAGE_DIR.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, type APIRequestContext } from '@playwright/test';

/** Storage dir of the main E2E server (3411); wiped by tests/e2e/global-setup.ts. */
export const E2E_STORAGE_DIR = 'var/storage-e2e';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

export const AUDIO_FIXTURE = {
  mp3: path.join(FIXTURES, 'audio', 'sample.mp3'),
  meta: path.join(FIXTURES, 'audio', 'sample.json'),
} as const;

export const IMAGE_FIXTURE = {
  png: path.join(FIXTURES, 'images', 'sample.png'),
  meta: path.join(FIXTURES, 'images', 'sample.json'),
} as const;

export interface AudioFixtureMeta {
  text: string;
  mp3: { durationMs: number; bytes: number; sha256: string };
}

export function audioFixtureMeta(): AudioFixtureMeta {
  return JSON.parse(readFileSync(AUDIO_FIXTURE.meta, 'utf8')) as AudioFixtureMeta;
}

export function pngFixtureMeta(): { width: number; height: number; bytes: number } {
  const all = JSON.parse(readFileSync(IMAGE_FIXTURE.meta, 'utf8')) as Record<string, { width: number; height: number; bytes: number }>;
  return all['sample.png'];
}

export interface UploadedAudio {
  key: string;
  url: string;
  mimeType: string;
  bytes: number;
  durationMs: number;
}

/** POST …/audio with `sample.mp3` as the multipart `file`; returns the draft recording. */
export async function uploadSampleMp3(request: APIRequestContext, articleId: string, origin: string): Promise<{ status: string; audio: UploadedAudio }> {
  const res = await request.post(`/api/admin/articles/${articleId}/audio`, {
    headers: { origin },
    multipart: { file: { name: 'sample.mp3', mimeType: 'audio/mpeg', buffer: readFileSync(AUDIO_FIXTURE.mp3) } },
  });
  expect(res.status(), await res.text()).toBe(200);
  const listen = ((await res.json()) as { data: { listen: { status: string; audio: UploadedAudio } } }).data.listen;
  return { status: listen.status, audio: listen.audio };
}

/** GET /media/<key> with `Range: bytes=0-1` → asserts 206 and the two-byte Content-Range. */
export async function expectRange206(request: APIRequestContext, mediaUrl: string, totalBytes: number): Promise<Buffer> {
  const res = await request.get(mediaUrl, { headers: { Range: 'bytes=0-1' } });
  expect(res.status()).toBe(206);
  expect(res.headers()['content-range']).toBe(`bytes 0-1/${totalBytes}`);
  expect(res.headers()['accept-ranges']).toBe('bytes');
  const body = await res.body();
  expect(body.length).toBe(2);
  return body;
}
