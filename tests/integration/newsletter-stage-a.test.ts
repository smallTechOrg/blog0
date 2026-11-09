// Stage A newsletter server items (spec/roadmap.md → Launch polish, items 9, 10, 12; spec/api.md
// POST /api/newsletter + issue stats; newsletter-list.md, newsletter-issues.md success criteria):
// - the signup response's `delivery` (`recorded` with the stub, `sent` over SMTP into the Mailpit
//   sink of the test stack, `failed` when SMTP rejects) — never enumerating an address;
// - the honeypot / fill-time bot drop: same success shape, nothing written, nothing counted;
// - stats refresh dedupe (`stats_fetched` only when a number changed) and `trackingPublic`.
// Real blog0_test Postgres; the SMTP "sent" case needs the test stack (`pnpm listmonk:test-up`,
// Mailpit on 127.0.0.1:1025) and SKIPS visibly without it.
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as getIssueRoute } from '@/app/api/admin/newsletter/issues/[id]/route';
import { POST as sendRoute } from '@/app/api/admin/newsletter/issues/[id]/send/route';
import { POST as statsRoute } from '@/app/api/admin/newsletter/issues/[id]/stats/route';
import { POST as createIssueRoute } from '@/app/api/admin/newsletter/issues/route';
import { GET as settingsGetRoute } from '@/app/api/admin/newsletter/settings/route';
import { POST as newsletterRoute } from '@/app/api/newsletter/route';
import type { IssueDetailResponse, NewsletterSettingsResponse, NewsletterSubscribeResponse } from '@/lib/api/dto';
import type { Envelope } from '@/lib/api/envelope';
import { getDb } from '@/server/db/client';
import {
  newsletterIssueEvent,
  newsletterMessage,
  newsletterSubscriber,
  newsletterSubscriberEvent,
  newsletterSuppression,
  rateLimitBucket,
  type SiteRow,
} from '@/server/db/schema';
import { resetMailTransportForTests, SmtpTransport } from '@/server/newsletter/mail';
import { resetNewsletterRateLimiterForTests } from '@/server/newsletter/rate-limit';
import { resetNewsletterSenderForTests, StubNewsletterSender, type SenderStats } from '@/server/newsletter/sender';
import { DbRateLimitStore, resetRateLimitStoreForTests } from '@/server/rate-window-store';

import { actAs, call, createArticle, data, publish } from '../helpers/api';
import { resetDb } from '../helpers/db';
import { LISTMONK_TEST_STACK_DOWN_REASON, mailpit, probeListmonkTestStack } from '../helpers/listmonk';
import { captureLogs, type CapturedLogs } from '../helpers/logs';
import { loginAs } from '../helpers/session';

const ORIGIN = 'http://localhost:3410';
const ctx = { params: Promise.resolve({}) };
const HUMAN = { fillMs: 5000 };

const stack = await probeListmonkTestStack();
if (stack === null) console.warn(`newsletter-stage-a.test.ts: the Mailpit SMTP case is skipped — ${LISTMONK_TEST_STACK_DOWN_REASON}`);

let currentSite: SiteRow;
let logs: CapturedLogs;

