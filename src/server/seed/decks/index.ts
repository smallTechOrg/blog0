import 'server-only';

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { Sentence } from '@/lib/content/types';

import { TLDR_MAX_SLIDES, TLDR_REASON_MAX } from '../../formats/payload';

// Committed TLDR deck fixtures (spec/data.md → Seed data, `pnpm seed:tldr`): one
// `<slug>.json` per seed post, captured from real Jev output with `pnpm seed:tldr -- --write-fixture`.
// Used when no real OpenRouter key is configured (designer mode, the reader E2E): every line is
// matched by EXACT text to an eligible sentence of the article; a line that no longer matches is
// dropped with a warning. Shape: { slug, model, promptVersion, capturedAt, lines: [{ text, reason }] }.

/** Resolved from the repo root (every command runs there — see README). */
export const DECKS_DIR = path.join(process.cwd(), 'src', 'server', 'seed', 'decks');

export const deckFixtureSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  capturedAt: z.iso.datetime(),
  lines: z
    .array(z.object({ text: z.string().min(1), reason: z.string().max(TLDR_REASON_MAX) }))
    .min(1)
    .max(TLDR_MAX_SLIDES),
});

export type DeckFixture = z.infer<typeof deckFixtureSchema>;

export class DeckFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeckFixtureError';
  }
}

export function deckFixturePath(slug: string, dir: string = DECKS_DIR): string {
  return path.join(dir, `${slug}.json`);
}

/**
 * Reads and validates `<dir>/<slug>.json`. Returns null when the file does not exist; throws
 * DeckFixtureError when it is not valid JSON, has the wrong shape, or names another slug.
 */
export function loadDeckFixture(slug: string, dir: string = DECKS_DIR): DeckFixture | null {
  const file = deckFixturePath(slug, dir);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new DeckFixtureError(`${path.basename(file)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = deckFixtureSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DeckFixtureError(`${path.basename(file)} is not a valid deck fixture: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  }
  if (parsed.data.slug !== slug) throw new DeckFixtureError(`${path.basename(file)} names slug '${parsed.data.slug}', expected '${slug}'.`);
  return parsed.data;
}

/** Writes `<dir>/<slug>.json` (2-space JSON + trailing newline) atomically. */
export function writeDeckFixture(fixture: DeckFixture, dir: string = DECKS_DIR): string {
  const valid = deckFixtureSchema.parse(fixture);
  mkdirSync(dir, { recursive: true });
  const file = deckFixturePath(valid.slug, dir);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return file;
}

export interface FixtureMatch {
  /** Matched slides in fixture order (first occurrence of a text wins; duplicates are dropped). */
  matched: Array<{ sid: string; text: string; reason: string }>;
  /** Fixture lines with no byte-identical eligible sentence. */
  unmatched: string[];
}

/** Matches fixture lines to the article's eligible sentences by exact text. Pure. */
export function matchFixtureLines(lines: DeckFixture['lines'], sentences: readonly Pick<Sentence, 'sid' | 'text'>[]): FixtureMatch {
  const sidByText = new Map<string, string>();
  for (const s of sentences) if (!sidByText.has(s.text)) sidByText.set(s.text, s.sid);
  const used = new Set<string>();
  const result: FixtureMatch = { matched: [], unmatched: [] };
  for (const line of lines) {
    const sid = sidByText.get(line.text);
    if (sid === undefined) {
      result.unmatched.push(line.text);
      continue;
    }
    if (used.has(sid)) continue;
    used.add(sid);
    result.matched.push({ sid, text: line.text, reason: line.reason });
  }
  return result;
}
