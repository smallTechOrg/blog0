// Capability newsletter-signup (S2.3): POST /api/newsletter + GET /api/admin/subscribers against the
// real blog0_test Postgres. No LLM is involved in this capability.
import { and, count, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as subscribersRoute } from '@/app/api/admin/subscribers/route';
import { POST as newsletterRoute } from '@/app/api/newsletter/route';
import type { Envelope } from '@/lib/api/envelope';
import { resetConfigForTests } from '@/server/config';
import { closeDb, getDb } from '@/server/db/client';
import { newsletterSubscriber, site, type SiteRow } from '@/server/db/schema';
import {
  NEWSLETTER_MAX_PER_WINDOW,
  NEWSLETTER_WINDOW_MS,
  NewsletterRateLimiter,
  resetNewsletterRateLimiterForTests,
} from '@/server/newsletter/rate-limit';
import { subscribersToCsv } from '@/server/newsletter/service';
import type { NewsletterSubscribeResponse, SubscriberListResponse } from '@/server/newsletter/types';
import { siteSeedFor } from '@/server/site/defaults';
import { resetCurrentSiteForTests } from '@/server/site/current';

import { resetDb } from '../helpers/db';
import { loginAs, type TestLogin } from '../helpers/session';

const ORIGIN = 'http://localhost:3410';
const ctx = { params: Promise.resolve({}) };

