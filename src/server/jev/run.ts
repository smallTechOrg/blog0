import 'server-only';

import { CONFIG_DEFAULTS } from '../config';
import type { DecisionsResponse, LlmClient, LlmUsage } from '../llm/types';
import { LlmError } from '../llm/types';
import { writerMessage } from '../llm/openrouter';
import { log } from '../log';
import { batchQuestions, planBatches } from './batches';
import { computeBounds } from './bounds';
import { buildState, guardInput } from './build-input';
import { JEV_PROMPT_VERSION, loadRankPrompt, type RankPrompt } from './prompt';
import { rankScores, topK } from './rank';
import {
  JEV_BATCH_CONCURRENCY,
  JEV_DEADLINE_MS,
  JEV_MIN_ATTEMPT_MS,
  JEV_REQUEST_CHAR_BUDGET,
  type JevError,
  type JevInput,
  type JevResult,
  type JevRunState,
  type JevUsage,
} from './state';
import { invalidOutputMessage, validateAnswers } from './validate';

// Jev assembly (spec/agent.md §2): computeBounds → buildState → guardInput → planBatches →
// callBatches → validateAnswers → rank → finalize. One decisions request per batch (normally one),
// ≤ JEV_BATCH_CONCURRENCY in flight, all within deps.deadlineMs. No DB access here: the generation
// row and the draft deck are written by src/server/articles/tldr.ts around this call.

export { JEV_DEADLINE_MS, JEV_MIN_ATTEMPT_MS } from './state';

export interface JevDeps {
  llm: LlmClient;
  /** Model slug (BLOG0_JEV_MODEL). */
  model: string;
  /** Monotonic-ish clock in ms (injected for deterministic tests). */
  now: () => number;
  /** Per-request timeout (BLOG0_JEV_TIMEOUT_MS). Default 45 000; capped at the time remaining. */
  timeoutMs?: number;
  /**
   * Budget for the whole run (every batch, incl. the adapter's transport retries), measured on
   * `now()` from the start of runJev. Default 110 000 — under the route's maxDuration = 120 s.
   * No batch starts with less than JEV_MIN_ATTEMPT_MS left; exhaustion returns LLM_TIMEOUT.
   */
  deadlineMs?: number;
  /** Request size budget in chars (default JEV_REQUEST_CHAR_BUDGET); tests force batching with it. */
  requestCharBudget?: number;
  /** Max concurrent batch requests (default JEV_BATCH_CONCURRENCY). */
  concurrency?: number;
}

export function emptyUsage(): JevUsage {
  return { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, providerGenerationIds: [] };
}

function add(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

/** Sums one response's usage into the run total; a field stays null only when no response reported it. */
export function addUsage(total: JevUsage, usage: LlmUsage, providerGenerationId: string | null): JevUsage {
  const responseTotal = usage.inputTokens === null && usage.outputTokens === null ? null : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  return {
    inputTokens: add(total.inputTokens, usage.inputTokens),
    outputTokens: add(total.outputTokens, usage.outputTokens),
    totalTokens: add(total.totalTokens, responseTotal),
    costUsd: usage.costUsd === null && total.costUsd === null ? null : Number(((total.costUsd ?? 0) + (usage.costUsd ?? 0)).toFixed(10)),
    providerGenerationIds: providerGenerationId ? [...total.providerGenerationIds, providerGenerationId] : total.providerGenerationIds,
  };
}

export function initState(input: JevInput, model: string): JevRunState {
  return {
    input,
    bounds: { min: 0, max: 0, target: 0 },
    k: 0,
    promptVersion: JEV_PROMPT_VERSION,
    model,
    state: { title: '', dek: '', article: '' },
    batches: [],
    requestsSent: 0,
    rawOutputs: [],
    answerIssues: { missing: [], invalid: [], extra: 0 },
    scores: null,
    usage: emptyUsage(),
    error: null,
  };
}

const DEADLINE = Symbol('jev-deadline');

/** Resolves to DEADLINE after `ms` real ms unless `call` settles first; the timer is always cleared. */
async function raceDeadline<T>(call: Promise<T>, ms: number): Promise<T | typeof DEADLINE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), Math.max(0, ms));
  });
  // A call abandoned at the deadline may still reject later; never let that surface as unhandled.
  call.catch(() => {});
  try {
    return await Promise.race([call, expired]);
  } finally {
    clearTimeout(timer);
  }
}

type CallBatchesResult = { ok: true; answersByBatch: Array<Record<string, unknown>> } | { ok: false; error: JevError };

/**
 * One decide() per planned batch, ≤ concurrency in flight, launched in batch order. The first failing
 * batch (in batch order) decides the error; no new batch starts after a failure; batches already in
 * flight are awaited so their usage/cost is recorded.
 */
