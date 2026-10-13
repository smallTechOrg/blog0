// POST /api/newsletter/webhook (spec/api.md; spec/architecture.md §13.3 "Webhook"; capability
// newsletter-issues.md success criteria): bearer secret compared in constant time, 404 when no
// secret is configured, 401 WEBHOOK_UNAUTHORIZED before the body is read, a known address becomes a
// suppression (source `webhook`) + event + provider blocklist, unknown → `{ accepted: false }` with
// no rows, idempotent for an already-suppressed address — against the real test Postgres.
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POST as webhookRoute } from '@/app/api/newsletter/webhook/route';
import type { NewsletterWebhookResponse } from '@/lib/api/dto';
import type { Envelope } from '@/lib/api/envelope';
import { resetConfigForTests } from '@/server/config';
import { getDb } from '@/server/db/client';
import { newsletterSubscriber, newsletterSubscriberEvent, newsletterSuppression, type SiteRow } from '@/server/db/schema';
import { resetNewsletterSenderForTests, StubNewsletterSender, type NewsletterSender } from '@/server/newsletter/sender';

import { ORIGIN } from '../helpers/api';
import { resetDb } from '../helpers/db';
import { captureLogs } from '../helpers/logs';

const SECRET = 'whsec-test-0123456789abcdefghijklmnop';
const ORIGINAL_SECRET = process.env.BLOG0_NEWSLETTER_WEBHOOK_SECRET;
let currentSite: SiteRow;

/** A listmonk-kind sender that records blocklist calls (the stub kind skips live syncs by design). */
class RecordingSender implements NewsletterSender {
  readonly kind = 'listmonk' as const;
  readonly inner = new StubNewsletterSender();
  removed: string[] = [];
  healthcheck() {
    return this.inner.healthcheck();
  }
  syncSubscriber(...a: Parameters<NewsletterSender['syncSubscriber']>) {
    return this.inner.syncSubscriber(...a);
  }
  async removeSubscriber(email: string) {
    this.removed.push(email);
    return { changed: true };
  }
  createIssue(...a: Parameters<NewsletterSender['createIssue']>) {
    return this.inner.createIssue(...a);
  }
  sendIssue(id: string) {
    return this.inner.sendIssue(id);
  }
  fetchStats(id: string) {
    return this.inner.fetchStats(id);
  }
  fetchSuppressions(since: Date) {
    return this.inner.fetchSuppressions(since);
  }
}

async function hook(body: unknown, auth: string | null = `Bearer ${SECRET}`, raw?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json', host: 'localhost:3410' };
  if (auth !== null) headers.authorization = auth;
  const res = await webhookRoute(new Request(`${ORIGIN}/api/newsletter/webhook`, { method: 'POST', headers, body: raw ?? JSON.stringify(body) }), { params: Promise.resolve({}) });
  return { status: res.status, env: (await res.json()) as Envelope<NewsletterWebhookResponse> };
}

async function addConfirmed(email: string) {
  const [row] = await getDb()
    .insert(newsletterSubscriber)
    .values({ siteId: currentSite.id, email, status: 'confirmed', consentedAt: new Date(), confirmedAt: new Date(), consentVersion: 'v1' })
    .returning();
  return row;
}

const suppressions = () => getDb().select().from(newsletterSuppression);
const eventsOf = (id: string) => getDb().select().from(newsletterSubscriberEvent).where(eq(newsletterSubscriberEvent.subscriberId, id));

beforeEach(async () => {
  process.env.BLOG0_NEWSLETTER_WEBHOOK_SECRET = SECRET;
  resetConfigForTests();
  currentSite = await resetDb();
  resetNewsletterSenderForTests();
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.BLOG0_NEWSLETTER_WEBHOOK_SECRET;
  else process.env.BLOG0_NEWSLETTER_WEBHOOK_SECRET = ORIGINAL_SECRET;
  resetConfigForTests();
});

afterAll(() => resetNewsletterSenderForTests());

