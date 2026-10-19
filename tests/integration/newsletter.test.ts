// Capability newsletter-list: the double opt-in signup path — POST /api/newsletter (consent proof,
// hashed token, events, the stub confirmation message), the confirm link's service, re-signups,
// caps and the signup throttle — against the real test Postgres. No LLM, no SMTP (stub transport).
import { and, count, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POST as newsletterRoute } from '@/app/api/newsletter/route';
import type { NewsletterSubscribeResponse } from '@/lib/api/dto';
import type { Envelope } from '@/lib/api/envelope';
import { resetConfigForTests } from '@/server/config';
import { closeDb, getDb } from '@/server/db/client';
import { newsletterMessage, newsletterSubscriber, newsletterSubscriberEvent, site, type SiteRow } from '@/server/db/schema';
import { CONFIRM_TOKEN_TTL_MS, CONFIRMATION_SENDS_PER_DAY } from '@/server/newsletter/constants';
import { getMailTransport, MailError, resetMailTransportForTests, type MailMessage, type MailTransport } from '@/server/newsletter/mail';
import {
  isKnownClientIp,
  NEWSLETTER_MAX_PER_EMAIL,
  NEWSLETTER_MAX_PER_WINDOW,
  NEWSLETTER_WINDOW_MS,
  NewsletterThrottle,
  resetNewsletterRateLimiterForTests,
} from '@/server/newsletter/rate-limit';
import { confirmByToken, subscribe } from '@/server/newsletter/service';
import { hashConfirmToken } from '@/server/newsletter/tokens';
import { MemoryRateLimitStore } from '@/server/rate-window';
import { resetCurrentSiteForTests } from '@/server/site/current';
import { siteSeedFor } from '@/server/site/defaults';

import { resetDb } from '../helpers/db';
import { captureLogs } from '../helpers/logs';

const ORIGIN = 'http://localhost:3410';
const ctx = { params: Promise.resolve({}) };
const UA = 'Mozilla/5.0 (vitest)';

