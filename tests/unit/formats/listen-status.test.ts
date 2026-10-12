import { describe, expect, it } from 'vitest';

import type { RenderedArticle } from '@/lib/content/types';
import type { ArticleFormatRow, RevisionRow } from '@/server/db/schema';
import type { Tx } from '@/server/db/client';
import { listenAdapter } from '@/server/formats/listen';
import { listenBaseline, readListenPayload, type ListenPayload } from '@/server/formats/payload';

// Listen adapter status + publish rules (spec/architecture.md §5 as revised by the Phase 3 fix;
// spec/capabilities/listen-audio.md). missing | ready | text_changed, computed from the draft's
// baseline (uploadFingerprint ?? legacy syncFingerprint) vs the current paragraphs fingerprint.
// Listen never blocks publishing; publish copies the draft whatever its status.

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
    draftRevisionId: draft ? 'rev-1' : null,
    draftFingerprint: draft ? listenBaseline(draft) : null,
    draftUpdatedBy: 'u',
    draftUpdatedAt: NOW,
    publishedPayload: published,
    publishedRevisionId: published ? 'rev-0' : null,
    publishedFingerprint: published ? listenBaseline(published) : null,
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

/** Right after an upload: no stored marks, baseline = the paragraphs fingerprint at upload. */
const uploaded: ListenPayload = { audio, marks: [], syncFingerprint: null, uploadFingerprint: FP_A };
/** Upload + aligner-written marks (PUT) against the same text. */
const withMarks: ListenPayload = { audio, marks, syncFingerprint: FP_A, uploadFingerprint: FP_A };
/** Legacy Phase 3 rows had no uploadFingerprint. */
const legacySynced: ListenPayload = { audio, marks, syncFingerprint: FP_A, uploadFingerprint: null };
const legacyUnsynced: ListenPayload = { audio, marks: [], syncFingerprint: null, uploadFingerprint: null };

function status(r: ArticleFormatRow | null, fp: string) {
  return listenAdapter.computeStatus({ row: r, currentRevision: revision(fp), now: NOW });
}

describe('readListenPayload / listenBaseline', () => {
  it('parses a legacy payload without uploadFingerprint as null (zod default)', () => {
    const parsed = readListenPayload({ audio, marks, syncFingerprint: FP_A });
    expect(parsed).not.toBeNull();
    expect(parsed!.uploadFingerprint).toBeNull();
    expect(listenBaseline(parsed!)).toBe(FP_A);
  });

  it('prefers uploadFingerprint over syncFingerprint', () => {
    expect(listenBaseline({ uploadFingerprint: FP_B, syncFingerprint: FP_A })).toBe(FP_B);
    expect(listenBaseline({ uploadFingerprint: null, syncFingerprint: null })).toBeNull();
  });
});

describe('listenAdapter.computeStatus', () => {
  it('is missing with no row or no draft payload', () => {
    expect(status(null, FP_A)).toBe('missing');
    expect(status(row(null), FP_A)).toBe('missing');
  });

  it('is missing for a corrupt payload (never crashes a page)', () => {
    const bad = { ...row(null), draftPayload: { audio: { nope: true }, marks: 'x' } } as ArticleFormatRow;
    expect(status(bad, FP_A)).toBe('missing');
    expect(readListenPayload(bad.draftPayload)).toBeNull();
  });

  it('is ready right after an upload (no syncing step)', () => {
    expect(status(row(uploaded), FP_A)).toBe('ready');
  });

  it('is text_changed when the paragraphs fingerprint differs from the upload baseline; back to ready on revert', () => {
    expect(status(row(uploaded), FP_B)).toBe('text_changed');
    expect(status(row(uploaded), FP_A)).toBe('ready');
  });

  it('ignores stored marks: the baseline is uploadFingerprint even when syncFingerprint differs', () => {
    const alignedLater: ListenPayload = { ...withMarks, syncFingerprint: FP_B };
    expect(status(row(alignedLater), FP_A)).toBe('ready');
    expect(status(row(alignedLater), FP_B)).toBe('text_changed');
  });

  it('legacy rows fall back to syncFingerprint; a legacy unsynced row (no baseline) is ready', () => {
    expect(status(row(legacySynced), FP_A)).toBe('ready');
    expect(status(row(legacySynced), FP_B)).toBe('text_changed');
    expect(status(row(legacyUnsynced), FP_B)).toBe('ready');
  });

  it('only ever returns missing, ready or text_changed', () => {
    const rows = [null, row(null), row(uploaded), row(withMarks), row(legacySynced), row(legacyUnsynced)];
    for (const r of rows) for (const fp of [FP_A, FP_B]) expect(['missing', 'ready', 'text_changed']).toContain(status(r, fp));
  });
});

