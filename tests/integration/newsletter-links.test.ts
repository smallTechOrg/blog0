// Capability newsletter-list: the reader-facing links — confirm / unsubscribe pages (server
// components rendered to HTML in the site chrome), the JSON routes (incl. RFC 8058 one-click),
// suppression + re-signup rules, the append-only ledger trigger, and the link rate caps — against the
// real test Postgres with the stub mail transport.
import { renderToStaticMarkup } from 'react-dom/server';
import { sql as dsql, and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as confirmRoute } from '@/app/api/newsletter/confirm/route';
import { POST as newsletterRoute } from '@/app/api/newsletter/route';
import { POST as unsubscribeRoute } from '@/app/api/newsletter/unsubscribe/route';
import type { NewsletterConfirmResponse, NewsletterUnsubscribeResponse } from '@/lib/api/dto';
import type { Envelope } from '@/lib/api/envelope';
import { resetConfigForTests } from '@/server/config';
import { getDb } from '@/server/db/client';
import { newsletterIssue, newsletterIssueEvent, newsletterSubscriber, newsletterSubscriberEvent, newsletterSuppression, type SiteRow } from '@/server/db/schema';
import { LINK_CAP_PER_IP } from '@/server/newsletter/constants';
import { unsubscribeToken, unsubscribeUrl } from '@/server/newsletter/links';
import { resetMailTransportForTests } from '@/server/newsletter/mail';
import { resetNewsletterLinkRateLimiterForTests, resetNewsletterRateLimiterForTests } from '@/server/newsletter/rate-limit';
import { confirmByToken } from '@/server/newsletter/service';

import { resetDb } from '../helpers/db';
import { captureLogs } from '../helpers/logs';

const ORIGIN = 'http://localhost:3410';
const ctx = { params: Promise.resolve({}) };

// The pages read `headers()` from next/headers; outside a request we hand them the test's headers.
const requestHeaders = { current: new Headers({ 'user-agent': 'vitest-page' }) };
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFound();
  },
}));
class NotFound extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
    this.name = 'NotFound';
  }
}

let currentSite: SiteRow;
let logs: ReturnType<typeof captureLogs>;
const savedHops = process.env.BLOG0_TRUSTED_PROXY_HOPS;

function setHops(value: string | undefined) {
  if (value === undefined) delete process.env.BLOG0_TRUSTED_PROXY_HOPS;
  else process.env.BLOG0_TRUSTED_PROXY_HOPS = value;
  resetConfigForTests();
}

