import 'server-only';

import { inArray } from 'drizzle-orm';

import type { NewsletterAuditBundle, SubscriberDto } from '@/lib/api/dto';

import { getDb } from '../db/client';
import { appUser, type SiteRow } from '../db/schema';

import * as repo from './repo';
import { subscriberDtoFrom } from './service';
import { newsletterSettingsFrom } from './settings';

// Exports (capability newsletter-list.md): the CSV of every (filtered) subscriber and the audit
// bundle — the settings snapshot, every subscriber with its events, every suppression row, every
// honoured erasure request (PII-free, 0005) — enough
// to prove consent for any address without database access. < 10 k subscribers assumed (no streaming).

/* CSV (RFC 4180) with spreadsheet-formula neutralising: a cell starting with = + - @ or a
   tab/CR is prefixed with an apostrophe so opening the export never runs a formula. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const CSV_HEADER = ['email', 'name', 'status', 'subscribed_at', 'confirmed_at', 'unsubscribed_at', 'source', 'source_url', 'consent_version'] as const;

export function subscribersToCsv(subscribers: SubscriberDto[]): string {
  const lines = [CSV_HEADER.join(',')];
  for (const s of subscribers) {
    lines.push(
      [s.email, s.name ?? '', s.status, s.createdAt, s.confirmedAt ?? '', s.unsubscribedAt ?? '', s.source, s.sourceUrl ?? '', s.consentVersion ?? '']
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

export async function buildAuditBundle(site: SiteRow, actor: { email: string }, now = new Date()): Promise<NewsletterAuditBundle> {
  const db = getDb();
  const [rows, events, suppressions, erasures] = await Promise.all([
    repo.listRows(db, site.id),
    repo.allEvents(db, site.id),
    repo.allSuppressions(db, site.id),
    repo.erasuresOf(db, site.id),
  ]);
  const actorIds = [...new Set([...events.map((e) => e.actorUserId), ...erasures.map((e) => e.erasedBy)].filter((v): v is string => v !== null))];
  const actors = actorIds.length
    ? await db.select({ id: appUser.id, displayName: appUser.displayName }).from(appUser).where(inArray(appUser.id, actorIds))
    : [];
  const actorName = new Map(actors.map((a) => [a.id, a.displayName]));
  const eventsBy = new Map<string, typeof events>();
  for (const e of events) {
    const list = eventsBy.get(e.subscriberId) ?? [];
    list.push(e);
    eventsBy.set(e.subscriberId, list);
  }
  const suppressionsBy = new Map<string, typeof suppressions>();
  for (const s of suppressions) {
    const list = suppressionsBy.get(s.subscriberId) ?? [];
    list.push(s);
    suppressionsBy.set(s.subscriberId, list);
  }
  const iso = (d: Date | null) => (d ? d.toISOString() : null);

  const subscribers: NewsletterAuditBundle['subscribers'] = [];
  for (const row of rows) {
    const base = await subscriberDtoFrom(db, row, now);
    const { canSendConfirmation: _c, pendingExpired: _p, ...rest } = base;
    subscribers.push({
      ...rest,
      signupIp: row.signupIp,
      signupUserAgent: row.signupUserAgent,
      consentText: row.consentText,
      confirmedIp: row.confirmedIp,
      confirmedUserAgent: row.confirmedUserAgent,
      confirmTokenExpiresAt: iso(row.confirmTokenExpiresAt),
      confirmationSentCount: row.confirmationSentCount,
      legacyConfirmationSentAt: iso(row.legacyConfirmationSentAt),
      providerId: row.providerId,
      ipPrunedAt: iso(row.ipPrunedAt),
      events: (eventsBy.get(row.id) ?? []).map((e) => ({
        id: e.id,
        kind: e.kind,
        source: e.source,
        actor: e.actorUserId ? (actorName.get(e.actorUserId) ?? null) : null,
        ip: e.ip,
        userAgent: e.userAgent,
        details: e.details,
        createdAt: e.createdAt.toISOString(),
      })),
      suppressions: (suppressionsBy.get(row.id) ?? []).map((s) => ({ id: s.id, reason: s.reason, source: s.source, details: s.details, createdAt: s.createdAt.toISOString() })),
    });
  }

  return {
    format: 'blog0-newsletter-audit/1',
    exportedAt: now.toISOString(),
    exportedBy: actor.email,
    site: { slug: site.slug, brandName: site.brandName },
    settings: newsletterSettingsFrom(site),
    subscribers,
    suppressions: suppressions.map((s) => ({
      id: s.id,
      reason: s.reason,
      source: s.source,
      details: s.details,
      createdAt: s.createdAt.toISOString(),
      email: s.email,
      subscriberId: s.subscriberId,
    })),
    // Erasure requests honoured (0005): when, by whom, what went — no address, no hash.
    erasures: erasures.map((e) => {
      const n = (k: string) => (typeof e.details[k] === 'number' ? (e.details[k] as number) : 0);
      return {
        id: e.id,
        erasedAt: e.erasedAt.toISOString(),
        erasedBy: e.erasedBy ? (actorName.get(e.erasedBy) ?? null) : null,
        source: e.source,
        providerOutcome: e.providerOutcome,
        deleted: { subscribers: n('subscribers'), events: n('events'), messages: n('messages'), suppressions: n('suppressions') },
      };
    }),
  };
}
