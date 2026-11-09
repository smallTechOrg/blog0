import 'server-only';

import { setTimeout as sleep } from 'node:timers/promises';

import { getDb } from '../db/client';
import type { NewsletterSubscriberRow } from '../db/schema';
import { ApiError } from '../http/api';
import { log, maskEmail } from '../log';
import { getCurrentSite } from '../site/current';

import { CONFIRM_TOKEN_TTL_MS, LEGACY_BATCH_PAUSE_MS, LEGACY_BATCH_SIZE } from './constants';
import { sendConfirmationMail } from './mail';
import * as repo from './repo';
import { newConfirmToken } from './tokens';

// Legacy subscribers (capability newsletter-list.md): Phase 2 rows became `legacy_unconfirmed` in
// migration 0002. They get ONE confirmation email, only on an admin click; the row keeps its status
// (so the list still shows it as legacy) until the click flips it to `confirmed`. The mail goes out
// first; the row is marked spent only when the transport accepted it (spec/api.md: MAIL_FAILED
// changes nothing).

export interface LegacySendResult {
  subscriber: NewsletterSubscriberRow;
  sentTo: string;
  transport: 'smtp' | 'stub';
}

function notEligible(): ApiError {
  return new ApiError('SUBSCRIBER_NOT_ELIGIBLE', 409, 'Only a legacy or pending subscriber can be sent a confirmation.');
}

function alreadySent(at: Date): ApiError {
  return new ApiError('CONFIRMATION_ALREADY_SENT', 409, 'This legacy subscriber already got its one confirmation email.', { sentAt: at.toISOString() });
}

/**
 * The one-time rule holds under concurrency (two admin clicks, a click racing "send all"): the row is
 * locked FOR UPDATE, `legacy_confirmation_sent_at` re-checked and CLAIMED in one transaction; only the
 * claimant sends. The lock is not held across the SMTP call (the mail row's FK would wait on it). A
 * mail failure releases the claim — the row is put back exactly as it was (MAIL_FAILED changes nothing).
 */
export async function sendLegacyConfirmation(siteId: string, row: NewsletterSubscriberRow, actor: { userId: string | null }, now = new Date()): Promise<LegacySendResult> {
  if (row.status !== 'legacy_unconfirmed') throw notEligible();
  if (row.legacyConfirmationSentAt !== null) throw alreadySent(row.legacyConfirmationSentAt);
  const site = await getCurrentSite();
  const { token, hash } = newConfirmToken();
  const db = getDb();

  const claimed = await db.transaction(async (tx) => {
    const locked = await repo.findById(tx, siteId, row.id, true);
    if (!locked || locked.status !== 'legacy_unconfirmed') throw notEligible();
    if (locked.legacyConfirmationSentAt !== null) throw alreadySent(locked.legacyConfirmationSentAt);
    const updated = await repo.updateSubscriber(tx, locked.id, {
      confirmTokenHash: hash,
      confirmTokenExpiresAt: new Date(now.getTime() + CONFIRM_TOKEN_TTL_MS),
      legacyConfirmationSentAt: now,
      confirmationSentCount: locked.confirmationSentCount + 1,
      updatedAt: now,
    });
    return { before: locked, updated };
  });

  let sent;
  try {
    sent = await sendConfirmationMail(claimed.updated, token, site);
  } catch (err) {
    const b = claimed.before;
    await repo.updateSubscriber(db, b.id, {
      confirmTokenHash: b.confirmTokenHash,
      confirmTokenExpiresAt: b.confirmTokenExpiresAt,
      legacyConfirmationSentAt: null,
      confirmationSentCount: b.confirmationSentCount,
      updatedAt: b.updatedAt,
    });
    throw new ApiError('MAIL_FAILED', 502, err instanceof Error ? err.message : 'The mail server rejected the message.');
  }
  await repo.appendEvent(db, {
    siteId,
    subscriberId: row.id,
    email: row.email,
    kind: 'legacy_confirmation_sent',
    source: 'admin',
    actorUserId: actor.userId,
    ip: null,
    userAgent: null,
    details: { outcome: sent.outcome, transport: sent.transport },
    createdAt: now,
  });
  return { subscriber: claimed.updated, sentTo: row.email, transport: sent.transport };
}

/** One email per `legacy_unconfirmed` row not yet mailed, in batches of 20 with a 200 ms pause; a mail failure skips that row. */
export async function sendAllLegacyConfirmations(siteId: string, actor: { userId: string | null }): Promise<{ sent: number; skipped: number }> {
  const rows = (await repo.listRows(getDb(), siteId, { status: 'legacy_unconfirmed' })).filter((r) => r.legacyConfirmationSentAt === null);
  let sent = 0;
  let skipped = 0;
  for (let i = 0; i < rows.length; i += LEGACY_BATCH_SIZE) {
    if (i > 0) await sleep(LEGACY_BATCH_PAUSE_MS);
    for (const row of rows.slice(i, i + LEGACY_BATCH_SIZE)) {
      try {
        await sendLegacyConfirmation(siteId, row, actor);
        sent += 1;
      } catch (err) {
        skipped += 1;
        log.warn('newsletter.mail', {
          msg: 'Legacy confirmation skipped',
          kind: 'confirmation',
          to_masked: maskEmail(row.email),
          outcome: 'failed',
          err_code: err instanceof ApiError ? err.code : 'MAIL_FAILED',
        });
      }
    }
  }
  return { sent, skipped };
}
