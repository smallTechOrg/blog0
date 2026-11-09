import 'server-only';

import type { NewsletterSubscriberRow } from '../db/schema';
import { log } from '../log';

// The list service's only link to the sending provider (spec/architecture.md §13.1 sender-hook.ts),
// wired to `sender/sync.ts` (slice S7.3). Imported lazily: sync.ts itself uses the list service
// (markProviderSynced), so a static import would make a cycle. Both hooks swallow and log — a
// provider outage never fails a reader's click (service.ts runHook logs too; this is the backstop).

/** After a subscriber became `confirmed` (committed): upsert it at the provider. */
export async function afterConfirm(subscriber: NewsletterSubscriberRow): Promise<void> {
  try {
    const { syncOne } = await import('./sender/sync');
    await syncOne(subscriber, { trigger: 'confirm' });
  } catch (err) {
    log.warn('newsletter.sync', { msg: 'Live sync after confirm failed; run pnpm newsletter:sync', trigger: 'confirm', subscriber_id: subscriber.id, errors: 1, err_message: err instanceof Error ? err.message : String(err) });
  }
}

/** After a subscriber became `unsubscribed` / `bounced` (committed): blocklist it at the provider. */
export async function afterSuppress(subscriber: NewsletterSubscriberRow): Promise<void> {
  try {
    const { removeOne } = await import('./sender/sync');
    await removeOne(subscriber, { trigger: 'unsubscribe' });
  } catch (err) {
    log.warn('newsletter.sync', { msg: 'Live blocklist after suppression failed; run pnpm newsletter:sync', trigger: 'unsubscribe', subscriber_id: subscriber.id, errors: 1, err_message: err instanceof Error ? err.message : String(err) });
  }
}