describe('listenAdapter chips', () => {
  const published = { status: 'published' as const, currentRevisionId: 'rev-1', publishedRevisionId: 'rev-0' };
  const draftArticle = { status: 'draft' as const, currentRevisionId: 'rev-1', publishedRevisionId: null };

  it('isPublished only when the article is published and a published Listen exists', () => {
    expect(listenAdapter.isPublished({ article: published, row: row(uploaded, uploaded) })).toBe(true);
    expect(listenAdapter.isPublished({ article: published, row: row(uploaded, null) })).toBe(false);
    expect(listenAdapter.isPublished({ article: draftArticle, row: row(uploaded, uploaded) })).toBe(false);
    expect(listenAdapter.isPublished({ article: published, row: null })).toBe(false);
  });

  it('hasUnpublishedChanges when the draft audio key or stored marks differ from the published copy', () => {
    expect(listenAdapter.hasUnpublishedChanges({ article: published, row: row(withMarks, withMarks) })).toBe(false);
    expect(listenAdapter.hasUnpublishedChanges({ article: published, row: row(null, null) })).toBe(false);
    const newAudio = { ...uploaded, audio: { ...audio, key: 'blog0/audio/2026/10/33333333-3333-4333-8333-333333333333.mp3' } };
    expect(listenAdapter.hasUnpublishedChanges({ article: published, row: row(newAudio, uploaded) })).toBe(true);
    expect(listenAdapter.hasUnpublishedChanges({ article: published, row: row(withMarks, uploaded) })).toBe(true);
    expect(listenAdapter.hasUnpublishedChanges({ article: published, row: row(null, uploaded) })).toBe(true);
    expect(listenAdapter.hasUnpublishedChanges({ article: published, row: row(uploaded, null) })).toBe(true);
    expect(listenAdapter.hasUnpublishedChanges({ article: draftArticle, row: row(uploaded, null) })).toBe(false);
  });
});

describe('listenAdapter.validateForPublish — Listen never blocks', () => {
  it('passes with no row, no draft, a ready draft, a text_changed draft, and a draft whose text changed under a live Listen', () => {
    const newPids = [PIDS[0], 'p-0009zzzz', PIDS[2]];
    const cases: Array<[ArticleFormatRow | null, string, readonly string[]]> = [
      [null, FP_A, PIDS],
      [row(null), FP_A, PIDS],
      [row(null, withMarks), FP_B, newPids],
      [row(uploaded), FP_A, PIDS],
      [row(uploaded), FP_B, newPids],
      [row(withMarks, withMarks), FP_B, newPids],
      [row(legacyUnsynced, legacySynced), FP_B, newPids],
    ];
    for (const [r, fp, pids] of cases) {
      expect(listenAdapter.validateForPublish({ row: r, revision: revision(fp), rendered: rendered(pids, fp) })).toEqual({ ok: true });
    }
  });
});

describe('listenAdapter.publish', () => {
  function fakeTx() {
    const sets: Array<Record<string, unknown>> = [];
    const tx = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          sets.push(values);
          return { where: async () => undefined };
        },
      }),
    } as unknown as Tx;
    return { tx, sets };
  }

  it('copies a text_changed draft (any status) with the baseline as published_fingerprint', async () => {
    const { tx, sets } = fakeTx();
    await listenAdapter.publish(tx, { row: row(uploaded), revision: revision(FP_B), userId: 'u', now: NOW });
    expect(sets).toEqual([{ publishedPayload: uploaded, publishedRevisionId: 'rev-1', publishedFingerprint: FP_A, publishedAt: NOW }]);
  });

  it('copies a legacy draft with syncFingerprint as the baseline', async () => {
    const { tx, sets } = fakeTx();
    await listenAdapter.publish(tx, { row: row(legacySynced), revision: revision(FP_A), userId: 'u', now: NOW });
    expect(sets[0]).toMatchObject({ publishedPayload: legacySynced, publishedFingerprint: FP_A });
  });

  it('clears the published copy when there is no draft; does nothing without a row', async () => {
    const { tx, sets } = fakeTx();
    await listenAdapter.publish(tx, { row: row(null, uploaded), revision: revision(FP_A), userId: 'u', now: NOW });
    expect(sets).toEqual([{ publishedPayload: null, publishedRevisionId: null, publishedFingerprint: null, publishedAt: null }]);
    const none = fakeTx();
    await listenAdapter.publish(none.tx, { row: null, revision: revision(FP_A), userId: 'u', now: NOW });
    expect(none.sets).toEqual([]);
  });
});
