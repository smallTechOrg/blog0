import 'server-only';

import type { NewsletterSyncResponse } from '@/lib/api/dto';

import { getDb } from '../../db/client';
import type { NewsletterSubscriberRow, SiteRow } from '../../db/schema';
import { log, maskEmail } from '../../log';
import { getCurrentSite } from '../../site/current';
import { consentLine, unsubscribeUrl } from '../links';
import * as listRepo from '../repo';
import { markProviderSynced, suppressByEmail } from '../service';

import { getNewsletterSender } from './index';
import type { NewsletterSender, SenderSubscriber } from './types';

// blog0 → provider sync (spec/architecture.md §13.3 "Sync"). One direction only: the provider gets
// a copy of every `confirmed` row (upsert with consent attributes) and a blocklist entry for every
// `unsubscribed` / `bounced` row; `pending` / `legacy_unconfirmed` are skipped. Nothing is read back
// into blog0 except the provider id. Idempotent: a row whose provider copy is already equal writes
// nothing (no event, no timestamp), so a second run reports `0 changed` and leaves blog0 untouched.
// With the stub sender every row is skipped (the stub keeps no list worth mirroring).
// One exception to "nothing is read back": an opt-out at the provider (blocklist / list-level
// unsubscribe) newer than a confirmed row's latest consent / confirmation is never overwritten — the
// adapter writes nothing and the row is suppressed in blog0 (`suppressByEmail`, source `provider`),
// counted as `suppressedFromProvider` (sender/opt-out.ts). An opt-out anywhere wins.

export type SyncTrigger = 'script' | 'admin' | 'confirm' | 'unsubscribe' | 'webhook' | 'tick' | 'send';

export type SyncResult = NewsletterSyncResponse;

type SyncSite = Pick<SiteRow, 'brandName' | 'timezone'>;

/** The provider's copy of a subscriber (attributes feed the issue template's unsubscribe link + consent line). */
export function senderSubscriberFrom(row: NewsletterSubscriberRow, site: SyncSite): SenderSubscriber {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    subscriberId: row.id,
    email: row.email,
    name: row.name,
    status: row.status === 'confirmed' ? 'enabled' : 'blocklisted',
    attribs: {
      blog0_subscriber_id: row.id,
      blog0_unsubscribe_url: unsubscribeUrl(row.id),
      blog0_consent_line: consentLine(row, site),
      consent_version: row.consentVersion,
      consented_at: iso(row.consentedAt),
      confirmed_at: iso(row.confirmedAt),
      signup_source_url: row.signupSourceUrl,
    },
  };
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/** `unchanged` = the provider copy was already equal (counted nowhere — a second run prints `0 changed`). */
type Outcome = 'synced' | 'blocklisted' | 'skipped' | 'unchanged' | 'suppressed_from_provider';

const RESULT_KEY = {
  synced: 'synced',
  blocklisted: 'blocklisted',
  skipped: 'skipped',
  suppressed_from_provider: 'suppressedFromProvider',
} as const satisfies Record<Exclude<Outcome, 'unchanged'>, keyof SyncResult>;

async function syncRow(
  sender: NewsletterSender,
  row: NewsletterSubscriberRow,
  site: SyncSite,
  source: 'system' | 'admin',
  trigger: SyncTrigger,
  mode: 'all' | 'one',
): Promise<{ outcome: Outcome; changed: boolean }> {
  if (row.status === 'confirmed') {
    const { providerId, changed, optOut } = await sender.syncSubscriber(senderSubscriberFrom(row, site));
    if (optOut !== undefined) {
      // The provider holds a newer opt-out: record it in blog0 (the suppression hook then blocklists
      // the address at the provider); the membership is never re-added.
      const { accepted } = await suppressByEmail(row.siteId, row.email, {
        reason: optOut.reason,
        source: 'provider',
        details: { ...optOut.details, at: optOut.at.toISOString(), trigger },
      });
      log.info('newsletter.sync', { trigger, msg: 'Provider opt-out is newer than the confirmation; suppressed in blog0, not re-added', email_masked: maskEmail(row.email), subscriber_id: row.id, accepted });
      if (row.providerId !== providerId) await listRepo.updateSubscriber(getDb(), row.id, { providerId });
      return { outcome: 'suppressed_from_provider', changed: false };
    }
    if (changed) {
      await markProviderSynced(row, { providerId, kind: 'provider_synced', source, details: { sender: sender.kind, trigger } });
    } else if (row.providerId !== providerId) {
      // Already equal at the provider (e.g. a restored database): remember the id, nothing else.
      await listRepo.updateSubscriber(getDb(), row.id, { providerId });
    }
    return { outcome: changed ? 'synced' : 'unchanged', changed };
  }
  if (row.status === 'unsubscribed' || row.status === 'bounced') {
    // The full sync makes sure the address is blocklisted at the provider even if it was never
    // there (so a provider-side import can never mail it); the live hook just blocklists.
    const changed =
      mode === 'all'
        ? (await sender.syncSubscriber(senderSubscriberFrom(row, site))).changed
        : (await sender.removeSubscriber(row.email)).changed;
    if (changed) await markProviderSynced(row, { providerId: null, kind: 'provider_removed', source, details: { sender: sender.kind, trigger } });
    return { outcome: changed ? 'blocklisted' : 'unchanged', changed };
  }
  return { outcome: 'skipped', changed: false };
}

