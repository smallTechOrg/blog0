import { describe, expect, it } from 'vitest';

import type { RenderedArticle } from '@/lib/content/types';
import type { ArticleFormatRow, RevisionRow } from '@/server/db/schema';
import { listenAdapter } from '@/server/formats/listen';
import { readListenPayload, type ListenPayload } from '@/server/formats/payload';

// Listen adapter status + publish rules (spec/architecture.md §5, spec/capabilities/listen-sync.md
// → Publishing). Status is computed from payload + fingerprints; nothing is stored.

const NOW = new Date('2026-10-12T10:00:00Z');
const FP_A = 'fp-paragraphs-a';
const FP_B = 'fp-paragraphs-b';
const PIDS = ['p-0001aaaa', 'p-0002bbbb', 'p-0003cccc'];

const audio: ListenPayload['audio'] = {
  assetId: '11111111-1111-4111-8111-111111111111',
  key: 'blog0/audio/2026/10/22222222-2222-4222-8222-222222222222.mp3',
  mimeType: 'audio/mpeg',
  bytes: 321_000,
  durationMs: 20_000,
};
const marks = PIDS.map((pid, i) => ({ pid, tMs: 1_000 + i * 5_000 }));

function revision(paragraphsFingerprint: string, bodyMd = 'Some text.'): RevisionRow {
  return {
    id: 'rev-1',
    siteId: 'site',
    articleId: 'art',
    number: 1,
    title: 'T',
    dek: '',
    bodyMd,
    bodyFingerprint: 'b',
    paragraphsFingerprint,
    sentencesFingerprint: 's',
    wordCount: 2,
    eligibleSentenceCount: 1,
    restoredFromRevisionId: null,
    createdBy: 'u',
    createdAt: NOW,
  } as RevisionRow;
}

function row(draft: ListenPayload | null, published: ListenPayload | null = null): ArticleFormatRow {
  return {
    id: 'fmt-1',
    siteId: 'site',
    articleId: 'art',
    kind: 'listen',
    draftPayload: draft,
    draftRevisionId: draft?.syncFingerprint ? 'rev-1' : null,
    draftFingerprint: draft?.syncFingerprint ?? null,
    draftUpdatedBy: 'u',
    draftUpdatedAt: NOW,
    publishedPayload: published,
    publishedRevisionId: published ? 'rev-0' : null,
    publishedFingerprint: published?.syncFingerprint ?? null,
    publishedAt: published ? NOW : null,
    createdAt: NOW,
    updatedAt: NOW,
  } as ArticleFormatRow;
}

function rendered(pids: readonly string[], paragraphsFingerprint: string): RenderedArticle {
  return {
    blocks: [],
    paragraphs: pids.map((pid, index) => ({ pid, index, text: `Paragraph ${index}`, kind: 'p', headingPath: [] })),
    sentences: [],
    stats: { words: 10, readMinutes: 1 },
    fingerprints: { body: 'b', paragraphs: paragraphsFingerprint, sentences: 's' },
    warnings: [],
  };
}

const unsynced: ListenPayload = { audio, marks: [], syncFingerprint: null };
const synced: ListenPayload = { audio, marks, syncFingerprint: FP_A };

describe('listenAdapter.computeStatus', () => {
  it('is missing with no row or no draft payload', () => {
    expect(listenAdapter.computeStatus({ row: null, currentRevision: revision(FP_A), now: NOW })).toBe('missing');
    expect(listenAdapter.computeStatus({ row: row(null), currentRevision: revision(FP_A), now: NOW })).toBe('missing');
  });

  it('is missing for a corrupt payload (never crashes a page)', () => {
    const bad = { ...row(null), draftPayload: { audio: { nope: true }, marks: 'x' } } as ArticleFormatRow;
    expect(listenAdapter.computeStatus({ row: bad, currentRevision: revision(FP_A), now: NOW })).toBe('missing');
    expect(readListenPayload(bad.draftPayload)).toBeNull();
  });

  it('is needs_sync right after an upload (audio, no marks)', () => {
    expect(listenAdapter.computeStatus({ row: row(unsynced), currentRevision: revision(FP_A), now: NOW })).toBe('needs_sync');
  });

  it('is ready when the sync fingerprint equals the current paragraphs fingerprint, else stale', () => {
    expect(listenAdapter.computeStatus({ row: row(synced), currentRevision: revision(FP_A), now: NOW })).toBe('ready');
    expect(listenAdapter.computeStatus({ row: row(synced), currentRevision: revision(FP_B), now: NOW })).toBe('stale');
  });

  it('never returns unavailable, generating or failed', () => {
    const statuses = [null, row(null), row(unsynced), row(synced)].map((r) =>
      listenAdapter.computeStatus({ row: r, currentRevision: revision(FP_B), now: NOW }),
    );
    for (const s of statuses) expect(['missing', 'needs_sync', 'ready', 'stale']).toContain(s);
  });
});

