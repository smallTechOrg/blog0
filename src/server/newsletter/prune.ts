import 'server-only';

import { sql } from 'drizzle-orm';

import { getDb, rowsOf } from '../db/client';
import { log } from '../log';
import { getCurrentSite } from '../site/current';

import { IP_RETENTION_MS } from './constants';
import * as repo from './repo';

// IP retention (capability newsletter-list.md): 12 months after confirmation (or after signup for a
// row that never confirmed) both IPs are nulled on the row AND on its events — the latter through
// `newsletter_prune_event_ips()`, the one sanctioned update of a ledger row (it touches `ip` only).
// Everything else (user agent, source URL, consent) stays. Run by `pnpm newsletter:tick`.

export interface PruneResult {
  /** Subscribers whose IPs were nulled by this run. */
  pruned: number;
  /** Event rows whose `ip` was nulled. */
  eventRows: number;
}

export async function pruneIps(now = new Date(), siteId?: string): Promise<PruneResult> {
  const site = siteId ?? (await getCurrentSite()).id;
  const db = getDb();
  const bar = new Date(now.getTime() - IP_RETENTION_MS);
  const rows = await repo.pruneCandidates(db, site, bar);
  let eventRows = 0;
  for (const row of rows) {
    await db.transaction(async (tx) => {
      const [res] = rowsOf<{ n: number | string }>(await tx.execute(sql`select newsletter_prune_event_ips(${row.id}::uuid) as n`));
      eventRows += Number(res?.n ?? 0);
      await repo.updateSubscriber(tx, row.id, { signupIp: null, confirmedIp: null, ipPrunedAt: now, updatedAt: now });
      await repo.appendEvent(tx, {
        siteId: site,
        subscriberId: row.id,
        email: row.email,
        kind: 'ip_pruned',
        source: 'system',
        actorUserId: null,
        ip: null,
        userAgent: null,
        details: { retentionDays: Math.round(IP_RETENTION_MS / 86_400_000), hadSignupIp: row.signupIp !== null, hadConfirmedIp: row.confirmedIp !== null },
        createdAt: now,
      });
    });
  }
  if (rows.length > 0) log.info('newsletter.tick', { msg: `Pruned IPs of ${rows.length} subscriber(s)`, ips_pruned: rows.length });
  return { pruned: rows.length, eventRows };
}
