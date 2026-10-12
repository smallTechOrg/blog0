// Real-key Jev integration (spec/agent.md §7): runs runJev on the real content pipeline output
// against the real OpenRouter key from .env. Structural assertions only (bounds, verbatim, fields).
// PENDING KEY rule (spec/architecture.md ## Conventions): with no real key and CI !== 'true' the real-call
// suite is SKIPPED with "PENDING KEY: BLOG0_OPENROUTER_API_KEY not set"; under CI=true a missing/placeholder
// key is a FAILURE. With a real key, provider errors fail — never skip. Never stubbed into a pass.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RenderedArticle } from '@/lib/content/types';
import { getConfig } from '@/server/config';
import { renderArticle } from '@/server/content/render';
import { loadJevEvalArticles } from '@/server/jev/articles';
import { jevInputFromRendered } from '@/server/jev/build-input';
import { runJev } from '@/server/jev/run';
import type { JevInput } from '@/server/jev/state';
import { getLlmClient, resetLlmClientForTests } from '@/server/llm';
import { openRouterKeyStatus, PENDING_KEY_REASON } from '@/server/llm/key';
import type { LlmClient } from '@/server/llm/types';

import { captureLogs, type CapturedLogs } from '../helpers/logs';

const keyStatus = openRouterKeyStatus(process.env.BLOG0_OPENROUTER_API_KEY);
const pending = keyStatus !== 'real';
const ci = process.env.CI === 'true';
const realSuite = (name: string) => (pending ? `${name} — ${PENDING_KEY_REASON}` : name);
if (pending && !ci) console.warn(`[jev-openrouter] ${PENDING_KEY_REASON} (key ${keyStatus}); real-call tests are skipped.`);

describe.runIf(pending && ci)('Jev real-key requirement under CI', () => {
  it(`fails: ${PENDING_KEY_REASON} (CI=true requires a real key)`, () => {
    throw new Error(`${PENDING_KEY_REASON} (key ${keyStatus}) — CI=true requires a real OpenRouter key; this is a failure, not a skip.`);
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

  it.each(ARTICLES.map((a) => [a.slug, a] as const))('selects a verbatim, in-bounds deck for %s', async (_slug, article) => {
    const { input, rendered } = await prepare(article);
    const plain = rendered.paragraphs.map((p) => p.text).join('\n');
    expect(input.sentences.length).toBeGreaterThan(0);

    const res = await runJev(input, deps());

    if (!res.ok) throw new Error(`Jev failed for ${article.slug}: ${res.error.code} — ${res.error.message}`);
    expect(res.picks.length).toBeGreaterThanOrEqual(res.bounds.min);
    expect(res.picks.length).toBeLessThanOrEqual(res.bounds.max);
    const indices = res.picks.map((p) => p.index);
    expect(new Set(indices).size).toBe(indices.length);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    for (const pick of res.picks) {
      expect(pick.text).toBe(input.sentences[pick.index].text);
      expect(pick.sid).toBe(input.sentences[pick.index].sid);
      expect(plain.includes(pick.text)).toBe(true);
      expect(pick.reason.trim().length).toBeGreaterThan(0);
      expect(pick.reason.length).toBeLessThanOrEqual(200);
    }
    expect(res.attempts === 1 || res.attempts === 2).toBe(true);
    expect(res.usage.totalTokens).toBeGreaterThan(0);
    expect(res.usage.providerGenerationIds.length).toBeGreaterThan(0);
    expect(res.model).toBe(getConfig().jevModel);
    expect(res.promptVersion).toBe('jev-select-v1');
    expect(res.latencyMs).toBeGreaterThan(0);
    if (res.usage.costUsd === null) {
      expect(logs.find('llm.cost_missing').length).toBeGreaterThan(0);
    } else {
      expect(res.usage.costUsd).toBeGreaterThanOrEqual(0);
    }
    const okCalls = logs.find('llm.call').filter((l) => l.outcome === 'ok');
    expect(okCalls.length).toBeGreaterThan(0);
    expect(okCalls[0]).toMatchObject({ model: res.model, prompt_version: 'jev-select-v1', request_id: input.requestId });
    expect(logs.find('jev.run')[0]).toMatchObject({ outcome: 'ok', picks: res.picks.length });
  });

  it('picks exactly N lines from a short article with fewer than four eligible sentences', async () => {
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
    expect(res.picks.map((p) => p.index)).toEqual([0, 1, 2]);
  });

  it('returns LLM_MODEL_NOT_FOUND for a deliberately wrong model slug (real call)', async () => {
    const { input } = await prepare(ARTICLES[0]);

    const res = await runJev(input, deps('blog0-nonexistent/not-a-model-v0'));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('LLM_MODEL_NOT_FOUND');
    expect(res.error.message).toContain('blog0-nonexistent/not-a-model-v0');
    expect(res.attempts).toBe(1);
    expect(res.usage.totalTokens).toBeNull();
  });
});

describe('Jev guard on the real pipeline (no model call)', () => {
  it('refuses an article with no eligible sentences before any call', async () => {
    const { input } = await prepare({ slug: 'tiny', title: 'Tiny', dek: '', bodyMd: 'Too short.\n\n- a list\n- of bits' });
    const neverCalled: LlmClient = {
      completeJson: async () => {
        throw new Error('the model must not be called');
      },
    };

    const res = await runJev(input, { llm: neverCalled, model: 'unused', now: () => performance.now() });

    expect(input.sentences).toHaveLength(0);
    expect(!res.ok && res.error.code).toBe('JEV_NO_SENTENCES');
    expect(res.attempts).toBe(0);
  });
});