describe('POST /api/newsletter/webhook', () => {
  it('bounce with the right secret → subscriber bounced, suppression (source webhook), event, provider blocklist; repeat is idempotent', async () => {
    const sub = await addConfirmed('bouncy@example.test');
    const sender = new RecordingSender();
    resetNewsletterSenderForTests(sender);
    const logs = captureLogs();

    const first = await hook({ event: 'bounce', email: 'Bouncy@Example.test', reason: 'mailbox full', providerRef: 'lm-77', occurredAt: '2026-10-12T10:00:00Z' });
    const [row] = await getDb().select().from(newsletterSubscriber).where(eq(newsletterSubscriber.id, sub.id));
    const supp = await suppressions();
    const events = await eventsOf(sub.id);

    expect(first.status).toBe(200);
    expect(first.env).toMatchObject({ ok: true, data: { accepted: true } });
    expect(row.status).toBe('bounced');
    expect(supp).toHaveLength(1);
    expect(supp[0]).toMatchObject({ subscriberId: sub.id, reason: 'bounced', source: 'webhook', details: { event: 'bounce', reason: 'mailbox full', providerRef: 'lm-77', occurredAt: '2026-10-12T10:00:00Z' } });
    expect(events.map((e) => e.kind)).toEqual(['bounced', 'provider_removed']);
    expect(sender.removed).toEqual(['bouncy@example.test']);
    expect(JSON.stringify(logs.find('newsletter.sync'))).not.toContain('bouncy@example.test');
    logs.stop();

    const again = await hook({ event: 'bounce', email: 'bouncy@example.test' });
    expect(again.env).toMatchObject({ ok: true, data: { accepted: true } });
    expect(await suppressions()).toHaveLength(1);
    expect(await eventsOf(sub.id)).toHaveLength(2);
  });

  it('unsubscribe → unsubscribed / reason unsubscribed; complaint → unsubscribed / reason complaint', async () => {
    const a = await addConfirmed('a@example.test');
    const b = await addConfirmed('b@example.test');
    await hook({ event: 'unsubscribe', email: 'a@example.test' });
    await hook({ event: 'complaint', email: 'b@example.test' });
    const rows = await getDb().select().from(newsletterSubscriber);
    const supp = await suppressions();
    expect(rows.find((r) => r.id === a.id)?.status).toBe('unsubscribed');
    expect(rows.find((r) => r.id === b.id)?.status).toBe('unsubscribed');
    expect(supp.map((s) => [s.email, s.reason]).sort()).toEqual([
      ['a@example.test', 'unsubscribed'],
      ['b@example.test', 'complaint'],
    ]);
  });

  it('an unknown address → 200 { accepted: false } and no rows', async () => {
    const res = await hook({ event: 'bounce', email: 'stranger@example.test', reason: 'x' });
    expect(res.status).toBe(200);
    expect(res.env).toMatchObject({ ok: true, data: { accepted: false } });
    expect(await suppressions()).toHaveLength(0);
    expect(await getDb().select().from(newsletterSubscriberEvent)).toHaveLength(0);
  });

  it('wrong or missing secret → 401 WEBHOOK_UNAUTHORIZED, checked before the body; nothing written', async () => {
    const sub = await addConfirmed('safe@example.test');
    const wrong = await hook({ event: 'bounce', email: 'safe@example.test' }, 'Bearer not-the-secret');
    const missing = await hook({ event: 'bounce', email: 'safe@example.test' }, null);
    const basic = await hook({ event: 'bounce', email: 'safe@example.test' }, `Basic ${SECRET}`);
    const wrongAndGarbage = await hook(undefined, 'Bearer nope', '{not json');

    for (const r of [wrong, missing, basic, wrongAndGarbage]) {
      expect(r.status).toBe(401);
      expect(r.env).toMatchObject({ ok: false, error: { code: 'WEBHOOK_UNAUTHORIZED' } });
    }
    const [row] = await getDb().select().from(newsletterSubscriber).where(eq(newsletterSubscriber.id, sub.id));
    expect(row.status).toBe('confirmed');
    expect(await suppressions()).toHaveLength(0);
  });

  it('a malformed body with the right secret → 400 VALIDATION_FAILED', async () => {
    expect((await hook({ event: 'spam', email: 'a@example.test' })).status).toBe(400);
    expect((await hook({ event: 'bounce', email: 'not-an-email' })).status).toBe(400);
    expect((await hook(undefined, `Bearer ${SECRET}`, '{oops')).status).toBe(400);
  });

  it('no secret configured → 404 (the endpoint does not exist)', async () => {
    delete process.env.BLOG0_NEWSLETTER_WEBHOOK_SECRET;
    resetConfigForTests();
    await addConfirmed('x@example.test');
    const res = await hook({ event: 'bounce', email: 'x@example.test' });
    expect(res.status).toBe(404);
    expect(await suppressions()).toHaveLength(0);
  });
});
