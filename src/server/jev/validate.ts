import 'server-only';

import { z } from 'zod';

import type { Sentence } from '@/lib/content/types';

import { JEV_MAX_REASON_CHARS, type JevBounds, type JevPick } from './state';

// spec/agent.md §2 step 5. Pure. Rules (each with a precise message for the repair prompt):
// - JSON parses to { picks: [{ index, reason }] }
// - index is an integer in [0, N-1]
// - duplicates are removed (keep first) — not an error
// - count after dedupe within [min, max]
// - reason trimmed non-empty; > 200 chars → truncated at a word boundary with "…" (not an error)
// Valid picks are sorted by index and mapped to sid/text from the SERVER's sentences.

const envelopeSchema = z.object({ picks: z.array(z.unknown()) });
const pickSchema = z.object({ index: z.unknown().optional(), reason: z.unknown().optional() });

export type ValidateResult = { ok: true; picks: JevPick[] } | { ok: false; errors: string[] };

/** Trim; if longer than `max`, cut at the last word boundary and append "…" (total ≤ max). */
export function truncateReason(reason: string, max: number = JEV_MAX_REASON_CHARS): string {
  const trimmed = reason.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  const base = space >= Math.floor(max / 2) ? cut.slice(0, space) : cut;
  return `${base.replace(/[\s,;:.–—-]+$/, '')}…`;
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.length > 20 ? `${value.slice(0, 20)}…` : value);
  if (value === undefined) return 'missing';
  return JSON.stringify(value) ?? String(value);
}

export function validatePicks(content: string, sentences: readonly Sentence[], bounds: JevBounds): ValidateResult {
  const n = sentences.length;

  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { ok: false, errors: ['the output was not valid JSON'] };
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) {
    return { ok: false, errors: ['the output must be a JSON object {"picks":[{"index":<int>,"reason":"<text>"}]}'] };
  }

  const errors: string[] = [];
  const seen = new Set<number>();
  const kept: Array<{ index: number; reason: string }> = [];

  envelope.data.picks.forEach((raw, i) => {
    const item = pickSchema.safeParse(raw);
    if (!item.success || raw === null || typeof raw !== 'object') {
      errors.push(`picks[${i}] must be an object with "index" and "reason"`);
      return;
    }
    const { index, reason } = item.data;
    let bad = false;
    if (typeof index !== 'number' || !Number.isInteger(index)) {
      errors.push(`picks[${i}].index ${describe(index)} is not an integer`);
      bad = true;
    } else if (index < 0 || index > n - 1) {
      errors.push(`picks[${i}].index ${index} is out of range 0..${n - 1}`);
      bad = true;
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      errors.push(`picks[${i}].reason is ${typeof reason === 'string' ? 'empty' : describe(reason)}; give a one-line reason`);
      bad = true;
    }
    if (bad) return;
    const idx = index as number;
    if (seen.has(idx)) return; // duplicate: keep the first, not an error
    seen.add(idx);
    kept.push({ index: idx, reason: truncateReason(reason as string) });
  });

  if (errors.length === 0 && (kept.length < bounds.min || kept.length > bounds.max)) {
    errors.push(
      `chose ${kept.length} distinct sentence${kept.length === 1 ? '' : 's'}; choose between ${bounds.min} and ${bounds.max}`,
    );
  }
  if (errors.length > 0) return { ok: false, errors };

  kept.sort((a, b) => a.index - b.index);
  const picks: JevPick[] = kept.map(({ index, reason }) => {
    const sentence = sentences[index];
    return { index, sid: sentence.sid, text: sentence.text, reason };
  });
  return { ok: true, picks };
}