async function callBatches(s: JevRunState, prompt: RankPrompt, deps: JevDeps, t0: number): Promise<CallBatchesResult> {
  const deadlineMs = deps.deadlineMs ?? JEV_DEADLINE_MS;
  const timeoutMs = deps.timeoutMs ?? CONFIG_DEFAULTS.jevTimeoutMs;
  const count = s.batches.length;
  const answers: Array<Record<string, unknown> | undefined> = new Array(count);
  const raw: Array<string | undefined> = new Array(count);
  const failures = new Map<number, JevError>();
  let next = 0;
  let stopped = false;
  let deadlineLogged = false;

  const deadlineError = (): JevError => {
    if (!deadlineLogged) {
      deadlineLogged = true;
      log.warn('jev.deadline', {
        request_id: s.input.requestId,
        article_id: s.input.articleId,
        batches: s.requestsSent,
        deadline_ms: deadlineMs,
      });
    }
    return { code: 'LLM_TIMEOUT', message: writerMessage('LLM_TIMEOUT', s.model) };
  };
  const fail = (i: number, error: JevError) => {
    failures.set(i, error);
    stopped = true;
  };

  const worker = async (): Promise<void> => {
    while (!stopped && next < count) {
      const i = next++;
      const remainingMs = deadlineMs - (deps.now() - t0);
      if (remainingMs < JEV_MIN_ATTEMPT_MS) {
        fail(i, deadlineError());
        return;
      }
      s.requestsSent += 1;
      let res: DecisionsResponse | typeof DEADLINE;
      try {
        const call = deps.llm.decide({
          model: s.model,
          state: { ...s.state },
          questions: batchQuestions(s.batches[i], s.input, prompt),
          requestId: s.input.requestId,
          promptVersion: s.promptVersion,
          timeoutMs: Math.min(timeoutMs, remainingMs),
          batch: { index: i + 1, count },
        });
        res = await raceDeadline(call, remainingMs);
      } catch (error) {
        if (error instanceof LlmError) {
          fail(i, { code: error.code, message: error.message });
          return;
        }
        throw error;
      }
      if (res === DEADLINE) {
        fail(i, deadlineError());
        return;
      }
      s.usage = addUsage(s.usage, res.usage, res.providerGenerationId);
      answers[i] = res.answers;
      raw[i] = res.rawBody;
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(deps.concurrency ?? JEV_BATCH_CONCURRENCY, count)) }, () => worker());
  const settled = await Promise.allSettled(workers);
  s.rawOutputs = raw.filter((r): r is string => r !== undefined);
  const unexpected = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (unexpected) throw unexpected.reason;
  if (failures.size > 0) {
    const first = Math.min(...failures.keys());
    return { ok: false, error: failures.get(first)! };
  }
  return { ok: true, answersByBatch: answers as Array<Record<string, unknown>> };
}

function finalize(s: JevRunState, error: JevError | null, t0: number, deps: JevDeps): JevResult {
  s.error = error;
  const latencyMs = Math.max(0, Math.round(deps.now() - t0));
  const selected = !error && s.scores ? topK(s.scores, s.k) : null;
  const ranked = selected ? rankScores(s.scores!) : null;
  const issues = s.answerIssues;
  const fields = {
    request_id: s.input.requestId,
    article_id: s.input.articleId,
    revision_id: s.input.revisionId,
    sentence_count: s.input.sentences.length,
    k: s.k,
    batches: s.requestsSent,
    model: s.model,
    prompt_version: s.promptVersion,
    latency_ms: latencyMs,
    outcome: error ? 'error' : 'ok',
    ...(error ? { err_code: error.code } : {}),
    ...(issues.missing.length > 0 ? { missing_answers: issues.missing.length } : {}),
    ...(issues.invalid.length > 0 ? { invalid_answers: issues.invalid.length } : {}),
    ...(issues.extra > 0 ? { extra_answers: issues.extra } : {}),
    ...(ranked && ranked.length > 0 ? { top_relevance: ranked[0].relevance, kth_relevance: ranked[Math.max(0, s.k - 1)].relevance } : {}),
  };
  const common = {
    k: s.k,
    bounds: s.bounds,
    model: s.model,
    promptVersion: s.promptVersion,
    batches: s.requestsSent,
    usage: s.usage,
    latencyMs,
  };
  if (error || !selected) {
    log.warn('jev.run', fields);
    return {
      ok: false,
      error: error ?? { code: 'LLM_INVALID_OUTPUT', message: invalidOutputMessage(s.input.sentences.length, s.input.sentences.length) },
      ...common,
      rawOutputs: s.rawOutputs,
    };
  }
  log.info('jev.run', fields);
  return { ok: true, scores: s.scores!, selected, ...common };
}

export async function runJev(input: JevInput, deps: JevDeps): Promise<JevResult> {
  const t0 = deps.now();
  const s = initState(input, deps.model);
  s.bounds = computeBounds(input.sentences);
  s.k = s.bounds.target;
  s.state = buildState(input);
  const guard = guardInput(input, s.state);
  if (guard) return finalize(s, guard, t0, deps);

  try {
    const prompt = loadRankPrompt();
    s.batches = planBatches(input, s.state, prompt, deps.model, deps.requestCharBudget ?? JEV_REQUEST_CHAR_BUDGET);
    const res = await callBatches(s, prompt, deps, t0);
    if (!res.ok) return finalize(s, res.error, t0, deps);
    const v = validateAnswers(s.batches, res.answersByBatch);
    s.answerIssues = { missing: v.ok ? [] : v.missing, invalid: v.ok ? [] : v.invalid, extra: v.extra };
    if (!v.ok) {
      const bad = v.missing.length + v.invalid.length;
      return finalize(s, { code: 'LLM_INVALID_OUTPUT', message: invalidOutputMessage(bad, input.sentences.length) }, t0, deps);
    }
    s.scores = input.sentences.map((x) => ({ index: x.index, sid: x.sid, relevance: v.scoresBySid.get(x.sid)! }));
    return finalize(s, null, t0, deps);
  } catch (error) {
    log.error('jev.run', {
      request_id: input.requestId,
      article_id: input.articleId,
      revision_id: input.revisionId,
      batches: s.requestsSent,
      outcome: 'error',
      err_code: 'INTERNAL',
      err_message: error instanceof Error ? error.message : 'unknown error',
    });
    throw error;
  }
}
