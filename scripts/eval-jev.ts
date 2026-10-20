// pnpm eval:jev — Jev ranking evaluation (spec/agent.md §7). Runs Jev for real on the 5 seed posts +
// tests/fixtures/articles/hard-cases.md and prints, per article: slug, N, k, batches, the top k lines
// with their scores in rank order, coverage (span of selected indices / N), thirds covered and picks
// per third (first/middle/last, "clustered" when all k fall in one third), input/output tokens,
// cost, latency; then totals. Run on every prompt version change and paste the output into the
// commit/PR. Never prints the key.
// Exit codes: 0 all articles ok · 1 any article failed.
// PENDING KEY rule (spec/architecture.md ## Conventions): no real key and `realKeyRequired` false → prints
// PENDING KEY and exits 0 without scoring; required (BLOG0_REQUIRE_REAL_KEY=1, or CI=true when that is
// unset) with a missing/placeholder key → prints PENDING KEY and exits 1.
import './lib/allow-server-only';

import { loadEnvConfig } from '@next/env';

import { CONFIG_DEFAULTS, Secret } from '../src/server/config';
import { renderArticle } from '../src/server/content/render';
import { loadJevEvalArticles } from '../src/server/jev/articles';
import { jevInputFromRendered } from '../src/server/jev/build-input';
import { JEV_PROMPT_VERSION } from '../src/server/jev/prompt';
import { rankScores } from '../src/server/jev/rank';
import { runJev } from '../src/server/jev/run';
import { openRouterKeyStatus, PENDING_KEY_REASON, realKeyRequired } from '../src/server/llm/key';
import { OpenRouterDecisionsClient } from '../src/server/llm/openrouter';

function plain(name: string): string | undefined {
  const value = (process.env[name] ?? '').replace(/\s+#.*$/, '').trim();
  return value === '' ? undefined : value;
}

const oneLine = (text: string, max: number) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** 0 = first, 1 = middle, 2 = last third of N sentences. */
export function thirdOf(index: number, n: number): 0 | 1 | 2 {
  return Math.min(2, Math.floor((3 * index) / n)) as 0 | 1 | 2;
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  // Keep the report readable: per-call JSON log lines only for warnings and errors (even when .env
  // sets BLOG0_LOG_LEVEL=info); BLOG0_EVAL_LOG_LEVEL overrides (e.g. info to see every llm.call).
  process.env.BLOG0_LOG_LEVEL = plain('BLOG0_EVAL_LOG_LEVEL') ?? 'warn';

  const status = openRouterKeyStatus(process.env.BLOG0_OPENROUTER_API_KEY);
  if (status !== 'real') {
    if (realKeyRequired(process.env)) {
      console.error(`${PENDING_KEY_REASON} (key ${status}) — a real key is required (BLOG0_REQUIRE_REAL_KEY=1 or CI=true); eval:jev FAILED (not scored).`);
      process.exit(1);
    }
    console.log(`${PENDING_KEY_REASON} (key ${status}) — eval:jev skipped, nothing scored. Add a real key to .env, then re-run pnpm eval:jev.`);
    process.exit(0);
  }

  const model = plain('BLOG0_JEV_MODEL') ?? CONFIG_DEFAULTS.jevModel;
  const timeoutMs = Number(plain('BLOG0_JEV_TIMEOUT_MS') ?? CONFIG_DEFAULTS.jevTimeoutMs);
  const llm = new OpenRouterDecisionsClient({
    apiKey: new Secret((process.env.BLOG0_OPENROUTER_API_KEY ?? '').trim()),
    decisionsUrl: plain('BLOG0_OPENROUTER_DECISIONS_URL') ?? CONFIG_DEFAULTS.openrouterDecisionsUrl,
    referer: plain('BLOG0_PUBLIC_BASE_URL') ?? CONFIG_DEFAULTS.publicBaseUrl,
  });

  console.log(`eval:jev · model ${model} · prompt ${JEV_PROMPT_VERSION}\n`);
  let failures = 0;
  let runs = 0;
  let totalCost = 0;
  let costMissing = 0;
  let totalLatency = 0;
  let totalIn = 0;
  let totalOut = 0;

  for (const article of loadJevEvalArticles()) {
    const rendered = await renderArticle({ title: article.title, dek: article.dek, bodyMd: article.bodyMd });
    const input = jevInputFromRendered({
      articleId: `eval-${article.slug}`,
      revisionId: `eval-${article.slug}`,
      title: article.title,
      dek: article.dek,
      rendered,
      requestId: `eval-jev-${article.slug}`,
    });
    const n = input.sentences.length;
    const res = await runJev(input, { llm, model, now: () => performance.now(), timeoutMs });
    runs++;
    totalLatency += res.latencyMs;
    totalIn += res.usage.inputTokens ?? 0;
    totalOut += res.usage.outputTokens ?? 0;
    if (res.usage.costUsd === null) costMissing++;
    else totalCost += res.usage.costUsd;
    const cost = res.usage.costUsd === null ? 'n/a' : `$${res.usage.costUsd.toFixed(6)}`;
    const tokens = `${res.usage.inputTokens ?? 'n/a'}/${res.usage.outputTokens ?? 'n/a'}`;

    console.log(`${article.slug} · N ${n} · k ${res.k} · batches ${res.batches}`);
    if (!res.ok) {
      failures++;
      console.log(`  FAILED ${res.error.code}: ${res.error.message}`);
      console.log(`  tokens ${tokens} · cost ${cost} · ${res.latencyMs} ms\n`);
      continue;
    }
    const selected = new Set(res.selected.map((s) => s.sid));
    for (const s of rankScores(res.scores).filter((x) => selected.has(x.sid))) {
      console.log(`  ${s.relevance.toFixed(2)}  [${s.index}]  ${oneLine(input.sentences[s.index].text, 70)}`);
    }
    const idx = res.selected.map((s) => s.index);
    const span = n === 0 || idx.length === 0 ? 0 : (idx[idx.length - 1] - idx[0] + 1) / n;
    const perThird = [0, 0, 0];
    for (const i of idx) perThird[thirdOf(i, n)]++;
    const covered = perThird.filter((c) => c > 0).length;
    const clustered = covered === 1 && idx.length > 1 ? ' · clustered' : '';
    console.log(
      `  coverage ${Math.round(span * 100)}% (span) · thirds covered ${covered}/3 · picks per third ${perThird.join('/')} (first/middle/last)${clustered}`,
    );
    console.log(`  tokens ${tokens} · cost ${cost} · ${res.latencyMs} ms\n`);
  }

  console.log(
    `total: ${runs - failures}/${runs} ok · tokens ${totalIn}/${totalOut} · cost $${totalCost.toFixed(6)}${costMissing > 0 ? ` (+${costMissing} without reported cost)` : ''} · mean latency ${runs === 0 ? 0 : Math.round(totalLatency / runs)} ms`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`eval:jev failed: ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'}`);
  process.exit(1);
});
