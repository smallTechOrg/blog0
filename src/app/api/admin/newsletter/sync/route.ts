import type { NewsletterSyncResponse } from '@/lib/api/dto';
import { withApi } from '@/server/http/api';
import { requireHealthySender } from '@/server/newsletter/issues/send';
import { confirmTrueBody } from '@/server/newsletter/schemas';
import { getNewsletterSender } from '@/server/newsletter/sender';
import { syncAll } from '@/server/newsletter/sender/sync';

// POST /api/admin/newsletter/sync { confirm: true } — the same blog0 → provider sync as
// `pnpm newsletter:sync`. Stub sender: every row skipped, 0 changed. Listmonk down → 503
// SENDER_UNAVAILABLE before anything is attempted.

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export const POST = withApi(
  {
    auth: 'admin',
    body: confirmTrueBody,
    summarizeOutput: (d) => {
      const r = d as NewsletterSyncResponse;
      return { synced: r.synced, blocklisted: r.blocklisted, skipped: r.skipped, suppressedFromProvider: r.suppressedFromProvider, changed: r.changed, errors: r.errors.length };
    },
  },
  async ({ auth }): Promise<NewsletterSyncResponse> => {
    const sender = getNewsletterSender();
    await requireHealthySender(sender);
    return syncAll('admin', { sender, siteId: auth.user.siteId, source: 'admin' });
  },
);
