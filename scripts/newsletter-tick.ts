// pnpm newsletter:tick — the hourly newsletter housekeeping (spec/architecture.md §13.3; scheduled by
// cron / the platform scheduler — blog0 runs no in-process timer): digest days rule (creates the
// digest draft when due; sends only with auto-send on) → provider suppressions into blog0 → stats
// for issues sent in the last 30 days → the 12-month IP prune → retried Listmonk deletes of erased
// subscribers. One `newsletter.tick` log line.
// Prints "digest: created #N | not due; suppressions pulled N; stats refreshed N; ips pruned N; erasures retried N";
// exits 1 when any step failed (the others still ran).
import { runCli } from './lib/cli';

import { closeDb, initDb } from '../src/server/db/client';
import { runTick } from '../src/server/newsletter/issues/tick';
import { getCurrentSite } from '../src/server/site/current';

runCli('newsletter:tick', async () => {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  if (args.length > 0) throw new Error(`Unknown argument(s): ${args.join(' ')}\nUsage: pnpm newsletter:tick`);
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
});