async function signup(email: string): Promise<string> {
  const before = logs.find('newsletter.mail').length;
  const res = await newsletterRoute(
    new Request(`${ORIGIN}/api/newsletter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3410' },
      body: JSON.stringify({ email, sourceUrl: '/' }),
    }),
    ctx,
  );
  expect(res.status).toBe(200);
  const line = logs.find('newsletter.mail')[before];
  return new URL(line.confirm_url as string).searchParams.get('t') as string;
}

async function row(email: string) {
  const [r] = await getDb().select().from(newsletterSubscriber).where(and(eq(newsletterSubscriber.siteId, currentSite.id), eq(newsletterSubscriber.email, email)));
  return r;
}

async function events(email: string) {
  return getDb().select().from(newsletterSubscriberEvent).where(eq(newsletterSubscriberEvent.email, email)).orderBy(newsletterSubscriberEvent.createdAt, newsletterSubscriberEvent.id);
}

async function suppressions(email: string) {
  return getDb().select().from(newsletterSuppression).where(eq(newsletterSuppression.email, email)).orderBy(newsletterSuppression.createdAt);
}

/** Drizzle wraps driver errors (DrizzleQueryError → cause); the trigger's text is on the cause. */
async function expectLedgerRefusal(promise: Promise<unknown>): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected the ledger guard to raise').not.toBeNull();
  const e = caught as Error & { cause?: Error };
  expect(`${e.message} ${e.cause?.message ?? ''}`).toMatch(/append-only/);
}

/** Renders a link page the way Next would, returning its HTML or 'NOT_FOUND'. */
async function renderPage(which: 'confirm' | 'unsubscribe', token: string | undefined, headers: Record<string, string> = {}): Promise<string> {
  requestHeaders.current = new Headers({ 'user-agent': 'vitest-page', ...headers });
  const mod = which === 'confirm' ? await import('@/app/(site)/newsletter/confirm/page') : await import('@/app/(site)/newsletter/unsubscribe/page');
  try {
    const element = await mod.default({ searchParams: Promise.resolve(token === undefined ? {} : { t: token }) });
    return renderToStaticMarkup(element);
  } catch (err) {
    if (err instanceof NotFound) return 'NOT_FOUND';
    throw err;
  }
}

async function postJson<T>(handler: typeof confirmRoute, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await handler(
    new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost:3410', ...headers }, body: JSON.stringify(body) }),
    ctx,
  );
  return { res, env: (await res.json()) as Envelope<T> };
}

beforeEach(async () => {
  currentSite = await resetDb();
  resetNewsletterRateLimiterForTests({ perEmail: 100 });
  resetNewsletterLinkRateLimiterForTests();
  resetMailTransportForTests();
  setHops(savedHops);
  logs = captureLogs();
});

afterEach(() => {
  logs.stop();
  setHops(savedHops);
});

describe('GET /newsletter/confirm (page)', () => {
  it('confirms and shows "You’re subscribed"; a second visit shows the expired/used copy; garbage is a 404', async () => {
    const token = await signup('page@example.com');

    const html = await renderPage('confirm', token);

    expect(html).toContain('You’re subscribed.');
    expect(html).toContain('blog0 issues will land in this inbox');
    expect(html).toContain('Back to blog0');
    expect(html).toContain('class="tag">Newsletter');
    const r = await row('page@example.com');
    expect(r.status).toBe('confirmed');
    expect(r.confirmedUserAgent).toBe('vitest-page');
    expect(logs.find('newsletter.link').at(-1)).toMatchObject({ kind: 'confirm', outcome: 'ok', subscriber_id: r.id });

    expect(await renderPage('confirm', token)).toContain('This link has expired or was already used.');
    expect(logs.find('newsletter.link').at(-1)).toMatchObject({ kind: 'confirm', outcome: 'expired' });
    expect(await renderPage('confirm', 'not-a-token')).toBe('NOT_FOUND');
    expect(await renderPage('confirm', undefined)).toBe('NOT_FOUND');
    expect(await renderPage('confirm', 'B'.repeat(43))).toBe('NOT_FOUND');
    expect(logs.find('newsletter.link').at(-1)).toMatchObject({ kind: 'confirm', outcome: 'invalid' });
  });

  it('POST /api/newsletter/confirm answers the exact codes: 200 → 410 → 404, needs no Origin, noindex', async () => {
    const token = await signup('json@example.com');

    const ok = await postJson<NewsletterConfirmResponse>(confirmRoute, '/api/newsletter/confirm', { token });
    expect(ok.res.status).toBe(200);
    expect(ok.env).toEqual({ ok: true, data: { confirmed: true, alreadyConfirmed: false } });
    expect(ok.res.headers.get('cache-control')).toBe('no-store');

    const again = await postJson<NewsletterConfirmResponse>(confirmRoute, '/api/newsletter/confirm', { token });
    expect(again.res.status).toBe(410);
    if (!again.env.ok) expect(again.env.error.code).toBe('TOKEN_EXPIRED');
    expect(again.res.headers.get('x-robots-tag')).toBe('noindex');

    const bad = await postJson<NewsletterConfirmResponse>(confirmRoute, '/api/newsletter/confirm', { token: 'x'.repeat(43) });
    expect(bad.res.status).toBe(404);
    if (!bad.env.ok) expect(bad.env.error.code).toBe('TOKEN_INVALID');
    const malformed = await postJson<NewsletterConfirmResponse>(confirmRoute, '/api/newsletter/confirm', { token: 'short' });
    expect(malformed.res.status).toBe(404);
    const empty = await postJson<NewsletterConfirmResponse>(confirmRoute, '/api/newsletter/confirm', {});
    expect(empty.res.status).toBe(400);
  });
});

describe('unsubscribe link, one-click and suppression', () => {
  it('the link unsubscribes once (page copy, status, one suppression, events); one-click POST with the same token is 200 and adds nothing; tampered → 404', async () => {
    const token = await signup('bye@example.com');
    await confirmByToken(token, { ip: 'direct', userAgent: null });
    const r = await row('bye@example.com');
    const link = unsubscribeUrl(r.id);
    expect(link).toMatch(/^http:\/\/localhost:3410\/newsletter\/unsubscribe\?t=/);
    const t = new URL(link).searchParams.get('t') as string;

    const html = await renderPage('unsubscribe', t);

    expect(html).toContain('You’re unsubscribed. Sorry to see you go.');
    expect(await row('bye@example.com')).toMatchObject({ status: 'unsubscribed' });
    expect((await row('bye@example.com')).unsubscribedAt).not.toBeNull();
    const sup = await suppressions('bye@example.com');
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({ reason: 'unsubscribed', source: 'email_link', subscriberId: r.id });
    expect((await events('bye@example.com')).map((e) => e.kind)).toEqual(['signup', 'confirmation_sent', 'confirmed', 'unsubscribed']);

    // RFC 8058 one-click: form-encoded body, token in the query, no Origin
    const oneClick = await unsubscribeRoute(
      new Request(`${ORIGIN}/api/newsletter/unsubscribe?t=${encodeURIComponent(t)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', host: 'localhost:3410' },
        body: 'List-Unsubscribe=One-Click',
      }),
      ctx,
    );
    expect(oneClick.status).toBe(200);
    expect((await oneClick.json()) as Envelope<NewsletterUnsubscribeResponse>).toEqual({ ok: true, data: { unsubscribed: true, alreadyUnsubscribed: true } });
    expect(await suppressions('bye@example.com')).toHaveLength(1);
    expect(await renderPage('unsubscribe', t)).toContain('You’re unsubscribed. Sorry to see you go.');
    expect(await suppressions('bye@example.com')).toHaveLength(1);

    const tampered = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
    const bad = await postJson<NewsletterUnsubscribeResponse>(unsubscribeRoute, '/api/newsletter/unsubscribe', { token: tampered });
    expect(bad.res.status).toBe(404);
    if (!bad.env.ok) expect(bad.env.error.code).toBe('TOKEN_INVALID');
    expect(await renderPage('unsubscribe', tampered)).toBe('NOT_FOUND');
    expect(await renderPage('unsubscribe', 'garbage')).toBe('NOT_FOUND');
    expect(await suppressions('bye@example.com')).toHaveLength(1);
    expect(logs.find('newsletter.link').filter((l) => l.outcome === 'invalid').length).toBeGreaterThanOrEqual(2);
  });

  it('one-click on a confirmed subscriber (JSON { token } and form) writes a one_click-sourced suppression', async () => {
    const token = await signup('click@example.com');
    await confirmByToken(token, { ip: 'direct', userAgent: null });
    const t = unsubscribeToken((await row('click@example.com')).id);

    const res = await unsubscribeRoute(
      new Request(`${ORIGIN}/api/newsletter/unsubscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', host: 'localhost:3410' },
        body: `List-Unsubscribe=One-Click&t=${encodeURIComponent(t)}`,
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect((await suppressions('click@example.com'))[0]).toMatchObject({ source: 'one_click', reason: 'unsubscribed' });
    expect((await events('click@example.com')).at(-1)).toMatchObject({ kind: 'unsubscribed', source: 'one_click' });

    // JSON form on a pending (never confirmed) subscriber also works — the link in the confirmation email
    const token2 = await signup('pending-bye@example.com');
    expect(token2).toBeTruthy();
    const json = await postJson<NewsletterUnsubscribeResponse>(unsubscribeRoute, '/api/newsletter/unsubscribe', { token: unsubscribeToken((await row('pending-bye@example.com')).id) });
    expect(json.env).toEqual({ ok: true, data: { unsubscribed: true, alreadyUnsubscribed: false } });
    expect((await suppressions('pending-bye@example.com'))[0]).toMatchObject({ source: 'email_link' });
    expect((await row('pending-bye@example.com')).confirmTokenHash).toBeNull();
  });

  it('a suppressed address re-signs up via a fresh double opt-in: pending + resignup, confirming appends resubscribed, suppressions accumulate', async () => {
    const token = await signup('back@example.com');
    await confirmByToken(token, { ip: 'direct', userAgent: null });
    const first = await row('back@example.com');
    await postJson(unsubscribeRoute, '/api/newsletter/unsubscribe', { token: unsubscribeToken(first.id) });
    expect(await suppressions('back@example.com')).toHaveLength(1);

    const token2 = await signup('back@example.com');
    const re = await row('back@example.com');
    expect(re.status).toBe('pending');
    expect(re.confirmTokenHash).not.toBeNull();
    expect(re.consentedAt!.getTime()).toBeGreaterThan(first.consentedAt!.getTime());
    expect(re.id).toBe(first.id); // history kept on the same row
    const signupEvents = (await events('back@example.com')).filter((e) => e.kind === 'signup');
    expect(signupEvents).toHaveLength(2);
    expect(signupEvents[1].details).toMatchObject({ resignup: true, previousStatus: 'unsubscribed' });
    expect(await suppressions('back@example.com')).toHaveLength(1);

    const confirmed = await confirmByToken(token2, { ip: 'direct', userAgent: null });
    expect(confirmed.subscriber.status).toBe('confirmed');
    expect((await events('back@example.com')).map((e) => e.kind)).toEqual(['signup', 'confirmation_sent', 'confirmed', 'unsubscribed', 'signup', 'confirmation_sent', 'resubscribed']);
    expect(await suppressions('back@example.com')).toHaveLength(1);

    await postJson(unsubscribeRoute, '/api/newsletter/unsubscribe', { token: unsubscribeToken(first.id) });
    expect(await suppressions('back@example.com')).toHaveLength(2);
    expect((await row('back@example.com')).status).toBe('unsubscribed');
  });

  it('the ledger is append-only: UPDATE / DELETE on suppressions and events raise; subscribers cannot be deleted; a draft issue cascades its events', async () => {
    const token = await signup('ledger@example.com');
    await confirmByToken(token, { ip: 'direct', userAgent: null });
    const r = await row('ledger@example.com');
    await postJson(unsubscribeRoute, '/api/newsletter/unsubscribe', { token: unsubscribeToken(r.id) });
    const db = getDb();

    await expectLedgerRefusal(db.execute(dsql`delete from newsletter_suppression where subscriber_id = ${r.id}::uuid`));
    await expectLedgerRefusal(db.execute(dsql`update newsletter_suppression set reason = 'admin' where subscriber_id = ${r.id}::uuid`));
    await expectLedgerRefusal(db.execute(dsql`delete from newsletter_subscriber_event where subscriber_id = ${r.id}::uuid`));
    await expectLedgerRefusal(db.execute(dsql`update newsletter_subscriber_event set kind = 'confirmed' where subscriber_id = ${r.id}::uuid`));
    // even a sneaky ip-only update outside the prune function is refused
    await expectLedgerRefusal(db.execute(dsql`update newsletter_subscriber_event set ip = null where subscriber_id = ${r.id}::uuid`));
    await expect(db.delete(newsletterSubscriber).where(eq(newsletterSubscriber.id, r.id))).rejects.toThrow();
    expect(await suppressions('ledger@example.com')).toHaveLength(1);

    const [issue] = await db
      .insert(newsletterIssue)
      .values({ siteId: currentSite.id, number: 1, origin: 'manual', title: 'Draft', posts: [], articleIds: [] })
      .returning();
    await db.insert(newsletterIssueEvent).values({ siteId: currentSite.id, issueId: issue.id, kind: 'created' });
    await expectLedgerRefusal(db.delete(newsletterIssueEvent).where(eq(newsletterIssueEvent.issueId, issue.id)));
    await db.delete(newsletterIssue).where(eq(newsletterIssue.id, issue.id)); // cascade passes the guard
    expect(await db.select().from(newsletterIssueEvent).where(eq(newsletterIssueEvent.issueId, issue.id))).toHaveLength(0);
  });
});

describe('link rate caps (spec/architecture.md §6)', () => {
  it('31 well-formed confirm requests from one known IP within an hour → the 31st is 429 with Retry-After; invalid tokens are not counted', async () => {
    setHops('1');
    const ip = { 'x-forwarded-for': '203.0.113.50' };
    for (let i = 0; i < 5; i += 1) {
      const malformed = await postJson(confirmRoute, '/api/newsletter/confirm', { token: 'nope' }, ip);
      expect(malformed.res.status).toBe(404);
    }
    const tokens: string[] = [];
    for (let i = 0; i < LINK_CAP_PER_IP; i += 1) tokens.push(await signup(`cap${i}@example.com`));
    for (let i = 0; i < LINK_CAP_PER_IP; i += 1) {
      const res = await postJson(confirmRoute, '/api/newsletter/confirm', { token: tokens[i] }, ip);
      expect(res.res.status, `request ${i + 1}`).toBe(200);
    }
    const extra = await signup('cap-extra@example.com');
    const blocked = await postJson(confirmRoute, '/api/newsletter/confirm', { token: extra }, ip);
    expect(blocked.res.status).toBe(429);
    if (!blocked.env.ok) expect(blocked.env.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await row('cap-extra@example.com')).status).toBe('pending');
    expect(logs.find('newsletter.link').at(-1)).toMatchObject({ kind: 'confirm', outcome: 'rate_limited' });

    // another IP is unaffected; the confirm and unsubscribe links share the pair of buckets
    const fine = await postJson(confirmRoute, '/api/newsletter/confirm', { token: extra }, { 'x-forwarded-for': '203.0.113.51' });
    expect(fine.res.status).toBe(200);
    const unsub = await postJson(unsubscribeRoute, '/api/newsletter/unsubscribe', { token: unsubscribeToken((await row('cap0@example.com')).id) }, ip);
    expect(unsub.res.status).toBe(429);
    expect(await renderPage('unsubscribe', unsubscribeToken((await row('cap0@example.com')).id), ip)).toContain('Too many requests.');
  });

  it('with hops=0 only the site-wide cap applies (injected small): the page shows the 429 copy with the minutes', async () => {
    setHops('0');
    resetNewsletterLinkRateLimiterForTests({ siteWide: 2 });
    const a = await signup('site1@example.com');
    const b = await signup('site2@example.com');
    const c = await signup('site3@example.com');
    expect(await renderPage('confirm', a)).toContain('You’re subscribed.');
    expect(await renderPage('confirm', b)).toContain('You’re subscribed.');
    const html = await renderPage('confirm', c);
    expect(html).toContain('Too many requests.');
    expect(html).toMatch(/Try the link again in \d+ minutes?\./);
    expect((await row('site3@example.com')).status).toBe('pending');
  });
});
