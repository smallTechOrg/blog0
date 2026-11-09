import 'server-only';

import { sql } from 'drizzle-orm';

import type { ErasureProviderOutcome, SubscriberEraseResponse } from '@/lib/api/dto';

import { getDb, rowsOf } from '../db/client';
import { ApiError } from '../http/api';
import { log } from '../log';

import * as repo from './repo';
import { getNewsletterSender, redactEmails, type NewsletterSender } from './sender';
import { erasureHash } from './tokens';

// Erasure (owner decision 2026-10-19; capability newsletter-list.md "Erasure", spec/data.md
// `0005_newsletter_erase_delete`, spec/architecture.md §13.1 erase.ts). The deletion itself is the SQL
// function `newsletter_erase_subscriber(id, erased_by)` (SECURITY DEFINER; the only thing allowed past
// the ledger guard): it DELETES the subscriber and every row holding its data, keeps a keyed-hash
// "never email this address" marker and writes one PII-free audit row. Order, so blog0 is the source
// of truth and a retry is safe:
//   1. read-only: learn the provider's id for the address (blog0's `provider_id`, else a lookup);
//   2. blog0's erase commits (one transaction) — the audit row remembers that provider id;
//   3. the provider copy is DELETED (by id, else by address); "not there" counts as done. A failure
//      leaves blog0 fully erased, is logged at `warn`, recorded on the audit row (`failed`) and retried
//      by `pnpm newsletter:tick` by id (`retryProviderErasures`) — never by address, which blog0 no
//      longer has.
// Nothing here logs the address. Also the pure helpers the mail layer and signup use.

export { erasureHash };

/** What a stored confirmation message carries in place of the confirm token. */
export const REDACTED_TOKEN = '[redacted]';

