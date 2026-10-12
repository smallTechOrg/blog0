import 'server-only';

// LLM boundary contract (spec/agent.md §8). Jev talks only to `LlmClient`; the OpenRouter adapter
// implements it. Unit tests inject a stub client (outputs tagged `<stub:jev>`).

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmJsonRequest {
  model: string;
  messages: ChatMessage[];
  schemaName: string;
  schema: object;
  temperature: number;
  maxTokens: number;
  requestId: string;
  promptVersion: string;
  timeoutMs: number;
}

export interface LlmUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

export interface LlmJsonResponse {
  /** The model's message content with one surrounding ```json fence stripped. NOT parsed — Jev validates it. */
  content: string;
  usage: LlmUsage;
  providerGenerationId: string | null;
  latencyMs: number;
}

export interface LlmClient {
  /** Exactly one logical model call (transport retries are internal). Throws `LlmError`. */
  completeJson(req: LlmJsonRequest): Promise<LlmJsonResponse>;
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
