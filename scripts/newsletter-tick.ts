// pnpm newsletter:tick (locally, via tsx) | node newsletter-tick.mjs (in the image and the `scheduler`
// stage, bundled by scripts/build-release.mjs — Stage B, spec/architecture.md §12.7) — the hourly
// newsletter housekeeping (spec/architecture.md §13.3; scheduled by cron / supercronic — blog0 runs
// no in-process timer): digest days rule (creates the digest draft when due; sends only with
// auto-send on) → provider suppressions into blog0 → stats for issues sent in the last 30 days → the
// 12-month IP prune → retried Listmonk deletes of erased subscribers. One `newsletter.tick` log line.
// Prints "digest: created #N | not due; suppressions pulled N; stats refreshed N; ips pruned N; erasures retried N";
// exits 1 when any step failed (the others still ran); 2 on a usage error.
// Stage A: BLOG0_HEARTBEAT_TICK_URL (optional) gets GET <url> after a run that exits 0 and
// GET <url>/fail after one that exits 1 (5 s timeout; never changes the exit code; a usage error
// pings nothing). An invalid heartbeat value is reported once (`ops.heartbeat` invalid_url) and never
// fails the tick (spec/architecture.md §12.3).
// Deliberately does NOT import scripts/lib/cli.ts (the scripts/release.ts runner pattern instead):
// the bundle maps the shim below to an empty module.
import './lib/allow-server-only';

import { loadEnvConfig } from '@next/env';

import { HEARTBEAT_ENV } from '../src/server/config';
import { closeDb, initDb } from '../src/server/db/client';
import { runTick } from '../src/server/newsletter/issues/tick';
import { dropInvalidHeartbeatEnv, pingHeartbeatFromEnv } from '../src/server/ops/heartbeat';
import { getCurrentSite } from '../src/server/site/current';

const USAGE = 'Usage: pnpm newsletter:tick   (in the image: node newsletter-tick.mjs)';

class UsageError extends Error {}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  if (args.length > 0) throw new UsageError(`Unknown argument(s): ${args.join(' ')}\n${USAGE}`);
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  // Read the heartbeat before the config loads; then drop invalid heartbeat values so the full config
  // (getConfig) is not refused because of a monitoring URL.
  const heartbeatEnv = { [HEARTBEAT_ENV.tick]: process.env[HEARTBEAT_ENV.tick] };
  dropInvalidHeartbeatEnv(process.env);
  const ping = (signal: 'success' | 'fail') => pingHeartbeatFromEnv({ job: 'newsletter_tick', env: heartbeatEnv, name: HEARTBEAT_ENV.tick, signal });

  try {
    await initDb();
    try {
      const site = await getCurrentSite();
      const r = await runTick(site.id);
      const digest = r.digestCreated ? `created #${r.digestIssueNumber}` : 'not due';
      console.log(`digest: ${digest}; suppressions pulled ${r.suppressionsPulled}; stats refreshed ${r.statsRefreshed}; ips pruned ${r.ipsPruned}; erasures retried ${r.erasuresRetried}`);
      if (r.errors.length > 0) {
        for (const e of r.errors) console.error(`error: ${e}`);
        throw new Error(`${r.errors.length} step(s) failed`);
      }
    } finally {
      await closeDb();
    }
  } catch (error) {
    await ping('fail');
    throw error;
  }
  await ping('success');
}

main().catch((error: unknown) => {
  console.error(`newsletter:tick failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(error instanceof UsageError ? 2 : 1);
});