const CONFIRM_LINK_RE = /(\/newsletter\/confirm\?t=)[^"&\s<]+/g;

/**
 * Replaces the `t` value of every `/newsletter/confirm?t=…` link in a stored message body
 * (`html` or `text`) with `[redacted]`. Idempotent. Mirrors the regexp of migration 0004.
 */
export function redactConfirmUrl(body: string): string {
  return body.replace(CONFIRM_LINK_RE, `$1${REDACTED_TOKEN}`);
}

const TOMBSTONE_RE = /^erased\+[0-9a-f]{64}@erased\.invalid$/;

/** True for the 0004 tombstone address (`erased+<hash>@erased.invalid`); 0005 deletes such rows. */
export function isErasedEmail(email: string): boolean {
  return TOMBSTONE_RE.test(email);
}

export interface EraseActor {
  userId: string;
  requestId?: string;
}

interface EraseSqlResult {
  erased: boolean;
  erasureId?: string;
  subscribers?: number;
  events?: number;
  messages?: number;
  suppressions?: number;
}

/** A short, address-free reason for a failure (the driver's own message, never the query or its params). */
export function failureReason(err: unknown): string {
  let e: unknown = err;
  // drizzle wraps the driver error ("Failed query: …\nparams: …") — the cause carries the real message
  while (e instanceof Error && e.cause instanceof Error && /^Failed query/i.test(e.message)) e = e.cause;
  const text = e instanceof Error ? e.message : String(e);
  return redactEmails(text.split('\n')[0] ?? '').slice(0, 200) || 'unknown error';
}

/** Admin → Delete subscriber and personal data. */
export async function eraseSubscriber(siteId: string, id: string, input: { confirmEmail: string }, actor: EraseActor): Promise<SubscriberEraseResponse> {
  const db = getDb();
  const row = await repo.findById(db, siteId, id);
  if (!row) throw new ApiError('NOT_FOUND', 404, 'That subscriber isn’t here — it may already have been deleted.');
  if (input.confirmEmail.trim().toLowerCase() !== row.email.trim().toLowerCase()) {
    throw new ApiError('VALIDATION_FAILED', 400, 'Type the subscriber’s address exactly to confirm the deletion.', { formErrors: [], fieldErrors: { confirmEmail: ['Does not match this address.'] } });
  }
  const sender = getNewsletterSender();

  // 1. Before blog0 forgets the address: the provider's id for it (read-only; a failure here only means
  //    step 3 looks the address up again, and a later retry cannot).
  let providerRef = row.providerId;
  if (sender.kind !== 'stub' && providerRef === null) {
    try {
      providerRef = await sender.findSubscriberId(row.email);
    } catch {
      providerRef = null;
    }
  }

  // 2. blog0 — the source of truth — in one transaction.
  let result: EraseSqlResult;
  try {
    result = await db.transaction(async (tx) => {
      const rows = rowsOf<{ r: EraseSqlResult | string }>(await tx.execute(sql`select newsletter_erase_subscriber(${id}::uuid, ${actor.userId}::uuid) as r`));
      const raw = rows[0]?.r;
      const parsed: EraseSqlResult = typeof raw === 'string' ? (JSON.parse(raw) as EraseSqlResult) : (raw ?? { erased: false });
      if (parsed.erased && parsed.erasureId && providerRef !== null) await repo.setErasureProvider(tx, parsed.erasureId, { providerRef });
      return parsed;
    });
  } catch (err) {
    const reason = failureReason(err);
    log.error('newsletter.erase', { msg: 'Erase failed; nothing was deleted', subscriber_id: id, outcome: 'failed', user_id: actor.userId, request_id: actor.requestId, err_message: reason });
    throw new ApiError('ERASE_FAILED', 500, `The database refused the deletion (${reason}). Nothing was deleted — try again; if it repeats, the server log has the details.`);
  }
  if (!result.erased || !result.erasureId) throw new ApiError('NOT_FOUND', 404, 'That subscriber was already deleted.');
  const erasureId = result.erasureId;

  // 3. The provider copy — after the commit, so a provider failure never leaves blog0 half-done.
  const provider = await deleteProviderCopy(sender, { providerId: providerRef, email: row.email });
  try {
    await repo.setErasureProvider(db, erasureId, { outcome: provider.outcome, providerRef: provider.providerId, checkedAt: new Date() });
  } catch (err) {
    log.warn('newsletter.erase', { msg: 'Could not record the provider outcome on the audit row', erasure_id: erasureId, err_message: failureReason(err) });
  }

  const providerRetry = provider.outcome === 'failed' && provider.providerId !== null;
  const fields = {
    subscriber_id: id,
    erasure_id: erasureId,
    outcome: 'deleted',
    provider: provider.outcome,
    provider_retry: providerRetry,
    deleted: { subscribers: result.subscribers ?? 0, events: result.events ?? 0, messages: result.messages ?? 0, suppressions: result.suppressions ?? 0 },
    user_id: actor.userId,
    request_id: actor.requestId,
  };
  if (provider.outcome === 'failed') log.warn('newsletter.erase', { msg: 'Deleted in blog0; the Listmonk copy could not be deleted', ...fields, err_message: provider.error });
  else log.info('newsletter.erase', { msg: 'Subscriber and personal data deleted', ...fields });

  return { deleted: true, erasureId, provider: provider.outcome, providerError: provider.outcome === 'failed' ? (provider.error ?? 'unknown error') : null, providerRetry };
}

async function deleteProviderCopy(
  sender: NewsletterSender,
  target: { providerId: string | null; email: string | null },
): Promise<{ outcome: ErasureProviderOutcome; providerId: string | null; error?: string }> {
  if (sender.kind === 'stub') {
    // Nothing is delivered through the stub; its in-memory copy goes too.
    await sender.deleteSubscriber(target).catch(() => undefined);
    return { outcome: 'skipped', providerId: null };
  }
  try {
    const r = await sender.deleteSubscriber(target);
    return { outcome: r.outcome === 'deleted' ? 'deleted' : 'not_found', providerId: r.providerId };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const error = redactEmails(target.email ? raw.replaceAll(target.email, '[email]') : raw).slice(0, 200);
    return { outcome: 'failed', providerId: target.providerId, error };
  }
}

/**
 * `pnpm newsletter:tick`: deletes the provider copy of every erasure whose provider step failed (or never
 * ran — a crash right after the commit, `pending` for over 10 minutes), by the remembered provider id.
 * A record that now belongs to a live blog0 subscriber (the reader signed up again) is kept. Safe to
 * run any number of times: "not there" counts as done.
 */
export async function retryProviderErasures(siteId: string, sender: NewsletterSender, now = new Date()): Promise<{ retried: number; done: number; failed: number }> {
  const out = { retried: 0, done: 0, failed: 0 };
  if (sender.kind === 'stub') return out;
  const db = getDb();
  const rows = await repo.erasuresToRetry(db, siteId, new Date(now.getTime() - 10 * 60_000));
  for (const row of rows) {
    out.retried += 1;
    try {
      const r = await sender.deleteSubscriber({
        providerId: row.providerRef,
        email: null,
        keep: async (blog0Id) => (await repo.existingSubscriberIds(db, siteId, [blog0Id])).has(blog0Id),
      });
      await repo.setErasureProvider(db, row.id, { outcome: r.outcome, checkedAt: now });
      out.done += 1;
      log.info('newsletter.erase', { msg: 'Provider copy of an erased subscriber handled on retry', erasure_id: row.id, provider: r.outcome });
    } catch (err) {
      out.failed += 1;
      await repo.setErasureProvider(db, row.id, { outcome: 'failed', checkedAt: now });
      log.warn('newsletter.erase', { msg: 'Provider delete retry failed', erasure_id: row.id, provider: 'failed', err_message: failureReason(err) });
    }
  }
  return out;
}
