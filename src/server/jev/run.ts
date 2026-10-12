import 'server-only';

import { CONFIG_DEFAULTS } from '../config';
import type { LlmClient, LlmJsonResponse, LlmUsage } from '../llm/types';
import { LlmError } from '../llm/types';
import { writerMessage } from '../llm/openrouter';
import { log } from '../log';
import { computeBounds } from './bounds';
import { buildMessages, guardInput, JEV_SCHEMA_NAME, JEV_SELECTION_SCHEMA, repairMessages } from './build-input';
import { JEV_PROMPT_VERSION } from './prompt';
import {
  JEV_MAX_ATTEMPTS,
  JEV_MAX_TOKENS,
  JEV_TEMPERATURE,
  type JevError,
  type JevInput,
  type JevResult,
  type JevRunState,
  type JevUsage,
} from './state';
import { validatePicks } from './validate';

// Jev assembly (spec/agent.md §2): computeBounds → guardInput → buildMessages → callModel →
// validate → (repair → callModel) → finalize. Max 2 model calls, all within deps.deadlineMs.
// No DB access here: the generation row and the draft deck are written by
// src/server/articles/tldr.ts (S1.6) around this call.

export interface JevDeps {
  llm: LlmClient;
  /** Model slug (BLOG0_JEV_MODEL). */
  model: string;
  /** Monotonic-ish clock in ms (injected for deterministic tests). */
  now: () => number;
  /** Per-attempt timeout (BLOG0_JEV_TIMEOUT_MS). Default 45 000. */
  timeoutMs?: number;
  /** Fills {{site_name}} in the prompt. Default 'blog0'. */
  siteName?: string;
  /**
   * Overall budget for the whole run (both attempts, incl. the adapter's transport retries), measured
   * on `now()` from the start of runJev. Default 110 000 — under the route's maxDuration = 120 s.
   * No attempt starts with less than JEV_MIN_ATTEMPT_MS left; each attempt's timeout is capped at the
   * time remaining; exhaustion returns LLM_TIMEOUT.
   */
  deadlineMs?: number;
}

export const JEV_DEADLINE_MS = 110_000;
/** An attempt is not started when less than this remains before the deadline (it could not finish). */
export const JEV_MIN_ATTEMPT_MS = 5_000;

export const INVALID_TWICE_MESSAGE = 'Jev returned an invalid selection twice. Try again, or pick lines yourself.';

export function emptyUsage(): JevUsage {
  return { promptTokens: null, completionTokens: null, totalTokens: null, costUsd: null, providerGenerationIds: [] };
}

