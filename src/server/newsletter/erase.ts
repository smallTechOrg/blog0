import 'server-only';

import { sql } from 'drizzle-orm';

import type { SubscriberEraseResponse } from '@/lib/api/dto';

import { getDb, rowsOf } from '../db/client';
import { ApiError } from '../http/api';
import { log } from '../log';

import * as repo from './repo';
import { getNewsletterSender } from './sender';
import { erasureHash } from './tokens';

// Erasure (fix pass; capability newsletter-list.md "Erasure", spec/data.md `0004_newsletter_erasure`,
// spec/architecture.md §13.1 erase.ts). The redaction itself is the SQL function
// `newsletter_erase_subscriber(id)` (SECURITY DEFINER; it is the only thing allowed past the ledger
// guard); this module checks the typed address, removes the provider copy and logs the outcome
// WITHOUT any personal data. Also the pure helpers the mail layer and signup use.

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

/** True for the tombstone address an erased subscriber row carries (`erased+<hash>@erased.invalid`). */
export function isErasedEmail(email: string): boolean {
  return TOMBSTONE_RE.test(email);
}

export interface EraseActor {
  userId: string;
  requestId?: string;
}

/**
 * Admin → Erase personal data. `confirmEmail` must equal the subscriber's address (case-insensitive,
 * trimmed) → else 400 VALIDATION_FAILED and nothing changes. The provider copy is removed first
 * (best-effort: a failure → `providerRemoved: false`, logged at `warn`, never fails the erase —
 * the address is read before it is redacted), then the redaction runs in one transaction.
 * Already erased → 409 SUBSCRIBER_NOT_ELIGIBLE; unknown id → 404.
 */
export async function eraseSubscriber(siteId: string, id: string, input: { confirmEmail: string }, actor: EraseActor): Promise<SubscriberEraseResponse> {
  const db = getDb();
  const row = await repo.findById(db, siteId, id);
  if (!row) throw new ApiError('NOT_FOUND', 404, 'That subscriber isn’t here.');
  if (isErasedEmail(row.email)) throw new ApiError('SUBSCRIBER_NOT_ELIGIBLE', 409, 'This subscriber’s data was already erased.');
  if (input.confirmEmail.trim().toLowerCase() !== row.email.trim().toLowerCase()) {
    throw new ApiError('VALIDATION_FAILED', 400, 'Type the subscriber’s address exactly to confirm the erasure.', { formErrors: [], fieldErrors: { confirmEmail: ['Does not match this address.'] } });
  }

  let provider: 'removed' | 'skipped' | 'failed';
  let providerError: string | undefined;
  const sender = getNewsletterSender();
  try {
    await sender.removeSubscriber(row.email);
    provider = sender.kind === 'stub' ? 'skipped' : 'removed';
  } catch (err) {
    provider = 'failed';
    providerError = (err instanceof Error ? err.message : String(err)).replaceAll(row.email, '[email]').slice(0, 200);
  }

  const erased = await db.transaction(async (tx) => {
    const result = await tx.execute(sql`select newsletter_erase_subscriber(${id}::uuid) as erased`);
    return rowsOf<{ erased: boolean }>(result)[0]?.erased === true;
  });

  const fields = { subscriber_id: id, outcome: erased ? 'erased' : 'already', provider, user_id: actor.userId, request_id: actor.requestId };
  if (provider === 'failed') log.warn('newsletter.erase', { msg: 'Erased; the provider copy could not be removed', ...fields, err_message: providerError });
  else log.info('newsletter.erase', { msg: erased ? 'Subscriber erased' : 'Subscriber was already erased', ...fields });

  if (!erased) throw new ApiError('SUBSCRIBER_NOT_ELIGIBLE', 409, 'This subscriber’s data was already erased.');
  return { erased: true, providerRemoved: provider === 'removed' };
}
