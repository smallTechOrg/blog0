import 'server-only';

import type { Sentence } from '@/lib/content/types';

import type { ChatMessage } from '../llm/types';

// Jev state + result types (spec/agent.md §2 "State").

export interface JevInput {
  articleId: string;
  revisionId: string;
  title: string;
  dek: string;
  /** Eligible sentences from renderArticle(), index 0..N-1. */
  sentences: Sentence[];
  headingPathByPid: Record<string, string[]>;
  requestId: string;
}

export interface JevBounds {
  min: number;
  max: number;
  target: number;
}

/** `sid`/`text` are filled by the SERVER from sentences[index] — never from model text. */
export interface JevPick {
  index: number;
  sid: string;
  text: string;
  reason: string;
}

export interface JevUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  providerGenerationIds: string[];
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

export interface JevRunState {
  input: JevInput;
  bounds: JevBounds;
  promptVersion: string;
  model: string;
  /** Grows by assistant + repair message on retry. */
  messages: ChatMessage[];
  /** Model calls made (max 2). */
  attempts: number;
  rawOutputs: string[];
  /** From the last validate step. */
  validationErrors: string[];
  picks: JevPick[] | null;
  /** Summed over attempts. */
  usage: JevUsage;
  error: JevError | null;
}

export type JevResult =
  | {
      ok: true;
      picks: JevPick[];
      bounds: JevBounds;
      model: string;
      promptVersion: string;
      attempts: number;
      usage: JevUsage;
      latencyMs: number;
    }
  | {
      ok: false;
      error: JevError;
      bounds: JevBounds;
      model: string;
      promptVersion: string;
      attempts: number;
      usage: JevUsage;
      latencyMs: number;
      rawOutputs: string[];
    };

export const JEV_MAX_ATTEMPTS = 2;
export const JEV_MAX_SENTENCES = 400;
export const JEV_MAX_LIST_CHARS = 60_000;
export const JEV_MAX_REASON_CHARS = 200;
export const JEV_TEMPERATURE = 0;
export const JEV_MAX_TOKENS = 1200;