let currentSite: SiteRow;
const savedHops = process.env.BLOG0_TRUSTED_PROXY_HOPS;

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/newsletter`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3410', 'user-agent': UA, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  const res = await newsletterRoute(postRequest(body, headers), ctx);
  return { res, env: (await res.json()) as Envelope<NewsletterSubscribeResponse> };
}

async function rows() {
  return getDb().select().from(newsletterSubscriber).where(eq(newsletterSubscriber.siteId, currentSite.id));
}

async function eventsOf(email: string) {
  return getDb()
    .select()
    .from(newsletterSubscriberEvent)
    .where(and(eq(newsletterSubscriberEvent.siteId, currentSite.id), eq(newsletterSubscriberEvent.email, email)))
    .orderBy(newsletterSubscriberEvent.createdAt, newsletterSubscriberEvent.id);
}

async function messagesTo(email: string) {
  return getDb().select().from(newsletterMessage).where(and(eq(newsletterMessage.siteId, currentSite.id), eq(newsletterMessage.toEmail, email)));
}

/** The confirm token the stub "delivered": from the confirm_url in the newsletter.mail log line. */
function tokenFromLog(logs: ReturnType<typeof captureLogs>, nth = -1): string {
  const lines = logs.find('newsletter.mail').filter((l) => typeof l.confirm_url === 'string');
  const line = lines.at(nth);
  if (!line) throw new Error('no newsletter.mail line with a confirm_url');
  return new URL(line.confirm_url as string).searchParams.get('t') as string;
}

function setHops(value: string | undefined) {
  if (value === undefined) delete process.env.BLOG0_TRUSTED_PROXY_HOPS;
  else process.env.BLOG0_TRUSTED_PROXY_HOPS = value;
  resetConfigForTests();
}

let logs: ReturnType<typeof captureLogs>;

beforeEach(async () => {
  currentSite = await resetDb();
  resetNewsletterRateLimiterForTests();
  resetMailTransportForTests();
  setHops(savedHops);
  logs = captureLogs();
});

afterEach(() => {
  logs.stop();
  resetMailTransportForTests();
  setHops(savedHops);
});

describe('POST /api/newsletter — double opt-in signup (happy path)', () => {
  it('creates a pending row with the proof of consent, a hashed token, signup + confirmation_sent events and one stub message', async () => {
    const { res, env } = await post({ email: ' A@B.com ', name: ' Asha Reader ', sourceUrl: '/p/humans-are-software' });

    expect(res.status).toBe(200);
    expect(env).toEqual({ ok: true, data: { subscribed: true } });
    const stored = await rows();
    expect(stored).toHaveLength(1);
    const row = stored[0];
    expect(row).toMatchObject({
      siteId: currentSite.id,
      email: 'a@b.com',
      name: 'Asha Reader',
      status: 'pending',
      source: 'footer',
      signupSourceUrl: '/p/humans-are-software',
      signupUserAgent: UA,
      signupIp: null, // hops=0 → no real address known
      consentText: currentSite.newsletterConsentText,
      consentVersion: currentSite.newsletterConsentVersion,
      confirmationSentCount: 1,
      confirmedAt: null,
    });
    expect(row.consentedAt).not.toBeNull();
    expect(row.confirmTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.confirmTokenExpiresAt!.getTime() - row.consentedAt!.getTime()).toBe(CONFIRM_TOKEN_TTL_MS);

    const events = await eventsOf('a@b.com');
    expect(events.map((e) => e.kind)).toEqual(['signup', 'confirmation_sent']);
    expect(events[0]).toMatchObject({ source: 'footer', userAgent: UA, ip: null, details: { sourceUrl: '/p/humans-are-software', consentVersion: 'v1' } });
    expect(events[1].details).toEqual({ outcome: 'stubbed', transport: 'stub' });

    const messages = await messagesTo('a@b.com');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: 'confirmation', transport: 'stub', status: 'stubbed', subscriberId: row.id });
    expect(messages[0].html).toContain('/newsletter/confirm?t=');
    expect(messages[0].text).toContain('/newsletter/confirm?t=');
    expect(messages[0].html).toContain(currentSite.newsletterConsentText);

    // the real token is in the sent mail (the stub's log line), only its hash in the row; the stored copy is redacted (fix pass)
    const token = tokenFromLog(logs);
    expect(messages[0].html).toContain('/newsletter/confirm?t=[redacted]');
    expect(messages[0].html).not.toContain(token);
    expect(messages[0].text).not.toContain(token);
    expect(hashConfirmToken(token)).toBe(row.confirmTokenHash);
    expect(token).not.toBe(row.confirmTokenHash);
    const mail = logs.find('newsletter.mail')[0];
    expect(mail).toMatchObject({ transport: 'stub', outcome: 'stubbed', kind: 'confirmation', to_masked: 'a***@b.com' });
    expect(JSON.stringify(logs.find('newsletter.signup'))).not.toContain('a@b.com');
    expect(logs.find('newsletter.signup')[0]).toMatchObject({ outcome: 'pending_created', source_url: '/p/humans-are-software', consent_version: 'v1' });
  });

  it('records the real client IP only with a trusted proxy', async () => {
    setHops('1');
    await post({ email: 'ip@example.com' }, { 'x-forwarded-for': '203.0.113.7' });
    const [row] = await rows();
    expect(row.signupIp).toBe('203.0.113.7');
    expect((await eventsOf('ip@example.com'))[0].ip).toBe('203.0.113.7');
  });

  it('opening the confirm link confirms the row (confirmed_at, IP/UA, token cleared) and appends `confirmed`; a second click is "already used"', async () => {
    await post({ email: 'c@example.com' });
    const token = tokenFromLog(logs);

    const result = await confirmByToken(token, { ip: '198.51.100.9', userAgent: 'Mail Client/1.0' });

    expect(result.alreadyConfirmed).toBe(false);
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'confirmed', confirmedIp: '198.51.100.9', confirmedUserAgent: 'Mail Client/1.0', confirmTokenHash: null, confirmTokenExpiresAt: null });
    expect(row.confirmedAt).not.toBeNull();
    const kinds = (await eventsOf('c@example.com')).map((e) => e.kind);
    expect(kinds).toEqual(['signup', 'confirmation_sent', 'confirmed']);

    await expect(confirmByToken(token, { ip: 'direct', userAgent: null })).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', status: 410 });
    expect((await eventsOf('c@example.com')).map((e) => e.kind)).toEqual(kinds);
    // the link GET (usedAsAlready) treats the spent token of a still-confirmed subscriber as success, writing nothing
    const again = await confirmByToken(token, { ip: 'direct', userAgent: null }, undefined, { via: 'link_open', usedAsAlready: true });
    expect(again).toMatchObject({ alreadyConfirmed: true, subscriber: { id: row.id, status: 'confirmed' } });
    expect((await eventsOf('c@example.com')).map((e) => e.kind)).toEqual(kinds);
    expect((await eventsOf('c@example.com')).at(-1)!.details).not.toHaveProperty('via'); // the POST path records no via
  });

  it('a signup for a confirmed address answers the same success, writes no event and sends nothing', async () => {
    await post({ email: 'done@example.com' });
    await confirmByToken(tokenFromLog(logs), { ip: 'direct', userAgent: null });
    const before = (await eventsOf('done@example.com')).length;

    const { res, env } = await post({ email: 'DONE@example.com', name: 'Later' });

    expect(res.status).toBe(200);
    expect(env).toEqual({ ok: true, data: { subscribed: true } });
    expect((await eventsOf('done@example.com')).length).toBe(before);
    expect(await messagesTo('done@example.com')).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ status: 'confirmed', name: null });
    expect(logs.find('newsletter.signup').at(-1)).toMatchObject({ outcome: 'noop_confirmed' });
  });
});

describe('POST /api/newsletter — expiry, renewal and the 3-per-24 h cap', () => {
  it('73 h later the unused link is expired; a new signup issues a different hash and a second confirmation_sent; the 4th send in 24 h is refused silently', async () => {
    const t0 = new Date('2026-10-13T06:00:00Z');
    resetNewsletterRateLimiterForTests({ perEmail: 100 });
    const first = await subscribe({ ip: 'direct', userAgent: UA, now: t0 }, { email: 'late@example.com', name: null, sourceUrl: '/' });
    const token1 = tokenFromLog(logs);
    const hash1 = first.subscriber.confirmTokenHash;

    const later = new Date(t0.getTime() + 73 * 3_600_000);
    await expect(confirmByToken(token1, { ip: 'direct', userAgent: null, now: later })).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', status: 410 });
    expect((await rows())[0].status).toBe('pending');

    const second = await subscribe({ ip: 'direct', userAgent: UA, now: later }, { email: 'late@example.com', name: null, sourceUrl: '/archive' });
    expect(second.outcome).toBe('pending_renewed');
    expect(second.subscriber.confirmTokenHash).not.toBe(hash1);
    expect(second.subscriber.signupSourceUrl).toBe('/archive');
    let events = await eventsOf('late@example.com');
    expect(events.filter((e) => e.kind === 'confirmation_sent')).toHaveLength(2);
    expect(events.filter((e) => e.kind === 'signup')).toHaveLength(2);

    // Three sends inside one 24 h window (the renewal plus two more) reach the cap: the next signup
    // in that window succeeds silently, sends nothing and keeps the token already in the inbox.
    const third = await subscribe({ ip: 'direct', userAgent: UA, now: new Date(later.getTime() + 60_000) }, { email: 'late@example.com', name: null, sourceUrl: '/' });
    expect(third.outcome).toBe('pending_renewed');
    const fourth = await subscribe({ ip: 'direct', userAgent: UA, now: new Date(later.getTime() + 120_000) }, { email: 'late@example.com', name: null, sourceUrl: '/' });
    expect(fourth.outcome).toBe('pending_renewed');
    const fifth = await subscribe({ ip: 'direct', userAgent: UA, now: new Date(later.getTime() + 180_000) }, { email: 'late@example.com', name: null, sourceUrl: '/' });
    expect(fifth.outcome).toBe('noop_capped');
    expect(fifth.mail).toBeUndefined();
    events = await eventsOf('late@example.com');
    const inWindow = events.filter((e) => e.kind === 'confirmation_sent' && e.createdAt.getTime() >= later.getTime());
    expect(inWindow).toHaveLength(CONFIRMATION_SENDS_PER_DAY);
    expect(events.filter((e) => e.kind === 'confirmation_sent')).toHaveLength(CONFIRMATION_SENDS_PER_DAY + 1); // + the one from 73 h earlier
    expect(events.filter((e) => e.kind === 'signup')).toHaveLength(5);
    expect(events.at(-1)!.details).toMatchObject({ capped: true });
    expect(await messagesTo('late@example.com')).toHaveLength(CONFIRMATION_SENDS_PER_DAY + 1);
    expect(fifth.subscriber.confirmTokenHash).toBe(fourth.subscriber.confirmTokenHash);
    const token4 = tokenFromLog(logs);
    const confirmed = await confirmByToken(token4, { ip: 'direct', userAgent: null, now: new Date(later.getTime() + 240_000) });
    expect(confirmed.subscriber.status).toBe('confirmed');
    expect(logs.find('newsletter.signup').at(-1)).toMatchObject({ outcome: 'noop_capped' });
  });

  it('a failed confirmation send still creates the pending row (outcome failed, logged at warn)', async () => {
    const failing: MailTransport = {
      kind: 'smtp',
      send: async () => {
        throw new MailError('smtp', 'relay refused');
      },
    };
    resetMailTransportForTests(failing);

    const { res } = await post({ email: 'unlucky@example.com' });

    expect(res.status).toBe(200);
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'pending', confirmationSentCount: 0 });
    expect(row.confirmTokenHash).not.toBeNull();
    const events = await eventsOf('unlucky@example.com');
    expect(events.map((e) => e.kind)).toEqual(['signup', 'confirmation_sent']);
    expect(events[1].details).toMatchObject({ outcome: 'failed', transport: 'smtp', error: 'relay refused' });
    // a failed send does not count against the 3-per-24 h cap: the next signup sends again
    resetMailTransportForTests();
    const again = await post({ email: 'unlucky@example.com' });
    expect(again.res.status).toBe(200);
    expect(await messagesTo('unlucky@example.com')).toHaveLength(1);
  });

  it('getMailTransport picks the stub without BLOG0_SMTP_HOST', () => {
    expect(getMailTransport().kind).toBe('stub');
    const msg: MailMessage = { to: 'x@example.com', subject: 's', html: '<p>h</p>', text: 't', kind: 'test_issue' };
    expect(msg.kind).toBe('test_issue');
  });
});

describe('POST /api/newsletter — validation and guards', () => {
  it.each([
    ['an invalid address', { email: 'not-an-email' }],
    ['a missing email', { name: 'Only a name' }],
    ['an empty email', { email: '   ' }],
    ['an over-long email', { email: `${'a'.repeat(250)}@b.com` }],
    ['an over-long name', { email: 'ok@example.com', name: 'n'.repeat(121) }],
    ['a non-string email', { email: 42 }],
    ['an absolute sourceUrl', { email: 'ok@example.com', sourceUrl: 'https://evil.example/' }],
    ['a protocol-relative sourceUrl', { email: 'ok@example.com', sourceUrl: '//evil.example' }],
    ['an over-long sourceUrl', { email: 'ok@example.com', sourceUrl: '/' + 'x'.repeat(500) }],
  ])('rejects %s with 400 VALIDATION_FAILED and stores nothing', async (_label, body) => {
    const { res, env } = await post(body);

    expect(res.status).toBe(400);
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION_FAILED');
    expect(await rows()).toHaveLength(0);
    expect(logs.find('newsletter.mail')).toHaveLength(0);
  });

  it('rejects a malformed JSON body with 400', async () => {
    const { res } = await post('{"email":');
    expect(res.status).toBe(400);
  });

  it('accepts the 120-character name boundary and defaults sourceUrl to /', async () => {
    const { res } = await post({ email: 'edge@example.com', name: 'n'.repeat(120) });
    expect(res.status).toBe(200);
    const [row] = await rows();
    expect(row.name).toHaveLength(120);
    expect(row.signupSourceUrl).toBe('/');
  });

  it('rejects a cross-origin POST and a POST without Origin with 403 FORBIDDEN_ORIGIN', async () => {
    const cross = await post({ email: 'x@example.com' }, { origin: 'https://evil.example' });
    expect(cross.res.status).toBe(403);
    if (!cross.env.ok) expect(cross.env.error.code).toBe('FORBIDDEN_ORIGIN');

    const req = new Request(`${ORIGIN}/api/newsletter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost:3410' },
      body: JSON.stringify({ email: 'x@example.com' }),
    });
    expect((await newsletterRoute(req, ctx)).status).toBe(403);
    expect(await rows()).toHaveLength(0);
  });

  it('confirmByToken: a malformed or unknown token is 404 TOKEN_INVALID and changes nothing', async () => {
    await post({ email: 'k@example.com' });
    await expect(confirmByToken('not-a-token', { ip: 'direct', userAgent: null })).rejects.toMatchObject({ code: 'TOKEN_INVALID', status: 404 });
    await expect(confirmByToken('B'.repeat(43), { ip: 'direct', userAgent: null })).rejects.toMatchObject({ code: 'TOKEN_INVALID', status: 404 });
    expect((await rows())[0].status).toBe('pending');
  });
});

