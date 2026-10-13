// Real-key Jev integration (spec/agent.md §7): runs runJev on the real content pipeline output
// against the real OpenRouter decisions endpoint with the key from .env. Structural assertions only
// (every sentence scored once in [0,1], top k, verbatim, fields).
// PENDING KEY rule (spec/architecture.md ## Conventions): with no real key and `realKeyRequired` false the
// real-call suite is SKIPPED with "PENDING KEY: BLOG0_OPENROUTER_API_KEY not set"; when a real key is required
// (BLOG0_REQUIRE_REAL_KEY=1, or CI=true when that is unset) a missing/placeholder key is a FAILURE. With a real key, provider errors fail — never skip. Never stubbed into a pass.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RenderedArticle } from '@/lib/content/types';
import { getConfig } from '@/server/config';
import { renderArticle } from '@/server/content/render';
import { loadJevEvalArticles } from '@/server/jev/articles';
import { planBatches } from '@/server/jev/batches';
import { buildState, jevInputFromRendered } from '@/server/jev/build-input';
import { loadRankPrompt } from '@/server/jev/prompt';
import { runJev } from '@/server/jev/run';
import { JEV_REQUEST_CHAR_BUDGET, type JevInput } from '@/server/jev/state';
import { getLlmClient, resetLlmClientForTests } from '@/server/llm';
import { openRouterKeyStatus, PENDING_KEY_REASON, realKeyRequired } from '@/server/llm/key';
import type { LlmClient } from '@/server/llm/types';

import { captureLogs, type CapturedLogs } from '../helpers/logs';

const keyStatus = openRouterKeyStatus(process.env.BLOG0_OPENROUTER_API_KEY);
const pending = keyStatus !== 'real';
const keyRequired = realKeyRequired(process.env);
const realSuite = (name: string) => (pending ? `${name} — ${PENDING_KEY_REASON}` : name);
if (pending && !keyRequired) console.warn(`[jev-openrouter] ${PENDING_KEY_REASON} (key ${keyStatus}); real-call tests are skipped.`);

describe.runIf(pending && keyRequired)('Jev real-key requirement (BLOG0_REQUIRE_REAL_KEY=1 / CI)', () => {
  it(`fails: ${PENDING_KEY_REASON} (a real key is required: BLOG0_REQUIRE_REAL_KEY=1 or CI=true)`, () => {
    throw new Error(`${PENDING_KEY_REASON} (key ${keyStatus}) — a real OpenRouter key is required (BLOG0_REQUIRE_REAL_KEY=1, or CI=true when unset); this is a failure, not a skip.`);
  });
});

const ARTICLES = loadJevEvalArticles();

async function prepare(article: { slug: string; title: string; dek: string; bodyMd: string }): Promise<{ input: JevInput; rendered: RenderedArticle }> {
  const rendered = await renderArticle({ title: article.title, dek: article.dek, bodyMd: article.bodyMd });
  const input = jevInputFromRendered({
    articleId: `itest-${article.slug}`,
    revisionId: `itest-${article.slug}-r1`,
    title: article.title,
    dek: article.dek,
    rendered,
    requestId: `itest-jev-${article.slug}`,
  });
  return { input, rendered };
}

function deps(model?: string) {
  const config = getConfig();
  return { llm: getLlmClient(), model: model ?? config.jevModel, now: () => performance.now(), timeoutMs: config.jevTimeoutMs };
}

