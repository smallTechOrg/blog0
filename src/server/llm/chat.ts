import 'server-only';

import type { Secret } from '../config';
import { log } from '../log';
import { LlmError, type ChatRequest, type ChatResponse, type LlmClient, type LlmErrorCode, type LlmUsage } from './types';

// OpenAI-compatible chat-completions adapter (SMA-44; spec/agent.md §3). POST {baseUrl}/chat/completions
// with { model, messages, response_format?, max_tokens? } — works with OpenAI, OpenRouter, Together,
// Groq, a local Ollama/vLLM… One logical request = one HTTP request, plus up to 2 transport retries
// for 429/500/502/503/504, network errors and 200s with no assistant message (backoff 1 s then 3 s,
// +0–250 ms jitter, Retry-After honoured up to 10 s). A timeout is not retried. A provider that
// refuses `response_format` (HTTP 400 naming it) is asked once more without it. One `llm.call` log
// line per HTTP attempt. The API key is unwrapped only into the Authorization header; prompts and
// article text are never logged.

export interface ChatClientOptions {
  apiKey: Secret;
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 or https://openrouter.ai/api/v1. */
  baseUrl: string;
  /** Sent as HTTP-Referer (BLOG0_PUBLIC_BASE_URL); OpenRouter shows it, others ignore it. */
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

/** Where the writer fixes the provider (shown in error messages). */
export const PROVIDER_SETTINGS_HINT = 'Admin → Site → AI provider';

export function writerMessage(code: LlmErrorCode, model: string): string {
  switch (code) {
    case 'LLM_AUTH':
      return `The AI provider rejected the API key — check it in ${PROVIDER_SETTINGS_HINT}.`;
    case 'LLM_INSUFFICIENT_CREDITS':
      return 'The AI provider account is out of credits.';
    case 'LLM_MODEL_NOT_FOUND':
      return `The AI provider doesn't offer the model '${model}' — check the model in ${PROVIDER_SETTINGS_HINT}.`;
    case 'LLM_INVALID_OUTPUT':
      return 'The AI model returned an unreadable response.';
    case 'LLM_RATE_LIMITED':
      return 'The AI provider is rate-limiting requests — try again in a minute.';
    case 'LLM_TIMEOUT':
      return 'The AI provider took too long to answer — try again in a minute.';
    case 'LLM_UNAVAILABLE':
      return "Couldn't reach the AI provider — it may be down. Try again in a minute.";
  }
}

// Seen in the wild: OpenRouter "No endpoints found for x/y", "x is not a valid model ID";
// OpenAI 404 "The model `x` does not exist"; vLLM/Ollama "model 'x' not found".
export const MODEL_NOT_FOUND_RE =
  /not a valid model|\bmodel\b[^\n]{0,120}?(not found|does not exist|doesn't exist)|no endpoints found|unknown model|invalid model/i;
const RESPONSE_FORMAT_RE = /response_format|json_object|json mode|json_mode/i;

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

/** Retry-After (seconds or HTTP date) → ms, capped at MAX_RETRY_AFTER_MS; null when absent/invalid. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null || value.trim() === '') return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.min(Math.round(Number(v) * 1000), MAX_RETRY_AFTER_MS);
  const date = Date.parse(v);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(0, date - nowMs), MAX_RETRY_AFTER_MS);
}

/** `{base}/chat/completions`, tolerating a trailing slash or a base that already ends in it. */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface ChatBody {
  id?: unknown;
  provider?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown };
  error?: { code?: unknown; message?: unknown } | string;
}

function providerMessage(body: unknown): string {
  const err = (body as ChatBody | null)?.error;
  const text = typeof err === 'string' ? err : err && typeof err.message === 'string' ? err.message : '';
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The assistant text of a chat-completions body (string content, or an array of text parts). */
function contentOf(body: ChatBody): string | null {
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .join('');
    return text;
  }
  return null;
}

type AttemptOutcome = 'ok' | 'http_error' | 'timeout' | 'invalid_body';

export class ChatClient implements LlmClient {
  readonly #apiKey: Secret;
  readonly #url: string;
  readonly #referer: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #retryDelays: readonly number[];

