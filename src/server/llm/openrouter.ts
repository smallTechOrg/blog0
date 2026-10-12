import 'server-only';

import type { Secret } from '../config';
import { log } from '../log';
import { LlmError, type LlmClient, type LlmErrorCode, type LlmJsonRequest, type LlmJsonResponse, type LlmUsage } from './types';

// OpenRouter adapter (spec/agent.md §3). One logical call = one HTTP request, plus up to 2
// transport retries for 429/500/502/503/504/network errors (backoff 1 s then 3 s, +0–250 ms jitter,
// Retry-After honoured up to 10 s). A timeout is not retried (keeps the worst case < 120 s).
// One `llm.call` log line per HTTP attempt. The API key is unwrapped only into the header.

export interface OpenRouterClientOptions {
  apiKey: Secret;
  baseUrl: string;
  /** Sent as HTTP-Referer (BLOG0_PUBLIC_BASE_URL). */
  referer: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Delay before retry n (1-based) = retryDelaysMs[n-1] + jitter. Its length = max transport retries. */
  retryDelaysMs?: readonly number[];
}

export const TRANSPORT_RETRY_DELAYS_MS = [1000, 3000] as const;
export const MAX_RETRY_AFTER_MS = 10_000;
const MAX_JITTER_MS = 250;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

const MSG_UNREACHABLE = "Jev couldn't reach the model — try again in a minute.";

export function writerMessage(code: LlmErrorCode, model: string): string {
  switch (code) {
    case 'LLM_AUTH':
      return 'OpenRouter rejected the API key — check BLOG0_OPENROUTER_API_KEY in .env.';
    case 'LLM_INSUFFICIENT_CREDITS':
      return 'OpenRouter account is out of credits.';
    case 'LLM_MODEL_NOT_FOUND':
      return `Model '${model}' isn't available — set BLOG0_JEV_MODEL.`;
    case 'LLM_INVALID_OUTPUT':
      return 'The model returned an unreadable response.';
    case 'LLM_RATE_LIMITED':
    case 'LLM_TIMEOUT':
    case 'LLM_UNAVAILABLE':
      return MSG_UNREACHABLE;
  }
}