async function signup(body: Record<string, unknown>) {
  const res = await newsletterRoute(
    new Request(`${ORIGIN}/api/newsletter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3410', 'user-agent': 'vitest-stage-a' },
      body: JSON.stringify(body),
    }),
    ctx,
  );
  return { status: res.status, env: (await res.json()) as Envelope<NewsletterSubscribeResponse> };
}

async function rowOf(email: string) {
  const [row] = await getDb()
    .select()
    .from(newsletterSubscriber)
    .where(and(eq(newsletterSubscriber.siteId, currentSite.id), eq(newsletterSubscriber.email, email)));
  return row;
}

async function tableCounts() {
  const db = getDb();
  return {
    subscribers: (await db.select().from(newsletterSubscriber)).length,
    events: (await db.select().from(newsletterSubscriberEvent)).length,
    messages: (await db.select().from(newsletterMessage)).length,
    suppressions: (await db.select().from(newsletterSuppression)).length,
    buckets: (await db.select().from(rateLimitBucket)).length,
  };
}

/** Five addresses in the five states the response must not tell apart. */
async function everyState(prefix: string): Promise<string[]> {
  const db = getDb();
  const now = new Date();
  const confirmed = `${prefix}-confirmed@example.test`;
  const suppressed = `${prefix}-suppressed@example.test`;
  await db.insert(newsletterSubscriber).values([
    { siteId: currentSite.id, email: confirmed, status: 'confirmed', source: 'footer', consentText: 'c', consentVersion: 'v1', consentedAt: now, confirmedAt: now },
    { siteId: currentSite.id, email: suppressed, status: 'unsubscribed', source: 'footer', consentText: 'c', consentVersion: 'v1', consentedAt: now, confirmedAt: now, unsubscribedAt: now },
  ]);
  const capped = `${prefix}-capped@example.test`;
  // three signups use up the 3-per-24 h confirmation cap (and the 3-per-hour email cap: the 4th
  // signup below runs after the email bucket is reset, so it reaches the capped no-send path).
  for (let i = 0; i < 3; i += 1) expect((await signup({ email: capped, ...HUMAN })).status).toBe(200);
  resetNewsletterRateLimiterForTests();
  return [`${prefix}-new@example.test`, `${prefix}-new@example.test` /* pending on the 2nd call */, confirmed, capped, suppressed];
}

beforeEach(async () => {
  currentSite = await resetDb();
  resetMailTransportForTests();
  resetNewsletterSenderForTests();
  resetNewsletterRateLimiterForTests();
  logs = captureLogs();
});

afterEach(() => {
  logs.stop();
  resetRateLimitStoreForTests();
  resetMailTransportForTests();
  resetNewsletterSenderForTests();
});

afterAll(() => {
  resetRateLimitStoreForTests();
});

describe('POST /api/newsletter — delivery', () => {
  it("stub transport → delivery 'recorded' for new, pending, confirmed, capped and suppressed addresses alike", async () => {
    const emails = await everyState('stub');
    const answers = [];
    for (const email of emails) answers.push(await signup({ email, ...HUMAN }));

    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200, 200]);
    expect(answers.map((a) => a.env)).toEqual(Array.from({ length: 5 }, () => ({ ok: true, data: { subscribed: true, delivery: 'recorded' } })));
    // the suppressed address re-entered double opt-in; the confirmed one is untouched
    expect((await rowOf('stub-suppressed@example.test')).status).toBe('pending');
    expect((await rowOf('stub-confirmed@example.test')).status).toBe('confirmed');
  });

  it("an SMTP transport that rejects (unreachable port) → 'failed'; the pending row and a failed confirmation_sent event are kept", async () => {
    resetMailTransportForTests(new SmtpTransport({ host: '127.0.0.1', port: 1, user: null, pass: null, from: 'blog0 <newsletter@example.test>' }, { requireTLS: false }));

    const answer = await signup({ email: 'refused@example.test', ...HUMAN });

    expect(answer.status).toBe(200);
    expect(answer.env).toEqual({ ok: true, data: { subscribed: true, delivery: 'failed' } });
    const row = await rowOf('refused@example.test');
    expect(row.status).toBe('pending');
    const events = await getDb().select().from(newsletterSubscriberEvent).where(eq(newsletterSubscriberEvent.subscriberId, row.id));
    expect(events.map((e) => e.kind)).toEqual(['signup', 'confirmation_sent']);
    expect(events[1].details).toMatchObject({ outcome: 'failed' });
    // a no-send outcome on the same failing transport reports the environment's success value
    await getDb().update(newsletterSubscriber).set({ status: 'confirmed', confirmedAt: new Date() }).where(eq(newsletterSubscriber.id, row.id));
    expect((await signup({ email: 'refused@example.test', ...HUMAN })).env).toEqual({ ok: true, data: { subscribed: true, delivery: 'sent' } });
  });

  it.skipIf(stack === null)(`SMTP into the Mailpit sink → 'sent' for new, pending, confirmed, capped and suppressed alike; the message arrives${stack ? '' : ` — ${LISTMONK_TEST_STACK_DOWN_REASON}`}`, async () => {
    const env = stack!;
    const host = new URL(env.mailpitUrl).hostname;
    resetMailTransportForTests(new SmtpTransport({ host, port: 1025, user: null, pass: null, from: 'blog0 <newsletter@example.test>' }, { requireTLS: false }));
    const run = Date.now().toString(36);

    const emails = await everyState(`smtp-${run}`);
    const answers = [];
    for (const email of emails) answers.push(await signup({ email, ...HUMAN }));

    expect(answers.map((a) => a.env)).toEqual(Array.from({ length: 5 }, () => ({ ok: true, data: { subscribed: true, delivery: 'sent' } })));
    const box = mailpit(env);
    const arrived = await box.waitForMessagesTo(`smtp-${run}-new@example.test`);
    expect(arrived.length).toBeGreaterThanOrEqual(1);
    const [msg] = await getDb().select().from(newsletterMessage).where(eq(newsletterMessage.toEmail, `smtp-${run}-new@example.test`));
    expect(msg).toMatchObject({ transport: 'smtp', status: 'sent', kind: 'confirmation' });
    expect(logs.find('newsletter.mail').some((l) => l.transport === 'smtp' && l.outcome === 'sent')).toBe(true);
    for (const e of emails) {
      const found = await box.messagesTo(e);
      await box.deleteMessages(found.map((m) => m.ID));
    }
  });
});

describe('POST /api/newsletter — bot drop (honeypot + fill time)', () => {
  it('honeypot filled, too fast, or no fillMs → 200 with the environment delivery, nothing written, nothing counted (DB store)', async () => {
    resetRateLimitStoreForTests(new DbRateLimitStore());
    const before = await tableCounts();

    const honeypot = await signup({ email: 'bot1@example.test', website: 'x', ...HUMAN });
    const tooFast = await signup({ email: 'bot2@example.test', fillMs: 1500 });
    const noFill = await signup({ email: 'bot3@example.test', sourceUrl: '/p/humans-are-software' });

    for (const r of [honeypot, tooFast, noFill]) {
      expect(r.status).toBe(200);
      expect(r.env).toEqual({ ok: true, data: { subscribed: true, delivery: 'recorded' } });
    }
    expect(await tableCounts()).toEqual(before);
    const dropped = logs.find('newsletter.signup_dropped');
    expect(dropped.map((l) => [l.reason, l.source_url])).toEqual([
      ['honeypot', '/'],
      ['too_fast', '/'],
      ['too_fast', '/p/humans-are-software'],
    ]);
    expect(dropped.every((l) => typeof l.request_id === 'string')).toBe(true);
    expect(JSON.stringify(logs.lines)).not.toContain('bot1@example.test');
    expect(logs.find('newsletter.signup')).toHaveLength(0);
    expect(logs.find('newsletter.mail')).toHaveLength(0);

    // a human signup still counts in the DB buckets
    expect((await signup({ email: 'human@example.test', ...HUMAN })).status).toBe(200);
    expect((await tableCounts()).buckets).toBeGreaterThan(0);
  });

  it('a dropped submission over SMTP still answers the environment success value (sent) and sends nothing', async () => {
    resetMailTransportForTests(new SmtpTransport({ host: '127.0.0.1', port: 1, user: null, pass: null, from: 'blog0 <newsletter@example.test>' }, { requireTLS: false }));
    const r = await signup({ email: 'bot@example.test', website: 'https://spam.example' });
    expect(r.env).toEqual({ ok: true, data: { subscribed: true, delivery: 'sent' } });
    expect((await tableCounts()).messages).toBe(0);
  });

  it("wrong types → 400 VALIDATION_FAILED before anything else (fillMs: 'x', website: 5)", async () => {
    const a = await signup({ email: 'x@example.test', fillMs: 'x' });
    const b = await signup({ email: 'x@example.test', website: 5, ...HUMAN });
    expect([a.status, b.status]).toEqual([400, 400]);
    expect(!a.env.ok && a.env.error.code).toBe('VALIDATION_FAILED');
    expect(logs.find('newsletter.signup_dropped')).toHaveLength(0);
  });
});

/** A DB-recording stub whose stats numbers the test can change. */
class TunableStatsSender extends StubNewsletterSender {
  opens: number | null = null;
  override async fetchStats(campaignId: string): Promise<SenderStats> {
    const base = await super.fetchStats(campaignId);
    return { ...base, opens: this.opens };
  }
}

describe('issue stats refresh (60 s auto-refresh ready) + trackingPublic', () => {
  it('two refreshes with unchanged numbers → one stats_fetched event, fetchedAt updated both times; a changed number → a second event', async () => {
    const sender = new TunableStatsSender({ recordToDb: true });
    resetNewsletterSenderForTests(sender);
    actAs(await loginAs({ email: 'desk@example.test', displayName: 'Desk Admin' }));
    const now = new Date();
    await getDb()
      .insert(newsletterSubscriber)
      .values({ siteId: currentSite.id, email: 'reader@example.test', status: 'confirmed', source: 'footer', consentText: 'c', consentVersion: 'v1', consentedAt: now, confirmedAt: now });
    const article = await createArticle({ title: 'Stats story', topic: 'Analysis', dek: 'dek', bodyMd: 'One sentence here. Another sentence there.' });
    expect((await publish(article.id, article.currentRevision.id)).status).toBe(200);
    const issue = data((await call<IssueDetailResponse>(createIssueRoute, 'POST', '/api/admin/newsletter/issues', { body: { title: 'Stats', articleIds: [article.id] } })).env).issue;
    expect(data((await call<IssueDetailResponse>(sendRoute, 'POST', `/api/admin/newsletter/issues/${issue.id}/send`, { id: issue.id, body: { confirm: true } })).env).issue.status).toBe('sent');
    const refresh = () => call<IssueDetailResponse>(statsRoute, 'POST', `/api/admin/newsletter/issues/${issue.id}/stats`, { id: issue.id, body: {} });

    const first = data((await refresh()).env).issue;
    await new Promise((r) => setTimeout(r, 5));
    const second = data((await refresh()).env).issue;
    const statsEvents = async () =>
      (await getDb().select().from(newsletterIssueEvent).where(eq(newsletterIssueEvent.issueId, issue.id))).filter((e) => e.kind === 'stats_fetched');

    expect(first.stats).toMatchObject({ recipients: 1, sent: 1, opens: null });
    expect(second.stats?.fetchedAt).not.toBe(first.stats?.fetchedAt);
    expect(Date.parse(second.stats!.fetchedAt)).toBeGreaterThan(Date.parse(first.stats!.fetchedAt));
    expect(await statsEvents()).toHaveLength(1);

    sender.opens = 1;
    const third = data((await refresh()).env).issue;
    expect(third.stats).toMatchObject({ opens: 1 });
    expect(await statsEvents()).toHaveLength(2);
    expect(third.events.filter((e) => e.kind === 'stats_fetched')).toHaveLength(2);
    expect(third.trackingPublic).toBe(true);

    const got = data((await call<IssueDetailResponse>(getIssueRoute, 'GET', `/api/admin/newsletter/issues/${issue.id}`, { id: issue.id })).env).issue;
    expect(got.trackingPublic).toBe(true);
    const settings = data((await call<NewsletterSettingsResponse>(settingsGetRoute, 'GET', '/api/admin/newsletter/settings')).env);
    expect(settings.status.sender).toMatchObject({ kind: 'stub', trackingPublic: true });
  });
});
