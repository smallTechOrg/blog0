import 'server-only';

import type { Paragraph, Sentence } from '@/lib/content/types';

// TLDR ranking state + result types (spec/agent.md §2 "State"). The AI scores every eligible
// sentence 0–1 for relevance (SMA-44: one chat call per batch); the server takes the top k.
// (The `Jev*` names date from the Jev decisions model, removed in SMA-44.)

export interface JevInput {
  articleId: string;
  revisionId: string;
  title: string;
  dek: string;
  /** Eligible sentences from renderArticle(), index 0..N-1. */
  sentences: Sentence[];
  /** All paragraphs (for the article plain text in the decisions state). */
  paragraphs: Paragraph[];
  requestId: string;
}

/** computeBounds (unchanged since Phase 1); k = target. */
export interface JevBounds {
  min: number;
  max: number;
  target: number;
}

/** relevance = the model's score in [0,1], exactly as returned. */
export interface JevScore {
  index: number;
  sid: string;
  relevance: number;
}

export interface JevUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  providerGenerationIds: string[];
}

/** One chat request: the sentences it scores (by sid, document order) and its message size in chars. */
export interface JevBatch {
  questions: Array<{ sid: string; index: number }>;
  requestChars: number;
}

/** The article as sent — identical in every batch. */
export interface JevDecisionState {
  title: string;
  dek: string;
  article: string;
}

export type JevErrorCode =
  | 'JEV_NO_SENTENCES'
  | 'JEV_INPUT_TOO_LONG'
  | 'LLM_AUTH'
  | 'LLM_INSUFFICIENT_CREDITS'
  | 'LLM_MODEL_NOT_FOUND'
  | 'LLM_RATE_LIMITED'
  | 'LLM_TIMEOUT'
  | 'LLM_UNAVAILABLE'
  | 'LLM_INVALID_OUTPUT';

export interface JevError {
  code: JevErrorCode;
  message: string;
}

export interface JevAnswerIssues {
  missing: string[];
  invalid: string[];
  extra: number;
}

export interface JevRunState {
  input: JevInput;
  bounds: JevBounds;
  k: number;
  promptVersion: string;
  model: string;
  state: JevDecisionState;
  /** Planned (≥ 1 once planned). */
  batches: JevBatch[];
  /** Chat requests actually sent (stored as ai_generation.attempts). */
  requestsSent: number;
  /** Raw response bodies in batch order (kept only on failure). */
  rawOutputs: string[];
  answerIssues: JevAnswerIssues;
  /** All N, document order. */
  scores: JevScore[] | null;
  /** Summed over batches. */
  usage: JevUsage;
  error: JevError | null;
}

interface JevResultCommon {
  k: number;
  bounds: JevBounds;
  model: string;
  promptVersion: string;
  /** Chat requests sent (0 when a guard refused the input). */
  batches: number;
  usage: JevUsage;
  latencyMs: number;
}

export type JevResult =
  | ({ ok: true; scores: JevScore[]; selected: JevScore[] } & JevResultCommon)
  | ({ ok: false; error: JevError; rawOutputs: string[] } & JevResultCommon);

export const JEV_MAX_SENTENCES = 400;
/** JSON.stringify(state).length limit (≈ 5 000 words; keeps a request well inside a 32k-token context). */
export const JEV_MAX_STATE_CHARS = 32_000;
/** A batch's system + user message chars stay ≤ this (≈ ≤ 21k tokens at 3 chars/token). */
export const JEV_REQUEST_CHAR_BUDGET = 64_000;
/** Per-request timeout; capped at the time left before the deadline. */
export const JEV_TIMEOUT_MS = 60_000;
export const JEV_BATCH_CONCURRENCY = 3;
/** Whole-run budget, under the route's maxDuration = 120 s. */
export const JEV_DEADLINE_MS = 110_000;
/** No batch request starts with less than this left before the deadline (it could not finish). */
export const JEV_MIN_ATTEMPT_MS = 5_000;
