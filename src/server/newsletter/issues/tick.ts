import 'server-only';

import { getDb } from '../../db/client';
import { log, maskEmail } from '../../log';
import { pruneIps } from '../prune';
import * as listRepo from '../repo';
import { getNewsletterSender } from '../sender';
import { providerOptOutWins } from '../sender/opt-out';
import type { NewsletterSender } from '../sender/types';
import { SUPPRESSED_STATUSES, suppressByEmail } from '../service';

import * as repo from './repo';
import { refreshStats } from './send';
import { runDigestTick } from './triggers';

// `pnpm newsletter:tick` (spec/architecture.md §13.3; run hourly by an external scheduler — blog0
// has no in-process timer): digest days rule → provider suppressions into blog0 → stats for issues
// sent in the last 30 days → the 12-month IP prune → one `newsletter.tick` line.

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back provider suppressions are read each run (idempotent: known ones are skipped). */
export const SUPPRESSION_LOOKBACK_MS = 30 * DAY_MS;
export const STATS_WINDOW_MS = 30 * DAY_MS;

export interface TickResult {
  digestCreated: boolean;
  digestIssueNumber: number | null;
  suppressionsPulled: number;
  statsRefreshed: number;
  statsFailed: number;
  ipsPruned: number;
  errors: string[];
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/**
 * Provider → blog0, suppressions only (blocklists, list-level unsubscribes, hard bounces,
 * complaints). An address is suppressed when blog0 knows it, it is not suppressed already, and the
 * provider event is newer than the subscriber's latest consent / confirmation (sender/opt-out.ts —
 * a re-subscription after an old provider opt-out is never undone).
 */
export async function pullSuppressions(siteId: string, sender: NewsletterSender, now: Date): Promise<number> {
  const found = await sender.fetchSuppressions(new Date(now.getTime() - SUPPRESSION_LOOKBACK_MS));
  let pulled = 0;
  for (const s of found) {
    const row = await listRepo.findByEmail(getDb(), siteId, s.email.trim().toLowerCase());
    if (!row || SUPPRESSED_STATUSES.includes(row.status)) continue;
    if (!providerOptOutWins(s.at, row)) continue;
    const { applied } = await suppressByEmail(siteId, row.email, { reason: s.reason, source: 'provider', details: { ...s.details, at: s.at.toISOString() }, now, optOutAt: s.at });
    if (applied) {
      pulled += 1;
      log.info('newsletter.sync', { trigger: 'tick', msg: `Provider suppression applied (${s.reason})`, email_masked: maskEmail(row.email), subscriber_id: row.id });
    }
  }
  return pulled;
}

export async function runTick(siteId: string, options: { now?: Date; sender?: NewsletterSender } = {}): Promise<TickResult> {
  const started = performance.now();
  const now = options.now ?? new Date();
  const sender = options.sender ?? getNewsletterSender();
  const result: TickResult = { digestCreated: false, digestIssueNumber: null, suppressionsPulled: 0, statsRefreshed: 0, statsFailed: 0, ipsPruned: 0, errors: [] };

  try {
    const issue = await runDigestTick(siteId, now, { sender });
    result.digestCreated = issue !== null;
    result.digestIssueNumber = issue?.number ?? null;
  } catch (err) {
    result.errors.push(`digest: ${errorText(err)}`);
  }

  try {
    result.suppressionsPulled = await pullSuppressions(siteId, sender, now);
  } catch (err) {
    result.errors.push(`suppressions: ${errorText(err)}`);
  }

  try {
    const sent = await repo.recentlySentIssues(getDb(), siteId, new Date(now.getTime() - STATS_WINDOW_MS));
    for (const issue of sent) {
      try {
        await refreshStats(siteId, issue.id, { userId: null }, { sender, now });
        result.statsRefreshed += 1;
      } catch (err) {
        result.statsFailed += 1;
        result.errors.push(`stats #${issue.number}: ${errorText(err)}`);
      }
    }
  } catch (err) {
    result.errors.push(`stats: ${errorText(err)}`);
  }

  try {
    result.ipsPruned = (await pruneIps(now, siteId)).pruned;
  } catch (err) {
    result.errors.push(`prune: ${errorText(err)}`);
  }

  const fields = {
    digest_created: result.digestCreated,
    suppressions_pulled: result.suppressionsPulled,
    stats_refreshed: result.statsRefreshed,
    ips_pruned: result.ipsPruned,
    errors: result.errors.length,
    latency_ms: Math.round(performance.now() - started),
  };
  if (result.errors.length > 0) log.warn('newsletter.tick', { msg: `Tick finished with ${result.errors.length} error(s)`, ...fields });
  else log.info('newsletter.tick', { msg: 'Tick finished', ...fields });
  return result;
}
