import 'server-only';

import type { NewsletterSubscriberRow } from '../db/schema';
import { log } from '../log';

// The list service's only link to the sending provider (spec/architecture.md §13.1 sender-hook.ts).
// Slice S7.1 ships both hooks as no-ops that log at `debug`; slice S7.3 wires them to
// `sender/sync.ts` (`syncOne` / `removeOne`). Both must swallow and log — a provider outage never
// fails a reader's click.

/** After a subscriber became `confirmed` (committed). */
export async function afterConfirm(subscriber: NewsletterSubscriberRow): Promise<void> {
  log.debug('newsletter.sync', { msg: 'afterConfirm: no sender wired yet (slice S7.3)', trigger: 'confirm', subscriber_id: subscriber.id, skipped: 1 });
}

/** After a subscriber became `unsubscribed` / `bounced` (committed). */
export async function afterSuppress(subscriber: NewsletterSubscriberRow): Promise<void> {
  log.debug('newsletter.sync', { msg: 'afterSuppress: no sender wired yet (slice S7.3)', trigger: 'unsubscribe', subscriber_id: subscriber.id, skipped: 1 });
}
