import 'server-only';

import { getConfig } from '@/server/config';

import { ListmonkSender } from './listmonk';
import { StubNewsletterSender } from './stub';
import type { NewsletterSender } from './types';

// `getNewsletterSender()` (spec/architecture.md §13.3): one process-wide sender chosen by
// `getConfig().newsletter.sender`; `resetNewsletterSenderForTests(s?)` drops it (or injects one).

export * from './types';
export { ListmonkSender, toListmonkExpressions, BLOG0_TEMPLATE_NAME, BLOG0_TEMPLATE_BODY } from './listmonk';
export { StubNewsletterSender, type StubCampaign, type StubSenderOptions } from './stub';

let current: NewsletterSender | null = null;

export function getNewsletterSender(): NewsletterSender {
  if (current !== null) return current;
  const { sender, listmonk } = getConfig().newsletter;
  if (sender === 'listmonk') {
    if (listmonk === null) throw new Error('BLOG0_NEWSLETTER_SENDER=listmonk without BLOG0_LISTMONK_* (config should have refused this)');
    current = new ListmonkSender(listmonk);
  } else {
    current = new StubNewsletterSender({ recordToDb: true });
  }
  return current;
}

/** Tests: forget the current sender (the stub's memory with it) or inject a specific one. */
export function resetNewsletterSenderForTests(sender?: NewsletterSender): void {
  if (current instanceof StubNewsletterSender) current.reset();
  current = sender ?? null;
}