const MODEL_NOT_FOUND_RE = /not a valid model|model[^.]{0,80}(not found|does not exist|doesn't exist)|no endpoints found|unknown model|invalid model/i;

/** Maps a non-success HTTP status (+ provider message) to an error code. */
export function classifyHttpError(status: number, providerMessage: string): LlmErrorCode {
  if (status === 401 || status === 403) return 'LLM_AUTH';
  if (status === 402) return 'LLM_INSUFFICIENT_CREDITS';
  if (status === 404) return 'LLM_MODEL_NOT_FOUND';
  if (status === 400 && MODEL_NOT_FOUND_RE.test(providerMessage)) return 'LLM_MODEL_NOT_FOUND';
  if (status === 408) return 'LLM_TIMEOUT';
  if (status === 429) return 'LLM_RATE_LIMITED';
  return 'LLM_UNAVAILABLE';
}

/** Strips one surrounding ``` / ```json fence (some providers wrap structured output in one). */
export function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const fence = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\s*```$/.exec(trimmed);
  return fence ? fence[1].trim() : trimmed;
}

/** Retry-After (seconds or HTTP date) → ms, capped at MAX_RETRY_AFTER_MS; null when absent/invalid. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null || value.trim() === '') return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.min(Math.round(Number(v) * 1000), MAX_RETRY_AFTER_MS);
  const date = Date.parse(v);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(0, date - nowMs), MAX_RETRY_AFTER_MS);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface ChatCompletionBody {
  id?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown; cost?: unknown };
  error?: { code?: unknown; message?: unknown };
}

function providerMessage(body: unknown): string {
  const err = (body as ChatCompletionBody | null)?.error;
  if (err && typeof err.message === 'string') return err.message.slice(0, 300);
  return '';
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

type AttemptOutcome = 'ok' | 'http_error' | 'timeout' | 'invalid_json';

export class OpenRouterClient implements LlmClient {
  readonly #apiKey: Secret;
  readonly #baseUrl: string;
  readonly #referer: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #retryDelays: readonly number[];

  constructor(options: OpenRouterClientOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#referer = options.referer;
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? (() => performance.now());
    this.#retryDelays = options.retryDelaysMs ?? TRANSPORT_RETRY_DELAYS_MS;
  }

  async completeJson(req: LlmJsonRequest): Promise<LlmJsonResponse> {
    const started = this.#now();
    const body = JSON.stringify({
      model: req.model,
      messages: req.messages,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      response_format: {
        type: 'json_schema',
        json_schema: { name: req.schemaName, strict: true, schema: req.schema },
      },
      provider: { require_parameters: true },
      usage: { include: true },
    });

    const maxAttempts = this.#retryDelays.length + 1;
    for (let attempt = 1; ; attempt++) {
      const attemptStart = this.#now();
      const logBase = { request_id: req.requestId, model: req.model, prompt_version: req.promptVersion, attempt };
      const elapsed = () => Math.max(0, Math.round(this.#now() - attemptStart));
      const canRetry = attempt < maxAttempts;

      let status: number;
      let text: string;
      let retryAfter: string | null;
      try {
        const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
          method: 'POST',
          body,
          signal: AbortSignal.timeout(req.timeoutMs),
          headers: {
            Authorization: `Bearer ${this.#apiKey.reveal()}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': this.#referer,
            'X-Title': 'blog0',
          },
        });
        status = response.status;
        retryAfter = response.headers.get('retry-after');
        text = await response.text();
      } catch (error) {
        if (isTimeoutError(error)) {
          this.#logAttempt('timeout', logBase, elapsed(), null);
          throw new LlmError('LLM_TIMEOUT', writerMessage('LLM_TIMEOUT', req.model), null, `no response within ${req.timeoutMs} ms`);
        }
        const detail = error instanceof Error ? error.message.slice(0, 200) : 'network error';
        this.#logAttempt('http_error', logBase, elapsed(), null, { err_message: detail });
        if (canRetry) {
          await this.#sleep(this.#backoff(attempt, null));
          continue;
        }
        throw new LlmError('LLM_UNAVAILABLE', writerMessage('LLM_UNAVAILABLE', req.model), null, detail);
      }

      let parsed: ChatCompletionBody | null = null;
      try {
        parsed = JSON.parse(text) as ChatCompletionBody;
      } catch {
        parsed = null;
      }

      // OpenRouter may report a provider failure inside a 200 body (`{ error: { code, message } }`).
      const embeddedStatus = status === 200 && parsed?.error ? (num(parsed.error.code) ?? 502) : null;
      const effectiveStatus = embeddedStatus ?? status;

      if (effectiveStatus !== 200 || parsed === null || typeof parsed !== 'object') {
        const providerMsg = providerMessage(parsed);
        // A 200 whose body is not JSON is a gateway glitch: treat it like a 502.
        const statusForMapping = effectiveStatus === 200 ? 502 : effectiveStatus;
        this.#logAttempt('http_error', logBase, elapsed(), null, {
          http_status: status,
          ...(embeddedStatus !== null ? { provider_status: embeddedStatus } : {}),
          ...(providerMsg ? { err_message: providerMsg } : {}),
        });
        if (RETRYABLE_STATUSES.has(statusForMapping) && canRetry) {
          await this.#sleep(this.#backoff(attempt, retryAfter));
          continue;
        }
        const code = classifyHttpError(statusForMapping, providerMsg);
        throw new LlmError(code, writerMessage(code, req.model), statusForMapping, providerMsg || `HTTP ${status}`);
      }

      const rawContent = parsed.choices?.[0]?.message?.content;
      const content = typeof rawContent === 'string' ? stripJsonFence(rawContent) : '';
      const usage: LlmUsage = {
        promptTokens: num(parsed.usage?.prompt_tokens),
        completionTokens: num(parsed.usage?.completion_tokens),
        totalTokens: num(parsed.usage?.total_tokens),
        costUsd: num(parsed.usage?.cost),
      };
      const providerGenerationId = typeof parsed.id === 'string' ? parsed.id : null;

      let contentIsJson = false;
      try {
        JSON.parse(content);
        contentIsJson = true;
      } catch {
        contentIsJson = false;
      }
      this.#logAttempt(contentIsJson ? 'ok' : 'invalid_json', logBase, elapsed(), usage, {
        http_status: status,
        provider_generation_id: providerGenerationId,
      });
      if (usage.costUsd === null) {
        log.warn('llm.cost_missing', {
          msg: 'OpenRouter response had no usage.cost; cost recorded as null',
          request_id: req.requestId,
          model: req.model,
          provider_generation_id: providerGenerationId,
        });
      }

      return { content, usage, providerGenerationId, latencyMs: Math.max(0, Math.round(this.#now() - started)) };
    }
  }

  #backoff(attempt: number, retryAfterHeader: string | null): number {
    const fromHeader = parseRetryAfter(retryAfterHeader, Date.now());
    if (fromHeader !== null) return fromHeader;
    const base = this.#retryDelays[attempt - 1] ?? this.#retryDelays[this.#retryDelays.length - 1] ?? 0;
    return base + Math.floor(this.#random() * (MAX_JITTER_MS + 1));
  }

  #logAttempt(
    outcome: AttemptOutcome,
    base: Record<string, unknown>,
    latencyMs: number,
    usage: LlmUsage | null,
    extra: Record<string, unknown> = {},
  ): void {
    const fields = {
      ...base,
      latency_ms: latencyMs,
      prompt_tokens: usage?.promptTokens ?? null,
      completion_tokens: usage?.completionTokens ?? null,
      cost_usd: usage?.costUsd ?? null,
      provider_generation_id: null,
      outcome,
      ...extra,
    };
    if (outcome === 'ok') log.info('llm.call', fields);
    else log.warn('llm.call', fields);
  }
}
