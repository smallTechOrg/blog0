import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { FormatChips } from '@/components/admin/FormatChips';
import type { FormatKind } from '@/lib/formats/registry';
import { FORMAT_KINDS, FORMATS } from '@/lib/formats/registry';
import { buildChips } from '@/server/articles/views';
import type { ArticleFormatRow, ArticleRow, RevisionRow } from '@/server/db/schema';
import type { FormatAdapter } from '@/server/formats/types';

// The chip list is registry-driven (spec/architecture.md §5): a new format kind is one registry
// entry (src/lib/formats/registry.ts: kind + label) plus one adapter (src/server/formats) — no
// chip/desk code changes. Proven by registering a fake `quiz` kind: buildChips emits its chip in
// registry order and FormatChips renders it with the registry label. Behaviour is unchanged: the
// fake exists only inside this file's module mocks.

// Hoisted with the vi.mock factories below (they run before this module's top level).
const { QUIZ, quizAdapter } = vi.hoisted(() => {
  const kind = 'quiz' as FormatKind;
  const adapter: FormatAdapter = {
    kind,
    computeStatus: ({ row }) => (row?.draftPayload ? 'ready' : 'missing'),
    isPublished: ({ article, row }) => article.status === 'published' && !!row?.publishedPayload,
    hasUnpublishedChanges: () => false,
    validateForPublish: () => ({ ok: true }),
    publish: async () => {},
  };
  return { QUIZ: kind, quizAdapter: adapter };
});

vi.mock('@/lib/formats/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/formats/registry')>();
  return {
    ...actual,
    FORMAT_KINDS: [...actual.FORMAT_KINDS, 'quiz'],
    FORMATS: { ...actual.FORMATS, quiz: { label: 'Quiz', icon: 'bolt' } },
  };
});

// The server-side adapter list for the registered kinds: the real read/tldr/listen adapters
// (from the real module) + the fake quiz adapter, in FORMAT_KINDS order.
vi.mock('@/server/formats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/formats')>();
  const { FORMAT_KINDS: kinds } = await import('@/lib/formats/registry');
  const real = new Map(
    actual
      .formatAdapters()
      .filter((a): a is FormatAdapter => a !== undefined)
      .map((a) => [a.kind, a]),
  );
  real.set(QUIZ, quizAdapter);
  return { ...actual, formatAdapters: () => kinds.map((k) => real.get(k)!) };
});

const NOW = new Date('2026-10-12T10:00:00Z');
const article = {
  id: 'a-1',
  status: 'draft',
  currentRevisionId: 'rev-1',
  publishedRevisionId: null,
} as unknown as ArticleRow;
const revision = {
  id: 'rev-1',
  bodyMd: 'Some text.',
  sentencesFingerprint: 'fp-s',
  paragraphsFingerprint: 'fp-p',
} as unknown as RevisionRow;

describe('format registry → chips', () => {
  it('a registered fake kind is part of the registry', () => {
    expect(FORMAT_KINDS).toEqual(['read', 'tldr', 'listen', 'quiz']);
    expect(FORMATS[QUIZ]).toEqual({ label: 'Quiz', icon: 'bolt' });
  });

  it('buildChips emits one chip per registered kind, in registry order, the fake included', () => {
    const chips = buildChips({ article, revision, rows: [], latestTldrGeneration: null, now: NOW });

    expect(chips.map((c) => c.kind)).toEqual(['read', 'tldr', 'listen', 'quiz']);
    expect(chips.at(-1)).toEqual({ kind: 'quiz', status: 'missing', published: false, hasUnpublishedChanges: false });
  });

  it('the fake chip follows its adapter (a draft row → ready) and FormatChips renders it with the registry label', () => {
    const quizRow = { kind: 'quiz', draftPayload: { q: 1 }, publishedPayload: null } as unknown as ArticleFormatRow;
    const chips = buildChips({ article, revision, rows: [quizRow], latestTldrGeneration: null, now: NOW });
    const html = renderToStaticMarkup(<FormatChips formats={chips} />);

    expect(chips.find((c) => c.kind === QUIZ)?.status).toBe('ready');
    const items = html.match(/<li [^>]*data-kind="[a-z]+"[^>]*>[^<]*/g) ?? [];
    expect(items).toHaveLength(4);
    expect(items.map((li) => /data-kind="([a-z]+)"/.exec(li)![1])).toEqual(['read', 'tldr', 'listen', 'quiz']);
    expect(items[3]).toContain('data-status="ready"');
    expect(items[3]).toMatch(/>Quiz ready$/);
    expect(html).toContain('Read ✓');
    expect(html).toContain('TLDR missing');
    expect(html).toContain('Listen missing');
  });
});
