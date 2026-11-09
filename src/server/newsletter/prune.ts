import 'server-only';

import { sql } from 'drizzle-orm';

import { getDb, rowsOf } from '../db/client';
import type { NewsletterSubscriberRow } from '../db/schema';
import { log } from '../log';
import { getCurrentSite } from '../site/current';

import { IP_RETENTION_MS } from './constants';
import * as repo from './repo';

// IP retention (capability newsletter-list.md): a row's IPs are nulled 12 months after its retention
// anchor — `coalesce(greatest(confirmed_at, consented_at), created_at)`, so a re-signup or a fresh
// confirmation restarts the clock for the IPs it wrote (`confirmed_ip` also ages out on its own
// `confirmed_at`, so an old confirmation's IP never outlives it through a pending re-signup). Event
// IPs are nulled per event once the event itself is older than the bar — through
// `newsletter_prune_event_ips(subscriber, before)` (migration 0003), the one sanctioned update of a
// ledger row (it touches `ip` only). Everything else (user agent, source URL, consent) stays. Run by
// `pnpm newsletter:tick`.

export interface PruneResult {
  /** Subscribers whose row and/or event IPs were nulled by this run. */
  pruned: number;
  /** Event rows whose `ip` was nulled. */
  eventRows: number;
}

type AnchorFields = Pick<NewsletterSubscriberRow, 'confirmedAt' | 'consentedAt' | 'createdAt'>;

/** The retention anchor (SQL twin in repo.pruneCandidates): the latest of confirmation / consent, else creation. */
export function retentionAnchor(row: AnchorFields): Date {
  const times = [row.confirmedAt, row.consentedAt].filter((d): d is Date => d !== null).map((d) => d.getTime());
  return times.length > 0 ? new Date(Math.max(...times)) : row.createdAt;
}

/** Which row IPs are past `bar` (same rule as the candidate query). */
export function rowIpsDue(row: AnchorFields & Pick<NewsletterSubscriberRow, 'signupIp' | 'confirmedIp'>, bar: Date): { signup: boolean; confirmed: boolean } {
  const anchor = retentionAnchor(row);
  return {
    signup: row.signupIp !== null && anchor < bar,
    confirmed: row.confirmedIp !== null && (row.confirmedAt ?? anchor) < bar,
  };
}

export async function pruneIps(now = new Date(), siteId?: string): Promise<PruneResult> {
  const site = siteId ?? (await getCurrentSite()).id;
  const db = getDb();
  const bar = new Date(now.getTime() - IP_RETENTION_MS);
  const candidates = await repo.pruneCandidates(db, site, bar);
  let eventRows = 0;
  let pruned = 0;
  for (const candidate of candidates) {
    await db.transaction(async (tx) => {
      // Re-read under the row lock: a re-signup between the candidate query and here restarts the clock.
      const row = await repo.findById(tx, site, candidate.id, true);
      if (!row) return;
      const [res] = rowsOf<{ n: number | string }>(
        await tx.execute(sql`select newsletter_prune_event_ips(${row.id}::uuid, ${bar.toISOString()}::timestamptz) as n`),
      );
      const n = Number(res?.n ?? 0);
      const due = rowIpsDue(row, bar);
      if (!due.signup && !due.confirmed && n === 0) return;
      eventRows += n;
      pruned += 1;
      if (due.signup || due.confirmed) {
        await repo.updateSubscriber(tx, row.id, {
          ...(due.signup ? { signupIp: null } : {}),
          ...(due.confirmed ? { confirmedIp: null } : {}),
          ipPrunedAt: now,
          updatedAt: now,
        });
      }
      await repo.appendEvent(tx, {
        siteId: site,
        subscriberId: row.id,
        email: row.email,
        kind: 'ip_pruned',
        source: 'system',
        actorUserId: null,
        ip: null,
        userAgent: null,
        details: {
          retentionDays: Math.round(IP_RETENTION_MS / 86_400_000),
          hadSignupIp: due.signup,
          hadConfirmedIp: due.confirmed,
          eventRows: n,
          before: bar.toISOString(),
        },
        createdAt: now,
      });
    });
  }
  if (pruned > 0) log.info('newsletter.tick', { msg: `Pruned IPs of ${pruned} subscriber(s)`, ips_pruned: pruned, event_rows: eventRows });
  return { pruned, eventRows };
}