describe('POST /api/newsletter — rate limit (unchanged caps)', () => {
  function expect429(res: Response, env: Envelope<NewsletterSubscribeResponse>) {
    expect(res.status).toBe(429);
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('RATE_LIMITED');
    const retry = Number(res.headers.get('retry-after'));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(3600);
  }

  it('with BLOG0_TRUSTED_PROXY_HOPS=0 the IP is unknown: no shared per-IP bucket, the 11th distinct signup succeeds', async () => {
    setHops('0');
    for (let i = 0; i < NEWSLETTER_MAX_PER_WINDOW + 2; i += 1) {
      const { res } = await post({ email: `visitor${i}@example.com` }, { 'x-forwarded-for': '203.0.113.7' });
      expect(res.status).toBe(200);
    }
    expect(await rows()).toHaveLength(NEWSLETTER_MAX_PER_WINDOW + 2);
  });

  it('caps one address at 3 signups per hour regardless of client (4th → 429), counting normalised emails', async () => {
    setHops('0');
    for (const email of ['same@example.com', ' SAME@example.com ', 'Same@Example.com']) {
      expect((await post({ email })).res.status).toBe(200);
    }
    expect(NEWSLETTER_MAX_PER_EMAIL).toBe(3);

    const { res, env } = await post({ email: 'same@example.com', name: 'Fourth' });

    expect429(res, env);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBeNull();
    expect((await post({ email: 'different@example.com' })).res.status).toBe(200);
  });

  it('with hops=1 and X-Forwarded-For, the 11th signup from one IP within the hour → 429 + Retry-After', async () => {
    setHops('1');
    for (let i = 0; i < NEWSLETTER_MAX_PER_WINDOW; i += 1) {
      const { res } = await post({ email: `r${i}@example.com` }, { 'x-forwarded-for': '203.0.113.7' });
      expect(res.status).toBe(200);
    }
    const { res, env } = await post({ email: 'eleventh@example.com' }, { 'x-forwarded-for': '203.0.113.7' });
    expect429(res, env);
    expect(await rows()).toHaveLength(NEWSLETTER_MAX_PER_WINDOW);
    const other = await post({ email: 'eleventh@example.com' }, { 'x-forwarded-for': '198.51.100.2' });
    expect(other.res.status).toBe(200);
  });

  it('applies the site-wide cap across clients and addresses (cap injected small for the test)', async () => {
    resetNewsletterRateLimiterForTests({ siteWide: 5 });
    setHops('1');
    for (let i = 0; i < 5; i += 1) {
      const { res } = await post({ email: `s${i}@example.com` }, { 'x-forwarded-for': `198.51.100.${i + 1}` });
      expect(res.status).toBe(200);
    }
    const { res, env } = await post({ email: 'late@example.com' }, { 'x-forwarded-for': '198.51.100.99' });
    expect429(res, env);
    expect(await rows()).toHaveLength(5);
  });

  it('requests rejected before validation do not consume any budget', async () => {
    resetNewsletterRateLimiterForTests({ siteWide: 2 });
    setHops('0');
    for (let i = 0; i < 5; i += 1) {
      expect((await post({ email: 'not-an-email' })).res.status).toBe(400);
      expect((await post({ email: 'v@example.com' }, { origin: 'https://evil.example' })).res.status).toBe(403);
    }
    expect((await post({ email: 'v@example.com' })).res.status).toBe(200);
    expect((await post({ email: 'w@example.com' })).res.status).toBe(200);
    expect((await post({ email: 'x@example.com' })).res.status).toBe(429);
  });

  it('throttle: windows reset, unknown IPs skip the per-IP bucket, a refusal counts in no bucket', async () => {
    const throttle = new NewsletterThrottle({ perIp: 2, perEmail: 2, siteWide: 100 }, new MemoryRateLimitStore());
    const t0 = 5_000_000;
    for (const ip of ['direct', 'unknown']) {
      for (let i = 0; i < 5; i += 1) expect((await throttle.attempt({ ip, email: `${ip}${i}@x.io`, siteId: 's' }, t0)).limited).toBe(false);
    }
    expect(isKnownClientIp('direct')).toBe(false);
    expect(isKnownClientIp('203.0.113.7')).toBe(true);
    expect((await throttle.attempt({ ip: '1.1.1.1', email: 'a@x.io', siteId: 's' }, t0)).limited).toBe(false);
    expect((await throttle.attempt({ ip: '1.1.1.1', email: 'b@x.io', siteId: 's' }, t0)).limited).toBe(false);
    expect(await throttle.attempt({ ip: '1.1.1.1', email: 'c@x.io', siteId: 's' }, t0 + 1000)).toEqual({ limited: true, retryAfterSec: NEWSLETTER_WINDOW_MS / 1000 - 1, bucket: 'ip' });
    expect((await throttle.attempt({ ip: '2.2.2.2', email: 'c@x.io', siteId: 's' }, t0)).limited).toBe(false);
    expect((await throttle.attempt({ ip: '3.3.3.3', email: 'c@x.io', siteId: 's' }, t0)).limited).toBe(false);
    expect(await throttle.attempt({ ip: '4.4.4.4', email: 'c@x.io', siteId: 's' }, t0)).toMatchObject({ limited: true, bucket: 'email' });
    expect((await throttle.attempt({ ip: '1.1.1.1', email: 'c@x.io', siteId: 's' }, t0 + NEWSLETTER_WINDOW_MS)).limited).toBe(false);
  });
});

