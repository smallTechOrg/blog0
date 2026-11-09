import 'server-only';

import type { JevBatch } from './state';

// spec/agent.md §2 step 6. Pure. For each batch, every question id must be present in that batch's
// `answers` as `{ type: 'noul', noul: <finite number in [0,1]> }`. Ids we did not ask are ignored
// (counted as `extra`). Any missing or invalid answer fails the whole run — no repair retry and no
// imputed scores.

export type ValidateResult =
  | { ok: true; scoresBySid: Map<string, number>; extra: number }
  | { ok: false; missing: string[]; invalid: string[]; extra: number };

function noulOf(answer: unknown): number | null {
  if (typeof answer !== 'object' || answer === null) return null;
  const { type, noul } = answer as { type?: unknown; noul?: unknown };
  if (type !== 'noul') return null;
  if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) return null;
  return noul;
}

export function validateAnswers(batches: readonly JevBatch[], answersByBatch: ReadonlyArray<Record<string, unknown>>): ValidateResult {
  const scoresBySid = new Map<string, number>();
  const missing: string[] = [];
  const invalid: string[] = [];
  let extra = 0;
  batches.forEach((batch, i) => {
    const answers = answersByBatch[i] ?? {};
    const asked = new Set(batch.questions.map((q) => q.sid));
    for (const id of Object.keys(answers)) if (!asked.has(id)) extra++;
    for (const { sid } of batch.questions) {
      if (!Object.prototype.hasOwnProperty.call(answers, sid)) {
        missing.push(sid);
        continue;
      }
      const noul = noulOf(answers[sid]);
      if (noul === null) invalid.push(sid);
      else scoresBySid.set(sid, noul);
    }
  });
  if (missing.length > 0 || invalid.length > 0) return { ok: false, missing, invalid, extra };
  return { ok: true, scoresBySid, extra };
}

export function invalidOutputMessage(bad: number, n: number): string {
  return `Jev didn't score every sentence (${bad} of ${n} missing or invalid) — try again, or pick lines yourself.`;
}