function add(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

/** Sums usage across attempts; a field stays null only when no attempt reported it. */
export function addUsage(total: JevUsage, usage: LlmUsage, providerGenerationId: string | null): JevUsage {
  return {
    promptTokens: add(total.promptTokens, usage.promptTokens),
    completionTokens: add(total.completionTokens, usage.completionTokens),
    totalTokens: add(total.totalTokens, usage.totalTokens),
    costUsd: usage.costUsd === null && total.costUsd === null ? null : Number(((total.costUsd ?? 0) + (usage.costUsd ?? 0)).toFixed(10)),
    providerGenerationIds: providerGenerationId ? [...total.providerGenerationIds, providerGenerationId] : total.providerGenerationIds,
  };
}

export function initState(input: JevInput, model: string): JevRunState {
  return {
    input,
    bounds: { min: 0, max: 0, target: 0 },
    promptVersion: JEV_PROMPT_VERSION,
    model,
    messages: [],
    attempts: 0,
    rawOutputs: [],
    validationErrors: [],
    picks: null,
    usage: emptyUsage(),
    error: null,
  };
}

type CallResult = { ok: true; content: string } | { ok: false; error: JevError };

function deadlineError(state: JevRunState, deadlineMs: number): JevError {
  log.warn('jev.deadline', {
    request_id: state.input.requestId,
    article_id: state.input.articleId,
    attempts: state.attempts,
    deadline_ms: deadlineMs,
  });
  return { code: 'LLM_TIMEOUT', message: writerMessage('LLM_TIMEOUT', state.model) };
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

async function callModel(state: JevRunState, deps: JevDeps, remainingMs: number, deadlineMs: number): Promise<CallResult> {
  state.attempts += 1;
  let res: LlmJsonResponse;
  try {
    const call = deps.llm.completeJson({
      model: state.model,
      messages: state.messages,
      schemaName: JEV_SCHEMA_NAME,
      schema: JEV_SELECTION_SCHEMA,
      temperature: JEV_TEMPERATURE,
      maxTokens: JEV_MAX_TOKENS,
      requestId: state.input.requestId,
      promptVersion: state.promptVersion,
      timeoutMs: Math.min(deps.timeoutMs ?? CONFIG_DEFAULTS.jevTimeoutMs, remainingMs),
    });
    const settled = await raceDeadline(call, remainingMs);
    if (settled === DEADLINE) return { ok: false, error: deadlineError(state, deadlineMs) };
    res = settled;
  } catch (error) {
    if (error instanceof LlmError) return { ok: false, error: { code: error.code, message: error.message } };
    throw error;
  }
  state.usage = addUsage(state.usage, res.usage, res.providerGenerationId);
  state.rawOutputs.push(res.content);
  return { ok: true, content: res.content };
}

function finalize(state: JevRunState, error: JevError | null, t0: number, deps: JevDeps): JevResult {
  state.error = error;
  const latencyMs = Math.max(0, Math.round(deps.now() - t0));
  const fields = {
    request_id: state.input.requestId,
    article_id: state.input.articleId,
    revision_id: state.input.revisionId,
    sentence_count: state.input.sentences.length,
    bounds: state.bounds,
    picks: state.picks?.length ?? 0,
    attempts: state.attempts,
    model: state.model,
    prompt_version: state.promptVersion,
    latency_ms: latencyMs,
    outcome: error ? 'error' : 'ok',
    ...(error ? { err_code: error.code } : {}),
    ...(state.validationErrors.length > 0 ? { validation_errors: state.validationErrors } : {}),
  };
  const common = {
    bounds: state.bounds,
    model: state.model,
    promptVersion: state.promptVersion,
    attempts: state.attempts,
    usage: state.usage,
    latencyMs,
  };
  if (error || state.picks === null) {
    log.warn('jev.run', fields);
    return {
      ok: false,
      error: error ?? { code: 'LLM_INVALID_OUTPUT', message: INVALID_TWICE_MESSAGE },
      ...common,
      rawOutputs: state.rawOutputs,
    };
  }
  log.info('jev.run', fields);
  return { ok: true, picks: state.picks, ...common };
}

export async function runJev(input: JevInput, deps: JevDeps): Promise<JevResult> {
  const t0 = deps.now();
  const state = initState(input, deps.model);
  state.bounds = computeBounds(input.sentences);
  const guard = guardInput(input, state.bounds);
  if (guard) return finalize(state, guard, t0, deps);
  state.messages = buildMessages(input, state.bounds, { siteName: deps.siteName ?? 'blog0' });

  const deadlineMs = deps.deadlineMs ?? JEV_DEADLINE_MS;
  try {
    while (state.attempts < JEV_MAX_ATTEMPTS) {
      const remainingMs = deadlineMs - (deps.now() - t0);
      if (remainingMs < JEV_MIN_ATTEMPT_MS) return finalize(state, deadlineError(state, deadlineMs), t0, deps);
      const res = await callModel(state, deps, remainingMs, deadlineMs);
      if (!res.ok) return finalize(state, res.error, t0, deps);
      const v = validatePicks(res.content, input.sentences, state.bounds);
      if (v.ok) {
        state.picks = v.picks;
        state.validationErrors = [];
        return finalize(state, null, t0, deps);
      }
      state.validationErrors = v.errors;
      if (state.attempts < JEV_MAX_ATTEMPTS) state.messages = repairMessages(state, res.content, v.errors);
    }
  } catch (error) {
    log.error('jev.run', {
      request_id: input.requestId,
      article_id: input.articleId,
      revision_id: input.revisionId,
      attempts: state.attempts,
      outcome: 'error',
      err_code: 'INTERNAL',
      err_message: error instanceof Error ? error.message : 'unknown error',
    });
    throw error;
  }
  return finalize(state, { code: 'LLM_INVALID_OUTPUT', message: INVALID_TWICE_MESSAGE }, t0, deps);
}