describe('tenancy and state survival', () => {
  it('a confirm token of another site does not confirm here; rows are site-scoped', async () => {
    const [other] = await getDb().insert(site).values(siteSeedFor('other-site')).returning();
    await post({ email: 'mine@example.com' });
    const token = tokenFromLog(logs);
    const [row] = await rows();
    await getDb().update(newsletterSubscriber).set({ siteId: other.id }).where(eq(newsletterSubscriber.id, row.id));
    await getDb().update(newsletterSubscriberEvent).set({ siteId: other.id }).where(eq(newsletterSubscriberEvent.subscriberId, row.id)).catch(() => {});

    await expect(confirmByToken(token, { ip: 'direct', userAgent: null })).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    expect(await rows()).toHaveLength(0);
  });

  it('a pending subscriber and its token survive a fresh DB pool and site cache (process restart)', async () => {
    await post({ email: 'durable@example.com', name: 'Durable' });
    const token = tokenFromLog(logs);
    await closeDb();
    resetCurrentSiteForTests();
    resetNewsletterRateLimiterForTests();
    resetMailTransportForTests();

    const [row] = await getDb()
      .select({ n: count() })
      .from(newsletterSubscriber)
      .where(and(eq(newsletterSubscriber.siteId, currentSite.id), eq(newsletterSubscriber.email, 'durable@example.com')));
    expect(Number(row.n)).toBe(1);
    const confirmed = await confirmByToken(token, { ip: 'direct', userAgent: null });
    expect(confirmed.subscriber).toMatchObject({ email: 'durable@example.com', name: 'Durable', status: 'confirmed' });
  });
});
