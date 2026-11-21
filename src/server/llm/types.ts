import 'server-only';

// LLM boundary contract (spec/agent.md §8; SMA-44). Every AI feature talks only to `LlmClient`, one
// OpenAI-compatible chat-completions call at a time; src/server/llm/chat.ts implements it against the
// site's configured provider (Admin → Site → AI provider). Unit tests inject a stub client (responses
// tagged `provider: '<stub:…>'`).

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  requestId: string;
  /** What the call is for, in logs (`tldr.rank`, `ai.test`, `assistant.review`). */
  purpose: string;
  /** Prompt version stamped on logs. */
  promptVersion: string;
  timeoutMs: number;
  /** Ask for a JSON object reply (`response_format: json_object`; dropped if the provider refuses it). */
  json?: boolean;
  maxTokens?: number;
  /** For logs: 1-based batch index of `count` (one call = { index: 1, count: 1 }). */
  batch?: { index: number; count: number };
}

export interface LlmUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface ChatResponse {
  /** The assistant message text, unvalidated. */
  content: string;
  usage: LlmUsage;
  providerGenerationId: string | null;
  provider: string | null;
  latencyMs: number;
  /** The raw response body (stored on a failed generation). */
  rawBody: string;
}

export interface LlmClient {
  /** Exactly one logical chat request (transport retries are internal). Throws `LlmError`. */
  chat(req: ChatRequest): Promise<ChatResponse>;
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
