// The committed TLDR deck fixtures (src/server/seed/decks/<slug>.json) must stay valid:
// one per seed post, the right shape, 4–8 lines, every line byte-identical to an ELIGIBLE sentence
// of that seed post as rendered by the content pipeline. A fixture drifting from its article fails
// here (the unit gate) rather than silently losing lines at seed time.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { renderArticle } from '@/server/content';
import { DeckFixtureError, deckFixtureSchema, loadDeckFixture, matchFixtureLines, writeDeckFixture, type DeckFixture } from '@/server/seed/decks';
import { loadSeedPosts, SEED_POSTS } from '@/server/seed/posts';
import { formatSeedTldrSummary, resolveSeedTldrSource, SeedTldrError } from '@/server/seed/seed-tldr';

describe('committed deck fixtures', () => {
  for (const post of loadSeedPosts()) {
    it(`${post.slug}.json: valid, 4–8 lines, every line an eligible sentence of the article verbatim`, async () => {
      const fixture = loadDeckFixture(post.slug);
      expect(fixture, `src/server/seed/decks/${post.slug}.json is missing — run: pnpm seed:tldr -- --write-fixture`).not.toBeNull();
      expect(fixture!.slug).toBe(post.slug);
      expect(fixture!.lines.length).toBeGreaterThanOrEqual(4);
      expect(fixture!.lines.length).toBeLessThanOrEqual(8);

      const rendered = await renderArticle({ title: post.title, dek: post.dek, bodyMd: post.bodyMd });
      const eligible = new Set(rendered.sentences.map((s) => s.text));
      for (const line of fixture!.lines) {
        expect(eligible.has(line.text), `not an eligible sentence of ${post.slug}: ${line.text}`).toBe(true);
        expect(line.reason.length).toBeGreaterThan(0);
        expect(line.reason.length).toBeLessThanOrEqual(200);
      }
      const match = matchFixtureLines(fixture!.lines, rendered.sentences);
      expect(match.unmatched).toEqual([]);
      expect(match.matched).toHaveLength(fixture!.lines.length); // no duplicate lines
      // Lines keep article order (Jev picks are ascending).
      const order = match.matched.map((m) => rendered.sentences.findIndex((s) => s.sid === m.sid));
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });
  }

  it('there is exactly one fixture per seed post', async () => {
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(path.join(process.cwd(), 'src', 'server', 'seed', 'decks')).filter((f) => f.endsWith('.json'));
    expect(files.sort()).toEqual(SEED_POSTS.map((p) => `${p.slug}.json`).sort());
  });
});

describe('matchFixtureLines', () => {
  const sentences = [
    { sid: 's-a', text: 'Alpha is first.' },
    { sid: 's-b', text: 'Beta is second.' },
    { sid: 's-c', text: 'Gamma is third.' },
  ];

  it('matches by exact text and keeps fixture order', () => {
    const r = matchFixtureLines([{ text: 'Gamma is third.', reason: 'g' }, { text: 'Alpha is first.', reason: 'a' }], sentences);
    expect(r.matched).toEqual([{ sid: 's-c', text: 'Gamma is third.', reason: 'g' }, { sid: 's-a', text: 'Alpha is first.', reason: 'a' }]);
    expect(r.unmatched).toEqual([]);
  });

  it('drops near-misses (whitespace, case, punctuation) and duplicates', () => {
    const r = matchFixtureLines(
      [
        { text: 'Alpha is first', reason: 'no period' },
        { text: 'beta is second.', reason: 'case' },
        { text: 'Gamma is third. ', reason: 'trailing space' },
        { text: 'Beta is second.', reason: 'ok' },
        { text: 'Beta is second.', reason: 'dup' },
      ],
      sentences,
    );
    expect(r.matched.map((m) => m.sid)).toEqual(['s-b']);
    expect(r.unmatched).toEqual(['Alpha is first', 'beta is second.', 'Gamma is third. ']);
  });

  it('empty input → nothing matched', () => {
    expect(matchFixtureLines([], sentences)).toEqual({ matched: [], unmatched: [] });
    expect(matchFixtureLines([{ text: 'x', reason: 'y' }], [])).toEqual({ matched: [], unmatched: ['x'] });
  });
});

describe('fixture files', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const valid: DeckFixture = {
    slug: 'humans-are-software',
    model: 'test/model',
    promptVersion: 'jev-v1',
    capturedAt: '2026-10-12T10:00:00.000Z',
    lines: [{ text: 'A line.', reason: 'Because.' }],
  };

  it('round-trips through writeDeckFixture/loadDeckFixture', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'blog0-decks-'));
    const file = writeDeckFixture(valid, dir);
    expect(file).toBe(path.join(dir, 'humans-are-software.json'));
    expect(loadDeckFixture('humans-are-software', dir)).toEqual(valid);
  });

  it('a missing file reads as null', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'blog0-decks-'));
    expect(loadDeckFixture('humans-are-software', dir)).toBeNull();
  });

  it('rejects malformed JSON, a wrong shape, and a slug mismatch', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'blog0-decks-'));
    writeFileSync(path.join(dir, 'a.json'), '{ not json');
    expect(() => loadDeckFixture('a', dir!)).toThrow(DeckFixtureError);
    writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ ...valid, slug: 'b', lines: [] }));
    expect(() => loadDeckFixture('b', dir!)).toThrow(/lines/);
    writeFileSync(path.join(dir, 'c.json'), JSON.stringify(valid));
    expect(() => loadDeckFixture('c', dir!)).toThrow(/expected 'c'/);
    expect(deckFixtureSchema.safeParse({ ...valid, capturedAt: 'yesterday' }).success).toBe(false);
  });
});

describe('seed:tldr source + summary', () => {
  it('auto → jev with a real key, fixture without; explicit jev without a key is refused', () => {
    expect(resolveSeedTldrSource('auto', true)).toBe('jev');
    expect(resolveSeedTldrSource('auto', false)).toBe('fixture');
    expect(resolveSeedTldrSource('fixture', true)).toBe('fixture');
    expect(resolveSeedTldrSource('jev', true)).toBe('jev');
    expect(() => resolveSeedTldrSource('jev', false)).toThrow(SeedTldrError);
  });

  it('prints the spec’d summary line', () => {
    expect(formatSeedTldrSummary({ seeded: [], calls: 0, costUsd: null })).toBe('decks: 0 seeded (0 calls)');
    expect(formatSeedTldrSummary({ seeded: ['a', 'b', 'c', 'd', 'e'], calls: 5, costUsd: 0.01234 })).toBe('decks: 5 seeded (5 calls, $0.0123)');
    expect(formatSeedTldrSummary({ seeded: ['a'], calls: 1, costUsd: 0.002 })).toBe('decks: 1 seeded (1 call, $0.0020)');
  });
});
