import 'server-only';

// LLM boundary contract (spec/agent.md §8). Jev talks only to `LlmClient`; the OpenRouter decisions
// adapter implements it. Unit tests inject a stub client (responses tagged `provider: '<stub:jev>'`).
// Phase 8: the chat-completions client (completeJson) is gone — Jev was its only user.

/** One yes/no question; the model answers with a probability (`noul`) in [0,1]. Both criteria are required. */
export interface DecisionQuestion {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
}

export interface DecisionsRequest {
  model: string;
  state: string | Record<string, unknown> | unknown[];
  /** Question id → question. Jev uses the sentence sids as ids (verified live, spec/agent.md §3). */
  questions: Record<string, DecisionQuestion>;
  requestId: string;
  promptVersion: string;
  timeoutMs: number;
  /** For logs: 1-based batch index of `count`. */
  batch: { index: number; count: number };
}

export interface LlmUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface DecisionsResponse {
  /** Question id → answer, unvalidated (Jev validates every answer). */
  answers: Record<string, unknown>;
  usage: LlmUsage;
  providerGenerationId: string | null;
  provider: string | null;
  latencyMs: number;
  /** The raw response body (stored on a failed generation). */
  rawBody: string;
}

export interface LlmClient {
  /** Exactly one logical decisions request (transport retries are internal). Throws `LlmError`. */
  decide(req: DecisionsRequest): Promise<DecisionsResponse>;
}

export type LlmErrorCode =
  | 'LLM_AUTH'
  | 'LLM_INSUFFICIENT_CREDITS'
  | 'LLM_MODEL_NOT_FOUND'
  | 'LLM_RATE_LIMITED'
  | 'LLM_TIMEOUT'
  | 'LLM_UNAVAILABLE'
  | 'LLM_INVALID_OUTPUT';

/** Typed adapter failure. `message` is writer-facing; `detail` is a short provider message for logs. */
export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly httpStatus: number | null;
  readonly detail: string | null;

  constructor(code: LlmErrorCode, message: string, httpStatus: number | null = null, detail: string | null = null) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}
