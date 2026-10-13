// pnpm check:openrouter — proves the OpenRouter key and the Jev decisions model are alive with one
// real 1-question decisions call (spec/roadmap.md → package.json scripts; spec/agent.md §3).
// Decisions models are not in the /models catalog and there is no fallback chain, so there is no
// catalog lookup. Self-contained (plain fetch, not the LLM adapter). Prints only booleans/numbers —
// never the key. Exit 1 on any failure.
import { loadEnvConfig } from '@next/env';

const DEFAULT_MODEL = 'typesafe/jev-1.13';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
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
  if (err && typeof err.message === 'string') return err.message.replace(/\s+/g, ' ').slice(0, 300);
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
  const decisionsUrl = (plain('BLOG0_OPENROUTER_DECISIONS_URL') ?? DEFAULT_DECISIONS_URL).replace(/\/+$/, '');
  const model = plain('BLOG0_JEV_MODEL') ?? DEFAULT_MODEL;

  // 2. key valid
  const keyRes = await call(`${base}/key`, key);
  console.log(`key valid: ${keyRes.status === 200}`);
  if (keyRes.status === 401 || keyRes.status === 403) {
    fail(`OpenRouter rejected the key (HTTP ${keyRes.status}) — check BLOG0_OPENROUTER_API_KEY in .env.`);
  }
  if (keyRes.status !== 200) fail(`GET /key failed: HTTP ${keyRes.status} — ${providerError(keyRes.body)}`);

  // 3. one real 1-question decisions call
  const res = await call(decisionsUrl, key, {
    method: 'POST',
    body: JSON.stringify({
      model,
      state: { title: 'check', dek: '', article: 'The sky is blue. Grass is green.' },
      questions: {
        check: {
          type: 'noul',
          instructions: 'Is this sentence about colour? Sentence: "The sky is blue."',
          criteria: { true: 'It names a colour.', false: 'It does not name a colour.' },
        },
      },
    }),
  });
  const notAvailable = `BLOG0_JEV_MODEL=${model} is not an available decisions model — the default is ${DEFAULT_MODEL}`;
  if (res.status === 400 || res.status === 404) {
    fail(`decisions call: FAILED · HTTP ${res.status} · ${providerError(res.body)}\n${notAvailable}`);
  }
  if (res.status !== 200) fail(`decisions call: FAILED · HTTP ${res.status} · ${providerError(res.body)}`);
  const body = res.body as {
    answers?: Record<string, { type?: unknown; noul?: unknown }>;
    usage?: { input_tokens?: unknown; output_tokens?: unknown; cost?: unknown };
    error?: unknown;
  } | null;
  if (body === null) fail(`decisions call: FAILED · HTTP ${res.status} · the body was not JSON`);
  if (body.error) fail(`decisions call: FAILED · HTTP ${res.status} · ${providerError(body)}`);
  const answer = body.answers?.check;
  const noul = answer?.noul;
  if (answer?.type !== 'noul' || typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) {
    fail(`decisions call: FAILED · HTTP ${res.status} · answers.check is not { type: 'noul', noul: <0..1> }`);
  }
  const tokens = (v: unknown) => (typeof v === 'number' ? String(v) : 'n/a');
  const cost = typeof body.usage?.cost === 'number' ? body.usage.cost.toFixed(6) : 'n/a';
  console.log(
    `decisions call: ok · model ${model} · noul ${noul.toFixed(2)} · tokens ${tokens(body.usage?.input_tokens)}/${tokens(body.usage?.output_tokens)} · cost $${cost} · ${res.ms} ms`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
  console.error(`check:openrouter failed: ${message}`);
  process.exit(1);
});