  constructor(options: ChatClientOptions) {
    this.#apiKey = options.apiKey;
    this.#url = chatCompletionsUrl(options.baseUrl);
    this.#referer = options.referer;
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? (() => performance.now());
    this.#retryDelays = options.retryDelaysMs ?? TRANSPORT_RETRY_DELAYS_MS;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = this.#now();
    let jsonMode = req.json === true;
    const bodyFor = () =>
      JSON.stringify({
        model: req.model,
        messages: req.messages,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        temperature: 0,
      });

    const maxAttempts = this.#retryDelays.length + 1;
    let attempt = 0;
    let droppedFormat = false;
    for (;;) {
      attempt += 1;
      const attemptStart = this.#now();
      const logBase = {
        request_id: req.requestId,
        purpose: req.purpose,
        model: req.model,
        prompt_version: req.promptVersion,
        batch: req.batch?.index ?? 1,
        batches: req.batch?.count ?? 1,
        attempt,
      };
      const elapsed = () => Math.max(0, Math.round(this.#now() - attemptStart));
      const canRetry = attempt < maxAttempts;

      let status: number;
      let text: string;
      let retryAfter: string | null;
      try {
        const response = await this.#fetch(this.#url, {
          method: 'POST',
          body: bodyFor(),
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

      let parsed: ChatBody | null = null;
      try {
        const json: unknown = JSON.parse(text);
        parsed = isRecord(json) ? (json as ChatBody) : null;
      } catch {
        parsed = null;
      }

      // Some gateways (OpenRouter) report a provider failure inside a 200 body (`{ error: { code, message } }`).
      const embeddedStatus = status === 200 && parsed?.error ? (num(typeof parsed.error === 'object' ? parsed.error.code : null) ?? 502) : null;
      const effectiveStatus = embeddedStatus ?? status;

      if (effectiveStatus < 200 || effectiveStatus > 299) {
        const providerMsg = providerMessage(parsed);
        this.#logAttempt('http_error', logBase, elapsed(), null, {
          http_status: status,
          ...(embeddedStatus !== null ? { provider_status: embeddedStatus } : {}),
          ...(providerMsg ? { err_message: providerMsg } : {}),
        });
        // A provider without JSON mode: ask once more without response_format (not a retry).
        if (effectiveStatus === 400 && jsonMode && !droppedFormat && RESPONSE_FORMAT_RE.test(providerMsg)) {
          jsonMode = false;
          droppedFormat = true;
          attempt -= 1;
          continue;
        }
        if (RETRYABLE_STATUSES.has(effectiveStatus) && canRetry) {
          await this.#sleep(this.#backoff(attempt, retryAfter));
          continue;
        }
        const code = classifyHttpError(effectiveStatus, providerMsg);
        throw new LlmError(code, writerMessage(code, req.model), effectiveStatus, providerMsg || `HTTP ${status}`);
      }

      // A 2xx whose body is not JSON, or has no assistant message, is a gateway glitch: retry like a 502.
      const content = parsed ? contentOf(parsed) : null;
      if (parsed === null || content === null) {
        const detail = parsed === null ? '200 with a non-JSON body' : '200 without an assistant message';
        this.#logAttempt('invalid_body', logBase, elapsed(), null, { http_status: status, err_message: detail });
        if (canRetry) {
          await this.#sleep(this.#backoff(attempt, retryAfter));
          continue;
        }
        throw new LlmError('LLM_UNAVAILABLE', writerMessage('LLM_UNAVAILABLE', req.model), 502, detail);
      }

      const usage: LlmUsage = {
        inputTokens: num(parsed.usage?.prompt_tokens),
        outputTokens: num(parsed.usage?.completion_tokens),
        costUsd: num(parsed.usage?.cost),
      };
      const providerGenerationId = typeof parsed.id === 'string' ? parsed.id : null;
      const provider = typeof parsed.provider === 'string' ? parsed.provider : null;

      this.#logAttempt('ok', logBase, elapsed(), usage, {
        http_status: status,
        provider_generation_id: providerGenerationId,
        provider,
        ...(droppedFormat ? { json_mode: 'dropped' } : {}),
      });

      return {
        content,
        usage,
        providerGenerationId,
        provider,
        latencyMs: Math.max(0, Math.round(this.#now() - started)),
        rawBody: text,
      };
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
      input_tokens: usage?.inputTokens ?? null,
      output_tokens: usage?.outputTokens ?? null,
      cost_usd: usage?.costUsd ?? null,
      provider_generation_id: null,
      provider: null,
      outcome,
      ...extra,
    };
    if (outcome === 'ok') log.info('llm.call', fields);
    else log.warn('llm.call', fields);
  }
}

/** Parses a model's JSON reply, tolerating a Markdown fence or prose around one JSON object. */
export function parseJsonReply(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  return null;
}