describe.skipIf(pending)(realSuite('Jev against real OpenRouter'), () => {
  let logs: CapturedLogs;

  beforeEach(() => {
    resetLlmClientForTests();
    logs = captureLogs();
  });

  afterEach(() => {
    logs.stop();
  });

  it('runs against the decisions model typesafe/jev-1.13 (BLOG0_JEV_MODEL unset or that slug)', () => {
    expect(getConfig().jevModel).toBe('typesafe/jev-1.13');
  });

  it.each(ARTICLES.map((a) => [a.slug, a] as const))('scores every sentence and selects the verbatim top k for %s', async (_slug, article) => {
    const { input, rendered } = await prepare(article);
    const plain = rendered.paragraphs.map((p) => p.text).join('\n');
    const n = input.sentences.length;
    expect(n).toBeGreaterThan(0);

    const res = await runJev(input, deps());

    if (!res.ok) throw new Error(`Jev failed for ${article.slug}: ${res.error.code} — ${res.error.message}`);
    // every sentence scored exactly once, in document order, in [0,1]
    expect(res.scores).toHaveLength(n);
    expect(res.scores.map((s) => s.sid)).toEqual(input.sentences.map((s) => s.sid));
    expect(new Set(res.scores.map((s) => s.sid)).size).toBe(n);
    for (const s of res.scores) {
      expect(Number.isFinite(s.relevance)).toBe(true);
      expect(s.relevance).toBeGreaterThanOrEqual(0);
      expect(s.relevance).toBeLessThanOrEqual(1);
    }
    // k = target; selection = top k, indices ascending
    expect(res.k).toBe(res.bounds.target);
    expect(res.selected).toHaveLength(res.k);
    const indices = res.selected.map((p) => p.index);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    const chosen = new Set(res.selected.map((p) => p.sid));
    const minSelected = Math.min(...res.selected.map((p) => p.relevance));
    const rest = res.scores.filter((s) => !chosen.has(s.sid)).map((s) => s.relevance);
    if (rest.length > 0) expect(minSelected).toBeGreaterThanOrEqual(Math.max(...rest));
    // verbatim: every selected line is the server's own sentence and appears in the article text
    for (const pick of res.selected) {
      expect(pick.sid).toBe(input.sentences[pick.index].sid);
      expect(plain.includes(input.sentences[pick.index].text)).toBe(true);
    }
    expect(res.batches).toBe(1);
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.usage.totalTokens).toBe((res.usage.inputTokens ?? 0) + (res.usage.outputTokens ?? 0));
    expect(res.usage.providerGenerationIds).toHaveLength(1);
    expect(res.model).toBe('typesafe/jev-1.13');
    expect(res.promptVersion).toBe('jev-rank-v1');
    expect(res.latencyMs).toBeGreaterThan(0);
    if (res.usage.costUsd === null) {
      expect(logs.find('llm.cost_missing').length).toBeGreaterThan(0);
    } else {
      expect(res.usage.costUsd).toBeGreaterThanOrEqual(0);
    }
    const okCalls = logs.find('llm.call').filter((l) => l.outcome === 'ok');
    expect(okCalls).toHaveLength(1);
    expect(okCalls[0]).toMatchObject({ model: res.model, prompt_version: 'jev-rank-v1', request_id: input.requestId, batch: 1, batches: 1, questions: n });
    expect(okCalls[0].provider_generation_id).toBe(res.usage.providerGenerationIds[0]);
    expect(logs.find('jev.run')[0]).toMatchObject({ outcome: 'ok', k: res.k, batches: 1, sentence_count: n });
  });

  it('a forced small request budget sends ≥ 2 real requests (state repeated) and still scores every sentence', async () => {
    const { input } = await prepare(ARTICLES.find((a) => a.slug === 'artefact-driven-development')!);
    const full = planBatches(input, buildState(input), loadRankPrompt(), getConfig().jevModel, JEV_REQUEST_CHAR_BUDGET)[0].requestChars;
    const budget = Math.ceil(full * 0.6);

    const res = await runJev(input, { ...deps(), requestCharBudget: budget });

    if (!res.ok) throw new Error(`Jev failed: ${res.error.code} — ${res.error.message}`);
    expect(res.batches).toBeGreaterThanOrEqual(2);
    expect(res.scores.map((s) => s.sid)).toEqual(input.sentences.map((s) => s.sid));
    expect(res.selected).toHaveLength(res.k);
    expect(res.usage.providerGenerationIds).toHaveLength(res.batches);
    const calls = logs.find('llm.call').filter((l) => l.outcome === 'ok');
    expect(calls).toHaveLength(res.batches);
    expect(calls.map((c) => c.batch).sort()).toEqual(Array.from({ length: res.batches }, (_, i) => i + 1));
    expect(calls.reduce((sum, c) => sum + (c.questions as number), 0)).toBe(input.sentences.length);
  });

  it('selects all N from a short article with fewer than four eligible sentences', async () => {
    const { input } = await prepare({
      slug: 'short',
      title: 'Small teams win',
      dek: '',
      bodyMd:
        'Small teams ship faster than large committees do. They also own their mistakes in public. Ok.\n\nThat ownership is the whole advantage, in the end.',
    });
    expect(input.sentences.length).toBe(3);

    const res = await runJev(input, deps());

    if (!res.ok) throw new Error(`Jev failed: ${res.error.code} — ${res.error.message}`);
    expect(res.bounds).toEqual({ min: 3, max: 3, target: 3 });
    expect(res.selected.map((p) => p.index)).toEqual([0, 1, 2]);
  });

  it('returns LLM_MODEL_NOT_FOUND for a wrong decisions slug (real call)', async () => {
    // Observed body (2026-10-13): HTTP 400 {"error":{"message":"Model typesafe/does-not-exist does not exist","code":400}}
    const { input } = await prepare(ARTICLES[0]);

    const res = await runJev(input, deps('typesafe/does-not-exist'));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('LLM_MODEL_NOT_FOUND');
    expect(res.error.message).toBe("Model 'typesafe/does-not-exist' isn't available as a decisions model — set BLOG0_JEV_MODEL (default typesafe/jev-1.13).");
    expect(res.batches).toBe(1);
    expect(res.usage.totalTokens).toBeNull();
    expect(logs.find('llm.call')[0]).toMatchObject({ outcome: 'http_error', http_status: 400, err_message: 'Model typesafe/does-not-exist does not exist' });
  });
});

describe('Jev guard on the real pipeline (no model call)', () => {
  const neverCalled: LlmClient = {
    decide: async () => {
      throw new Error('the model must not be called');
    },
  };

  it('refuses an article with no eligible sentences before any call', async () => {
    const { input } = await prepare({ slug: 'tiny', title: 'Tiny', dek: '', bodyMd: 'Too short.\n\n- a list\n- of bits' });
    const res = await runJev(input, { llm: neverCalled, model: 'unused', now: () => performance.now() });
    expect(input.sentences).toHaveLength(0);
    expect(!res.ok && res.error.code).toBe('JEV_NO_SENTENCES');
    expect(res.batches).toBe(0);
  });

  it('refuses an article over ~32 000 chars of state before any call', async () => {
    const sentence = 'This sentence is long enough to count as an eligible sentence for Jev, and it keeps going with more words so the state grows past the limit. ';
    const bodyMd = Array.from({ length: 40 }, () => sentence.repeat(6).trim()).join('\n\n');
    const { input } = await prepare({ slug: 'long', title: 'Long', dek: '', bodyMd });
    expect(input.sentences.length).toBeLessThanOrEqual(400);
    const res = await runJev(input, { llm: neverCalled, model: 'unused', now: () => performance.now() });
    expect(!res.ok && res.error.code).toBe('JEV_INPUT_TOO_LONG');
  });
});
