// pnpm check:openrouter — proves the OpenRouter key and the Jev model slug are alive with one real call.
// Self-contained (plain fetch, not the LLM adapter). Prints only booleans/numbers — never the key.
// Exit 1 on any failure. Model + fallback list: spec/agent.md §3.
import { loadEnvConfig } from '@next/env';

const FALLBACK_MODELS = [
  'google/gemini-2.5-flash',
  'anthropic/claude-haiku-4.5',
  'openai/gpt-5-mini',
  'google/gemini-2.5-flash-lite',
] as const;
const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const TIMEOUT_MS = 60_000;

function plain(name: string): string | undefined {
  const value = (process.env[name] ?? '').replace(/\s+#.*$/, '').trim();
  return value === '' ? undefined : value;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function call(url: string, key: string, init: RequestInit = {}): Promise<{ status: number; body: unknown; ms: number }> {
  const started = performance.now();
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': plain('BLOG0_PUBLIC_BASE_URL') ?? 'http://localhost:3410',
      'X-Title': 'blog0',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, ms: Math.round(performance.now() - started) };
}

function providerError(body: unknown): string {
  const err = (body as { error?: { message?: unknown; code?: unknown } } | null)?.error;
  if (err && typeof err.message === 'string') return err.message.slice(0, 300);
  return 'no error message';
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });

  // 1. key present
  const key = (process.env.BLOG0_OPENROUTER_API_KEY ?? '').trim();
  console.log(`key present: ${key !== ''}`);
  if (key === '') {
    fail('BLOG0_OPENROUTER_API_KEY is not set — add it to .env at the repo root (see .env.example).');
  }
  const base = (plain('BLOG0_OPENROUTER_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = plain('BLOG0_JEV_MODEL') ?? DEFAULT_MODEL;

  // 2. key valid
  const keyRes = await call(`${base}/key`, key);
  console.log(`key valid: ${keyRes.status === 200}`);
  if (keyRes.status === 401 || keyRes.status === 403) {
    fail(`OpenRouter rejected the key (HTTP ${keyRes.status}) — check BLOG0_OPENROUTER_API_KEY in .env.`);
  }
  if (keyRes.status !== 200) fail(`GET /key failed: HTTP ${keyRes.status} — ${providerError(keyRes.body)}`);

  // 3. model listed + fallback availability
  const modelsRes = await call(`${base}/models`, key);
  if (modelsRes.status !== 200) fail(`GET /models failed: HTTP ${modelsRes.status} — ${providerError(modelsRes.body)}`);
  const models = ((modelsRes.body as { data?: Array<{ id: string; supported_parameters?: string[] }> }).data ?? []);
  const byId = new Map(models.map((m) => [m.id, m]));
  const listed = byId.has(model);
  console.log(`model ${model} listed: ${listed}`);
  if (listed) {
    const params = byId.get(model)?.supported_parameters ?? [];
    console.log(`model ${model} supports response_format: ${params.includes('response_format') || params.includes('structured_outputs')}`);
  }
  console.log('fallback availability:');
  for (const slug of FALLBACK_MODELS) console.log(`  ${slug}: ${byId.has(slug)}`);
  if (!listed) {
    const first = FALLBACK_MODELS.find((slug) => byId.has(slug));
    fail(
      `Model ${model} is not listed on OpenRouter. ` +
        (first ? `Set BLOG0_JEV_MODEL=${first} in .env and .env.example and record it in spec/agent.md §3.` : 'No fallback is listed either.'),
    );
  }

  // 4. one structured-output call
  const chatRes = await call(`${base}/chat/completions`, key, {
    method: 'POST',
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with ok=true.' }],
      max_tokens: 20,
      temperature: 0,
      provider: { require_parameters: true },
      usage: { include: true },
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'check',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['ok'],
            properties: { ok: { type: 'boolean' } },
          },
        },
      },
    }),
  });
  if (chatRes.status !== 200) {
    fail(`structured call: FAILED · HTTP ${chatRes.status} · ${providerError(chatRes.body)}`);
  }
  const body = chatRes.body as {
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: { total_tokens?: number; cost?: number };
    error?: unknown;
  };
  if (body?.error) fail(`structured call: FAILED · HTTP ${chatRes.status} · ${providerError(body)}`);
  let content = (body?.choices?.[0]?.message?.content ?? '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(content);
  if (fence) content = fence[1];
  let parsedOk = false;
  try {
    parsedOk = (JSON.parse(content) as { ok?: unknown }).ok === true;
  } catch {
    parsedOk = false;
  }
  if (!parsedOk) fail(`structured call: FAILED · HTTP ${chatRes.status} · content was not {"ok":true} JSON`);
  const tokens = body.usage?.total_tokens ?? 'n/a';
  const cost = typeof body.usage?.cost === 'number' ? body.usage.cost.toFixed(6) : 'n/a';
  console.log(`structured call: ok · tokens ${tokens} · cost $${cost} · ${chatRes.ms} ms`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
  console.error(`check:openrouter failed: ${message}`);
  process.exit(1);
});