let currentSite: SiteRow;
let admin: TestLogin;
const savedHops = process.env.BLOG0_TRUSTED_PROXY_HOPS;

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/newsletter`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3410', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  const res = await newsletterRoute(postRequest(body, headers), ctx);
  return { res, env: (await res.json()) as Envelope<NewsletterSubscribeResponse> };
}

async function listAs(cookie: string | null, query = '') {
  const headers: Record<string, string> = cookie ? { cookie } : {};
  return subscribersRoute(new Request(`${ORIGIN}/api/admin/subscribers${query}`, { headers }), ctx);
}

async function rows() {
  return getDb().select().from(newsletterSubscriber).where(eq(newsletterSubscriber.siteId, currentSite.id));
}

function setHops(value: string | undefined) {
  if (value === undefined) delete process.env.BLOG0_TRUSTED_PROXY_HOPS;
  else process.env.BLOG0_TRUSTED_PROXY_HOPS = value;
  resetConfigForTests();
}

beforeEach(async () => {
  currentSite = await resetDb();
  resetNewsletterRateLimiterForTests();
  setHops(savedHops);
  admin = await loginAs({ displayName: 'Desk Admin' });
});

afterEach(() => {
  setHops(savedHops);
});

describe('POST /api/newsletter — happy path', () => {
  it('stores the trimmed, lower-cased email with the name, site-scoped, and answers { subscribed: true }', async () => {
    const { res, env } = await post({ email: '  A@B.com ', name: '  Asha Reader ' });

    expect(res.status).toBe(200);
    expect(env).toEqual({ ok: true, data: { subscribed: true } });
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      siteId: currentSite.id,
      email: 'a@b.com',
      name: 'Asha Reader',
      status: 'subscribed',
      source: 'footer',
    });
  });

  it('re-subscribing returns the same success, keeps one row, updates a given name and keeps it when omitted', async () => {
    const first = await post({ email: 'a@b.com', name: 'First' });
    const again = await post({ email: ' A@B.COM ' });
    expect(again.res.status).toBe(200);
    expect(again.env).toEqual(first.env);
    let stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('First');

    await post({ email: 'a@b.com', name: 'Second' });
    stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('Second');
  });

  it('re-activates an unsubscribed address on a new signup', async () => {
    await post({ email: 'gone@example.com' });
    await getDb().update(newsletterSubscriber).set({ status: 'unsubscribed' }).where(eq(newsletterSubscriber.email, 'gone@example.com'));

    const { res } = await post({ email: 'gone@example.com' });

    expect(res.status).toBe(200);
    const [row] = await rows();
    expect(row.status).toBe('subscribed');
  });

  it('treats an empty name as no name', async () => {
    await post({ email: 'noname@example.com', name: '   ' });
    const [row] = await rows();
    expect(row.name).toBeNull();
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
  ])('rejects %s with 400 VALIDATION_FAILED and stores nothing', async (_label, body) => {
    const { res, env } = await post(body);

    expect(res.status).toBe(400);
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION_FAILED');
    expect(await rows()).toHaveLength(0);
  });

  it('rejects a malformed JSON body with 400', async () => {
    const { res } = await post('{"email":');
    expect(res.status).toBe(400);
  });

  it('accepts the 120-character name boundary', async () => {
    const { res } = await post({ email: 'edge@example.com', name: 'n'.repeat(120) });
    expect(res.status).toBe(200);
    expect((await rows())[0].name).toHaveLength(120);
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
});

describe('POST /api/newsletter — rate limit', () => {
  it('answers the 11th submission from one client within the hour with 429 RATE_LIMITED + Retry-After', async () => {
    setHops('1');
    for (let i = 0; i < NEWSLETTER_MAX_PER_WINDOW; i += 1) {
      const { res } = await post({ email: `r${i}@example.com` }, { 'x-forwarded-for': '203.0.113.7' });
      expect(res.status).toBe(200);
    }

    const { res, env } = await post({ email: 'eleventh@example.com' }, { 'x-forwarded-for': '203.0.113.7' });

    expect(res.status).toBe(429);
    if (!env.ok) expect(env.error.code).toBe('RATE_LIMITED');
    const retry = Number(res.headers.get('retry-after'));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(3600);
    expect(await rows()).toHaveLength(NEWSLETTER_MAX_PER_WINDOW);

    // another client is unaffected
    const other = await post({ email: 'other@example.com' }, { 'x-forwarded-for': '198.51.100.2' });
    expect(other.res.status).toBe(200);
  });

  it('counts per window: the window resets after an hour', () => {
    const limiter = new NewsletterRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < NEWSLETTER_MAX_PER_WINDOW; i += 1) expect(limiter.attempt('ip', t0 + i).limited).toBe(false);
    const blocked = limiter.attempt('ip', t0 + 60_000);
    expect(blocked).toEqual({ limited: true, retryAfterSec: (NEWSLETTER_WINDOW_MS - 60_000) / 1000 });
    expect(limiter.attempt('ip', t0 + NEWSLETTER_WINDOW_MS).limited).toBe(false);
  });
});

describe('GET /api/admin/subscribers', () => {
  it('refuses a signed-out request (JSON and CSV) with 401 UNAUTHENTICATED', async () => {
    const json = await listAs(null);
    expect(json.status).toBe(401);
    const csv = await listAs(null, '?format=csv');
    expect(csv.status).toBe(401);
    const env = (await csv.json()) as Envelope<unknown>;
    if (!env.ok) expect(env.error.code).toBe('UNAUTHENTICATED');
  });

  it('lists only the current site, newest first, with the total', async () => {
    await post({ email: 'first@example.com', name: 'First' });
    await new Promise((r) => setTimeout(r, 5));
    await post({ email: 'second@example.com' });
    const [other] = await getDb().insert(site).values(siteSeedFor('other-site')).returning();
    await getDb().insert(newsletterSubscriber).values({ siteId: other.id, email: 'elsewhere@example.com' });

    const res = await listAs(admin.cookie);

    expect(res.status).toBe(200);
    const env = (await res.json()) as Envelope<SubscriberListResponse>;
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.total).toBe(2);
    expect(env.data.subscribers.map((s) => s.email)).toEqual(['second@example.com', 'first@example.com']);
    expect(env.data.subscribers[1]).toMatchObject({ name: 'First', status: 'subscribed' });
    expect(Number.isNaN(Date.parse(env.data.subscribers[0].createdAt))).toBe(false);
  });

  it('returns an empty list when nobody subscribed', async () => {
    const env = (await (await listAs(admin.cookie)).json()) as Envelope<SubscriberListResponse>;
    expect(env).toEqual({ ok: true, data: { subscribers: [], total: 0 } });
  });

  it('exports CSV with a header row and the address, escaping commas, quotes and formulas', async () => {
    await post({ email: 'csv@example.com', name: 'Rao, "Sai"' });
    await post({ email: 'formula@example.com', name: '=HYPERLINK("x")' });

    const res = await listAs(admin.cookie, '?format=csv');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="[A-Za-z0-9_-]+-subscribers-\d{4}-\d{2}-\d{2}\.csv"$/);
    const text = await res.text();
    const lines = text.trimEnd().split('\r\n');
    expect(lines[0]).toBe('email,name,subscribed_at,status');
    expect(lines).toHaveLength(3);
    expect(text).toContain('csv@example.com,"Rao, ""Sai""",');
    expect(text).toContain(`formula@example.com,"'=HYPERLINK(""x"")",`);
  });

  it('subscribersToCsv emits only the header for an empty list', () => {
    expect(subscribersToCsv([])).toBe('email,name,subscribed_at,status\r\n');
  });
});

describe('state survival', () => {
  it('a stored subscriber survives a fresh DB pool and site cache (process restart)', async () => {
    await post({ email: 'durable@example.com', name: 'Durable' });
    await closeDb();
    resetCurrentSiteForTests();
    resetNewsletterRateLimiterForTests();

    const [row] = await getDb()
      .select({ n: count() })
      .from(newsletterSubscriber)
      .where(and(eq(newsletterSubscriber.siteId, currentSite.id), eq(newsletterSubscriber.email, 'durable@example.com')));
    expect(Number(row.n)).toBe(1);
    const env = (await (await listAs(admin.cookie)).json()) as Envelope<SubscriberListResponse>;
    expect(env.ok && env.data.subscribers[0].name).toBe('Durable');
  });
});
