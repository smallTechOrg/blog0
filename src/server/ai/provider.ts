import 'server-only';

import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { AiProviderDto, AiProviderTestResult } from '@/lib/api/dto';

import { getConfig, Secret } from '../config';
import { getDb } from '../db/client';
import { aiProvider, type AiProviderRow } from '../db/schema';
import { ApiError } from '../http/api';
import { ChatClient, parseJsonReply, PROVIDER_SETTINGS_HINT } from '../llm/chat';
import { LlmError, type ChatRequest, type ChatResponse, type LlmClient } from '../llm/types';
import { log } from '../log';
import { open, seal } from './secret-box';

// The site's AI provider (SMA-44): one OpenAI-compatible chat endpoint + model + API key, set in
// Admin → Site → AI provider. Nothing is configured by default — every AI feature is off until an
// admin saves an endpoint, a model and a key. Every call made through `getAi` records its outcome
// (last_ok_at / last_error_*) so the desk can show a failing provider to the admin.

export const AI_NOT_CONFIGURED_MESSAGE = `No AI provider is set up — add an endpoint, model and API key in ${PROVIDER_SETTINGS_HINT}.`;
export const AI_KEY_UNREADABLE_MESSAGE = `The saved AI provider key can't be read (the server secret changed) — enter the key again in ${PROVIDER_SETTINGS_HINT}.`;

const TEST_TIMEOUT_MS = 20_000;

export interface ResolvedAi {
  client: LlmClient;
  model: string;
}

// ---------------------------------------------------------------------------------------------
// Test seam: a stub client stands in for the configured provider (never on real-key paths).
// ---------------------------------------------------------------------------------------------

let testOverride: ResolvedAi | null = null;

export function setAiForTests(override: { client: LlmClient; model?: string } | null): void {
  testOverride = override ? { client: override.client, model: override.model ?? 'stub/model' } : null;
}

// ---------------------------------------------------------------------------------------------

async function rowFor(siteId: string): Promise<AiProviderRow | null> {
  const [row] = await getDb().select().from(aiProvider).where(eq(aiProvider.siteId, siteId)).limit(1);
  return row ?? null;
}

function keyOf(row: AiProviderRow | null): { key: string | null; unreadable: boolean } {
  if (!row?.apiKeySealed) return { key: null, unreadable: false };
  const key = open(row.apiKeySealed, getConfig().sessionSecret);
  return { key, unreadable: key === null };
}

function failing(row: AiProviderRow | null): boolean {
  if (!row?.lastErrorAt) return false;
  return !row.lastOkAt || row.lastErrorAt.getTime() > row.lastOkAt.getTime();
}

function toDto(row: AiProviderRow | null): AiProviderDto {
  const { key, unreadable } = keyOf(row);
  return {
    configured: Boolean(row && row.baseUrl && row.model && key),
    baseUrl: row?.baseUrl ?? '',
    model: row?.model ?? '',
    keySet: Boolean(row?.apiKeySealed),
    keyHint: row?.apiKeyHint ?? null,
    keyUnreadable: unreadable,
    status: {
      failing: failing(row),
      lastOkAt: row?.lastOkAt?.toISOString() ?? null,
      lastErrorAt: row?.lastErrorAt?.toISOString() ?? null,
      lastErrorCode: row?.lastErrorCode ?? null,
      lastErrorMessage: row?.lastErrorMessage ?? null,
    },
  };
}

export async function getAiProvider(siteId: string): Promise<AiProviderDto> {
  return toDto(await rowFor(siteId));
}