/**
 * Every subscriber of the site. Counts: `synced` = confirmed rows the provider changed for, `blocklisted`
 * = suppressed rows newly blocklisted, `skipped` = pending / legacy rows (with the stub sender: every
 * row), `suppressedFromProvider` = confirmed rows suppressed because the provider holds a newer
 * opt-out; rows already equal at the provider count nowhere; `changed = synced + blocklisted`. Per-row
 * errors are collected, not thrown.
 */
export async function syncAll(trigger: SyncTrigger, options: { sender?: NewsletterSender; siteId?: string; source?: 'system' | 'admin' } = {}): Promise<SyncResult> {
  const started = performance.now();
  const sender = options.sender ?? getNewsletterSender();
  const site = await getCurrentSite();
  const siteId = options.siteId ?? site.id;
  const rows = await listRepo.listRows(getDb(), siteId);
  const result: SyncResult = { synced: 0, blocklisted: 0, skipped: 0, suppressedFromProvider: 0, changed: 0, errors: [] };

  for (const row of rows) {
    if (sender.kind === 'stub') {
      result.skipped += 1;
      continue;
    }
    try {
      const { outcome, changed } = await syncRow(sender, row, site, options.source ?? 'system', trigger, 'all');
      if (outcome !== 'unchanged') result[RESULT_KEY[outcome]] += 1;
      if (changed) result.changed += 1;
    } catch (err) {
      result.errors.push({ email: row.email, message: errorText(err) });
    }
  }

  const fields = {
    trigger,
    sender: sender.kind,
    synced: result.synced,
    blocklisted: result.blocklisted,
    skipped: result.skipped,
    suppressed_from_provider: result.suppressedFromProvider,
    changed: result.changed,
    errors: result.errors.length,
    latency_ms: Math.round(performance.now() - started),
  };
  if (result.errors.length > 0) log.warn('newsletter.sync', { msg: `Sync finished with ${result.errors.length} error(s)`, ...fields, error_sample: result.errors.slice(0, 3).map((e) => ({ email: maskEmail(e.email), message: e.message })) });
  else log.info('newsletter.sync', { msg: 'Sync finished', ...fields });
  return result;
}

async function one(row: NewsletterSubscriberRow, trigger: SyncTrigger, sender: NewsletterSender): Promise<Outcome> {
  const started = performance.now();
  if (sender.kind === 'stub') {
    log.debug('newsletter.sync', { trigger, sender: 'stub', subscriber_id: row.id, synced: 0, blocklisted: 0, skipped: 1, changed: 0, errors: 0, latency_ms: 0 });
    return 'skipped';
  }
  const site = await getCurrentSite();
  const { outcome, changed } = await syncRow(sender, row, site, 'system', trigger, 'one');
  log.info('newsletter.sync', {
    trigger,
    sender: sender.kind,
    subscriber_id: row.id,
    synced: outcome === 'synced' ? 1 : 0,
    blocklisted: outcome === 'blocklisted' ? 1 : 0,
    skipped: outcome === 'skipped' ? 1 : 0,
    suppressed_from_provider: outcome === 'suppressed_from_provider' ? 1 : 0,
    changed: changed ? 1 : 0,
    errors: 0,
    latency_ms: Math.round(performance.now() - started),
  });
  return outcome;
}

/** After a confirmation (committed): upsert this subscriber at the provider. Throws on provider errors (the hook swallows). */
export async function syncOne(row: NewsletterSubscriberRow, options: { sender?: NewsletterSender; trigger?: SyncTrigger } = {}): Promise<Outcome> {
  return one(row, options.trigger ?? 'confirm', options.sender ?? getNewsletterSender());
}

/** After a suppression (committed): blocklist this address at the provider. */
export async function removeOne(row: NewsletterSubscriberRow, options: { sender?: NewsletterSender; trigger?: SyncTrigger } = {}): Promise<Outcome> {
  return one(row, options.trigger ?? 'unsubscribe', options.sender ?? getNewsletterSender());
}
