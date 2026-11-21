import 'server-only';

import { parseJsonReply } from '../llm/chat';
import type { JevBatch } from './state';

// spec/agent.md §2 step 6. Pure. Each batch's reply must be JSON `{"scores":{"<sid>":<number in [0,1]>}}`
// with every sid of that batch. Ids we did not send are ignored (counted as `extra`). Any missing or
// invalid score fails the whole run — no repair retry and no imputed scores.

export type ValidateResult =
  | { ok: true; scoresBySid: Map<string, number>; extra: number }
  | { ok: false; missing: string[]; invalid: string[]; extra: number };

function scoreOf(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}

/** The `scores` object of a model reply, or {} when the reply is not JSON of that shape. */
export function scoresOf(content: string): Record<string, unknown> {
  const parsed = parseJsonReply(content);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const scores = (parsed as { scores?: unknown }).scores;
  return typeof scores === 'object' && scores !== null && !Array.isArray(scores) ? (scores as Record<string, unknown>) : {};
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
      const score = scoreOf(answers[sid]);
      if (score === null) invalid.push(sid);
      else scoresBySid.set(sid, score);
    }
  });
  if (missing.length > 0 || invalid.length > 0) return { ok: false, missing, invalid, extra };
  return { ok: true, scoresBySid, extra };
}

export function invalidOutputMessage(bad: number, n: number): string {
  return `The AI didn't score every sentence (${bad} of ${n} missing or invalid) — try again, or pick lines yourself.`;
}