/** Whether AI features can run (a complete, readable provider — or a test stub). */
export async function isAiConfigured(siteId: string): Promise<boolean> {
  if (testOverride) return true;
  return (await getAiProvider(siteId)).configured;
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export const aiProviderBody = z
  .object({
    baseUrl: z
      .string()
      .trim()
      .min(1, 'The endpoint can’t be empty.')
      .max(500, 'The endpoint must be 500 characters or fewer.')
      .refine(isHttpUrl, 'The endpoint must be an http(s) URL, e.g. https://api.openai.com/v1.'),
    model: z.string().trim().min(1, 'The model can’t be empty.').max(200, 'The model must be 200 characters or fewer.'),
    /** Omitted → keep the saved key; a string → replace it; null → remove it (turns AI off). */
    apiKey: z
      .union([z.string().trim().min(1, 'The API key can’t be empty.').max(1000, 'The API key is too long.'), z.null()])
      .optional(),
  })
  .strict();
export type AiProviderBody = z.infer<typeof aiProviderBody>;

export const aiProviderTestBody = z
  .object({
    baseUrl: z.string().trim().max(500).optional(),
    model: z.string().trim().max(200).optional(),
    apiKey: z.string().trim().max(1000).optional(),
  })
  .strict();
export type AiProviderTestBody = z.infer<typeof aiProviderTestBody>;

export async function saveAiProvider(siteId: string, body: AiProviderBody, userId: string | null): Promise<AiProviderDto> {
  const sealed =
    body.apiKey === undefined
      ? undefined
      : body.apiKey === null
        ? { apiKeySealed: null, apiKeyHint: null }
        : { apiKeySealed: seal(body.apiKey, getConfig().sessionSecret), apiKeyHint: body.apiKey.slice(-4) };
  const prev = await rowFor(siteId);
  const changed = !prev || prev.baseUrl !== body.baseUrl || prev.model !== body.model || sealed !== undefined;
  // A changed provider starts with a clean status: an old failure no longer says anything.
  const status = changed ? { lastOkAt: null, lastErrorAt: null, lastErrorCode: null, lastErrorMessage: null } : {};
  const values = { baseUrl: body.baseUrl, model: body.model, ...(sealed ?? {}), ...status, updatedBy: userId };
  await getDb()
    .insert(aiProvider)
    .values({ siteId, ...values })
    .onConflictDoUpdate({ target: aiProvider.siteId, set: values });
  log.info('ai.provider_saved', {
    site_id: siteId,
    user_id: userId,
    host: new URL(body.baseUrl).host,
    model: body.model,
    key: body.apiKey === undefined ? 'kept' : body.apiKey === null ? 'removed' : 'replaced',
  });
  return getAiProvider(siteId);
}

/** Records a call's outcome on the provider row (best effort; never fails the caller). */
export async function recordAiOutcome(siteId: string, outcome: { ok: true } | { ok: false; code: string; message: string }): Promise<void> {
  try {
    const now = new Date();
    const set = outcome.ok
      ? { lastOkAt: now }
      : { lastErrorAt: now, lastErrorCode: outcome.code, lastErrorMessage: outcome.message.slice(0, 500) };
    await getDb().update(aiProvider).set(set).where(eq(aiProvider.siteId, siteId));
  } catch (error) {
    log.warn('ai.outcome_not_recorded', { site_id: siteId, err_message: error instanceof Error ? error.message : 'unknown' });
  }
}

/** Wraps a client so every call's outcome lands on the provider row. */
class TrackedClient implements LlmClient {
  constructor(
    private readonly inner: LlmClient,
    private readonly siteId: string,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    try {
      const res = await this.inner.chat(req);
      await recordAiOutcome(this.siteId, { ok: true });
      return res;
    } catch (error) {
      if (error instanceof LlmError) await recordAiOutcome(this.siteId, { ok: false, code: error.code, message: error.message });
      throw error;
    }
  }
}

function clientFor(baseUrl: string, apiKey: string): LlmClient {
  return new ChatClient({ apiKey: new Secret(apiKey), baseUrl, referer: getConfig().publicBaseUrl });
}

/** The configured provider, or null when AI is off. */
export async function resolveAi(siteId: string): Promise<ResolvedAi | null> {
  if (testOverride) return testOverride;
  const row = await rowFor(siteId);
  const { key } = keyOf(row);
  if (!row || !key) return null;
  return { client: new TrackedClient(clientFor(row.baseUrl, key), siteId), model: row.model };
}

/** The configured provider; throws LLM_NOT_CONFIGURED (503) when AI is off. */
export async function getAi(siteId: string): Promise<ResolvedAi> {
  const ai = await resolveAi(siteId);
  if (ai) return ai;
  const row = await rowFor(siteId);
  const message = keyOf(row).unreadable ? AI_KEY_UNREADABLE_MESSAGE : AI_NOT_CONFIGURED_MESSAGE;
  throw new ApiError('LLM_NOT_CONFIGURED', 503, message);
}

/**
 * "Test" in Admin → Site → AI provider: one tiny JSON chat call with the form's values over the saved
 * ones (an omitted key = the saved key). Reports ok + latency, or the provider's error in plain words.
 * The outcome is recorded only when it tested exactly the saved provider.
 */
export async function testAiProvider(siteId: string, body: AiProviderTestBody, requestId: string): Promise<AiProviderTestResult> {
  const row = await rowFor(siteId);
  const baseUrl = body.baseUrl || row?.baseUrl || '';
  const model = body.model || row?.model || '';
  const key = body.apiKey || keyOf(row).key;
  if (!baseUrl || !isHttpUrl(baseUrl)) return { ok: false, code: 'VALIDATION_FAILED', message: 'Enter an http(s) endpoint first.' };
  if (!model) return { ok: false, code: 'VALIDATION_FAILED', message: 'Enter a model first.' };
  if (!key) return { ok: false, code: 'VALIDATION_FAILED', message: 'Enter an API key first.' };
  const saved = Boolean(row && row.baseUrl === baseUrl && row.model === model && !body.apiKey);

  const started = performance.now();
  try {
    const res = await clientFor(baseUrl, key).chat({
      model,
      purpose: 'ai.test',
      promptVersion: 'ai-test-v1',
      requestId,
      timeoutMs: TEST_TIMEOUT_MS,
      json: true,
      maxTokens: 20,
      messages: [
        { role: 'system', content: 'You are a connectivity check. Answer with JSON only.' },
        { role: 'user', content: 'Reply with exactly {"ok":true}' },
      ],
    });
    const latencyMs = Math.round(performance.now() - started);
    const reply = parseJsonReply(res.content);
    if (saved) await recordAiOutcome(siteId, { ok: true });
    return {
      ok: true,
      latencyMs,
      model,
      jsonOk: typeof reply === 'object' && reply !== null && (reply as { ok?: unknown }).ok === true,
    };
  } catch (error) {
    if (!(error instanceof LlmError)) throw error;
    if (saved) await recordAiOutcome(siteId, { ok: false, code: error.code, message: error.message });
    const detail = error.detail && error.detail !== error.message ? ` (${error.detail.slice(0, 160)})` : '';
    return { ok: false, code: error.code, message: error.message + detail };
  }
}