describe('listenAdapter chips', () => {
  const published = { status: 'published' as const, currentRevisionId: 'rev-1', publishedRevisionId: 'rev-0' };
  const draftArticle = { status: 'draft' as const, currentRevisionId: 'rev-1', publishedRevisionId: null };

  it('isPublished only when the article is published and a published Listen exists', () => {
    expect(listenAdapter.isPublished({ article: published, row: row(synced, synced) })).toBe(true);
    expect(listenAdapter.isPublished({ article: published, row: row(synced, null) })).toBe(false);
    expect(listenAdapter.isPublished({ article: draftArticle, row: row(synced, synced) })).toBe(false);
    expect(listenAdapter.isPublished({ article: published, row: null })).toBe(false);
  });

  it('hasUnpublishedChanges when the draft audio key or marks differ from the published copy', () => {
    expect(listenAdapter.hasUnpublishedChanges({ article: published, row: row(synced, synced) })).toBe(false);
    expect(listenAdapter.hasUnpublishedChanges({ article: published, row: row(null, null) })).toBe(false);
    const newAudio = { ...synced, audio: { ...audio, key: 'blog0/audio/2026/10/33333333-3333-4333-8333-333333333333.mp3' } };
    expect(listenAdapter.hasUnpublishedChanges({ article: published, row: row(newAudio, synced) })).toBe(true);
    const nudged = { ...synced, marks: marks.map((m, i) => (i === 1 ? { ...m, tMs: m.tMs + 250 } : m)) };
    expect(listenAdapter.hasUnpublishedChanges({ article: published, row: row(nudged, synced) })).toBe(true);
    expect(listenAdapter.hasUnpublishedChanges({ article: published, row: row(null, synced) })).toBe(true);
    expect(listenAdapter.hasUnpublishedChanges({ article: published, row: row(unsynced, null) })).toBe(true);
    expect(listenAdapter.hasUnpublishedChanges({ article: draftArticle, row: row(unsynced, null) })).toBe(false);
  });
});

describe('listenAdapter.validateForPublish', () => {
  it('passes with no row, no draft, or a ready draft', () => {
    expect(listenAdapter.validateForPublish({ row: null, revision: revision(FP_A), rendered: rendered(PIDS, FP_A) })).toEqual({ ok: true });
    expect(listenAdapter.validateForPublish({ row: row(null), revision: revision(FP_A), rendered: rendered(PIDS, FP_A) })).toEqual({ ok: true });
    expect(listenAdapter.validateForPublish({ row: row(synced), revision: revision(FP_A), rendered: rendered(PIDS, FP_A) })).toEqual({ ok: true });
  });

  it('blocks a stale draft with LISTEN_STALE carrying missingPids and orphanPids', () => {
    const newPids = [PIDS[0], 'p-0009zzzz', PIDS[2]];
    const check = listenAdapter.validateForPublish({ row: row(synced), revision: revision(FP_B), rendered: rendered(newPids, FP_B) });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe('LISTEN_STALE');
    expect(check.message).toMatch(/text changed/i);
    expect(check.details).toEqual({ missingPids: ['p-0009zzzz'], orphanPids: [PIDS[1]] });
  });

  it('allows an unsynced draft when there is no published Listen or the published one still matches', () => {
    expect(listenAdapter.validateForPublish({ row: row(unsynced, null), revision: revision(FP_B), rendered: rendered(PIDS, FP_B) })).toEqual({ ok: true });
    expect(listenAdapter.validateForPublish({ row: row(unsynced, synced), revision: revision(FP_A), rendered: rendered(PIDS, FP_A) })).toEqual({ ok: true });
  });

  it('blocks an unsynced draft when the live reading no longer matches the text', () => {
    const newPids = ['p-0009zzzz', PIDS[1], PIDS[2]];
    const check = listenAdapter.validateForPublish({ row: row(unsynced, synced), revision: revision(FP_B), rendered: rendered(newPids, FP_B) });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe('LISTEN_STALE');
    expect(check.message).toMatch(/live reading no longer matches/i);
    expect(check.details).toEqual({ missingPids: ['p-0009zzzz'], orphanPids: [PIDS[0]] });
  });
});
