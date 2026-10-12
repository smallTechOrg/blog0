// pnpm eval:jev — non-gating Jev evaluation (spec/agent.md §7). Runs Jev for real on the 5 seed posts
// + tests/fixtures/articles/hard-cases.md and prints: article, N, bounds, picks, coverage (span of
// picked indices / N), first/last-third hit, attempts, tokens, cost, latency. Run on every prompt
// version change and paste the table into the PR. Never prints the key.
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
import { runJev } from '../src/server/jev/run';
import { openRouterKeyStatus, PENDING_KEY_REASON, realKeyRequired } from '../src/server/llm/key';
import { OpenRouterClient } from '../src/server/llm/openrouter';

function plain(name: string): string | undefined {
  const value = (process.env[name] ?? '').replace(/\s+#.*$/, '').trim();
  return value === '' ? undefined : value;
}

function pad(cells: string[], widths: number[]): string {
  return cells.map((c, i) => c.padEnd(widths[i])).join('  ');
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  // Keep the table readable: per-call JSON log lines only for warnings and errors.
  if (!plain('BLOG0_LOG_LEVEL')) process.env.BLOG0_LOG_LEVEL = 'warn';

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
  const llm = new OpenRouterClient({
    apiKey: new Secret((process.env.BLOG0_OPENROUTER_API_KEY ?? '').trim()),
    baseUrl: plain('BLOG0_OPENROUTER_BASE_URL') ?? CONFIG_DEFAULTS.openrouterBaseUrl,
    referer: plain('BLOG0_PUBLIC_BASE_URL') ?? CONFIG_DEFAULTS.publicBaseUrl,
  });

  console.log(`eval:jev · model ${model} · prompt ${JEV_PROMPT_VERSION}\n`);
  const header = ['article', 'N', 'bounds', 'picks', 'coverage', 'first/last⅓', 'attempts', 'tokens', 'cost', 'latency', 'outcome'];
  const rows: string[][] = [];
  let failures = 0;
  let totalCost = 0;
  let costMissing = 0;

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
    const bounds = `${res.bounds.min}–${res.bounds.max} (${res.bounds.target})`;
    const tokens = res.usage.totalTokens === null ? 'n/a' : String(res.usage.totalTokens);
    const cost = res.usage.costUsd === null ? 'n/a' : `$${res.usage.costUsd.toFixed(6)}`;
    if (res.usage.costUsd === null) costMissing++;
    else totalCost += res.usage.costUsd;
    if (res.ok) {
      const idx = res.picks.map((p) => p.index);
      const coverage = n === 0 ? 0 : (idx[idx.length - 1] - idx[0] + 1) / n;
      const first = idx.some((i) => i < n / 3);
      const last = idx.some((i) => i >= (2 * n) / 3);
      rows.push([
        article.slug, String(n), bounds, `${idx.length} [${idx.join(',')}]`, `${Math.round(coverage * 100)}%`,
        `${first ? 'y' : 'n'}/${last ? 'y' : 'n'}`, String(res.attempts), tokens, cost, `${res.latencyMs} ms`, 'ok',
      ]);
    } else {
      failures++;
      rows.push([article.slug, String(n), bounds, '-', '-', '-', String(res.attempts), tokens, cost, `${res.latencyMs} ms`, res.error.code]);
    }
  }

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  console.log(pad(header, widths));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(pad(row, widths));
  console.log(
    `\ntotal cost $${totalCost.toFixed(6)}${costMissing > 0 ? ` (+${costMissing} without reported cost)` : ''} · ${rows.length - failures}/${rows.length} ok`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`eval:jev failed: ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'}`);
  process.exit(1);
});
