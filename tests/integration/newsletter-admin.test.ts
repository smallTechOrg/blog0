// Capability newsletter-list, the admin half: the 0002_newsletter migration on a pre-Phase-7
// database (legacy backfill), GET /api/admin/subscribers (filters, counts, CSV, audit bundle), the
// detail view, send-confirmation (legacy one-time rule + pending resend cap), admin unsubscribe,
// send-legacy-confirmations, and the 12-month IP prune — against the real test Postgres.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, sql as dsql, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { GET as detailRoute } from '@/app/api/admin/subscribers/[id]/route';
import { POST as sendConfirmationRoute } from '@/app/api/admin/subscribers/[id]/send-confirmation/route';
import { POST as adminUnsubscribeRoute } from '@/app/api/admin/subscribers/[id]/unsubscribe/route';
import { GET as listRoute } from '@/app/api/admin/subscribers/route';
import { POST as sendLegacyRoute } from '@/app/api/admin/subscribers/send-legacy-confirmations/route';
import { POST as newsletterRoute } from '@/app/api/newsletter/route';
import type {
  AdminUnsubscribeResponse,
  NewsletterAuditBundle,
  SendConfirmationResponse,
  SendLegacyConfirmationsResponse,
  SubscriberDetailResponse,
  SubscriberListResponse,
} from '@/lib/api/dto';
import { closeDb, getDb, rowsOf } from '@/server/db/client';
import { MIGRATIONS_FOLDER, getMigrationStatus, readJournal, runMigrations } from '@/server/db/migrate';
import { newsletterMessage, newsletterSubscriber, newsletterSubscriberEvent, newsletterSuppression, type SiteRow } from '@/server/db/schema';
import { subscribersToCsv } from '@/server/newsletter/audit';
import { IP_RETENTION_MS } from '@/server/newsletter/constants';
import { MailError, resetMailTransportForTests, type MailTransport } from '@/server/newsletter/mail';
import { sendLegacyConfirmation } from '@/server/newsletter/legacy';
import { pruneIps } from '@/server/newsletter/prune';
import { resetNewsletterRateLimiterForTests } from '@/server/newsletter/rate-limit';
import { runTick } from '@/server/newsletter/issues/tick';
import { unsubscribeToken } from '@/server/newsletter/links';
import { StubNewsletterSender } from '@/server/newsletter/sender';
import { confirmByToken, subscribe, unsubscribeByToken } from '@/server/newsletter/service';
import { resetCurrentSiteForTests } from '@/server/site/current';

import { call, data, err, ORIGIN } from '../helpers/api';
import { prepareTestDatabase, resetDb } from '../helpers/db';
import { getTestDatabaseUrl } from '../helpers/env';
import { captureLogs } from '../helpers/logs';
import { loginAs, type TestLogin } from '../helpers/session';

const ctx = { params: Promise.resolve({}) };
let currentSite: SiteRow;
let admin: TestLogin;
let logs: ReturnType<typeof captureLogs>;

async function signup(email: string, sourceUrl = '/'): Promise<string> {
  const before = logs.find('newsletter.mail').length;
  const res = await newsletterRoute(
    new Request(`${ORIGIN}/api/newsletter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3410', 'user-agent': 'vitest-ua' },
      body: JSON.stringify({ email, sourceUrl }),
    }),
    ctx,
  );
  expect(res.status).toBe(200);
  return new URL(logs.find('newsletter.mail')[before].confirm_url as string).searchParams.get('t') as string;
}

async function row(email: string) {
  const [r] = await getDb().select().from(newsletterSubscriber).where(and(eq(newsletterSubscriber.siteId, currentSite.id), eq(newsletterSubscriber.email, email)));
  return r;
}

const list = (query = '') => call<SubscriberListResponse>(listRoute, 'GET', `/api/admin/subscribers${query}`, { who: admin });
const detail = (id: string) => call<SubscriberDetailResponse>(detailRoute, 'GET', `/api/admin/subscribers/${id}`, { who: admin, id });
const sendConfirmation = (id: string) => call<SendConfirmationResponse>(sendConfirmationRoute, 'POST', `/api/admin/subscribers/${id}/send-confirmation`, { who: admin, id, body: {} });

beforeEach(async () => {
  currentSite = await resetDb();
  resetNewsletterRateLimiterForTests({ perEmail: 100 });
  resetMailTransportForTests();
  admin = await loginAs({ displayName: 'Desk Admin', email: 'desk@example.test' });
  logs = captureLogs();
});

afterAll(() => {
  logs?.stop();
});

describe('migration 0002_newsletter on a Phase 2 database', () => {
  it('turns subscribed rows into legacy_unconfirmed, gives unsubscribed rows one migration suppression + event, and the legacy row gets exactly one admin-triggered email', async () => {
    const url = getTestDatabaseUrl();
    // A migrations folder holding only 0000 + 0001 (the Phase 2 schema).
    const dir = mkdtempSync(path.join(tmpdir(), 'blog0-mig-'));
    cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
    rmSync(path.join(dir, '0002_newsletter.sql'));
    rmSync(path.join(dir, 'meta', '0002_snapshot.json'));
    const journal = readJournal(MIGRATIONS_FOLDER);
    writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries: journal.filter((e) => e.idx < 2) }));
    await closeDb();
    const pg = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await pg.unsafe('drop schema if exists drizzle cascade; drop schema if exists public cascade; create schema public;');
      await runMigrations(url, dir);
      expect((await getMigrationStatus(url, dir)).applied).toEqual(['0000_init', '0001_rate_limit_bucket']);
      const [site] = await pg`insert into site (slug, brand_name, wordmark, publisher_name, tagline, contact_email, about_strap, about_stand, about_body_md)
        values ('blog0', 'blog0', 'blog0', 'smallTech', 't', 'hello@logzero.blog', 's', 's', 'b') returning id`;
      await pg`insert into newsletter_subscriber (site_id, email, name, status) values (${site.id}, 'old-sub@example.com', 'Old Sub', 'subscribed')`;
      await pg`insert into newsletter_subscriber (site_id, email, status) values (${site.id}, 'old-gone@example.com', 'unsubscribed')`;

      const applied = await runMigrations(url);
      expect(applied).toEqual(['0002_newsletter', '0003_newsletter_prune_fix']);
      const status = await getMigrationStatus(url);
      expect(status.applied).toHaveLength(4);
      expect(status.latestApplied).toBe('0003_newsletter_prune_fix');
      expect(status.pending).toEqual([]);
    } finally {
      await pg.end({ timeout: 5 });
      rmSync(dir, { recursive: true, force: true });
    }
    resetCurrentSiteForTests();
    const db = getDb();
    const rows = await db.select().from(newsletterSubscriber).orderBy(newsletterSubscriber.email);
    expect(rows.map((r) => [r.email, r.status, r.source])).toEqual([
      ['old-gone@example.com', 'unsubscribed', 'footer'],
      ['old-sub@example.com', 'legacy_unconfirmed', 'legacy'],
    ]);
    expect(rows[0].unsubscribedAt).not.toBeNull();
    expect(rows[1]).toMatchObject({ name: 'Old Sub', consentText: null, consentVersion: null, confirmTokenHash: null, legacyConfirmationSentAt: null });
    const sup = await db.select().from(newsletterSuppression);
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({ email: 'old-gone@example.com', reason: 'unsubscribed', source: 'migration', subscriberId: rows[0].id });
    const ev = await db.select().from(newsletterSubscriberEvent);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ email: 'old-gone@example.com', kind: 'unsubscribed', source: 'migration' });

    // The admin sends the one-time confirmation to the legacy row; a second click is refused.
    currentSite = (await import('@/server/site/current').then((m) => m.getCurrentSite())) as SiteRow;
    admin = await loginAs({ displayName: 'Desk Admin' });
    const legacy = rows[1];
    const first = await sendConfirmation(legacy.id);
    expect(first.status).toBe(200);
    expect(data(first.env)).toMatchObject({ sentTo: 'old-sub@example.com', transport: 'stub' });
    expect(data(first.env).subscriber).toMatchObject({ status: 'legacy_unconfirmed', canSendConfirmation: false, confirmationSentCount: 1 });
    expect(data(first.env).subscriber.legacyConfirmationSentAt).not.toBeNull();
    expect(data(first.env).subscriber.events.map((e) => e.kind)).toEqual(['legacy_confirmation_sent']);
    expect(data(first.env).subscriber.events[0].actor).toBe('Desk Admin');
    expect(await db.select().from(newsletterMessage)).toHaveLength(1);

    const second = await sendConfirmation(legacy.id);
    expect(second.status).toBe(409);
    expect(err(second.env).code).toBe('CONFIRMATION_ALREADY_SENT');
    expect(await db.select().from(newsletterMessage)).toHaveLength(1);

    // "Send confirmation to all legacy" skips the already-mailed row …
    const all = await call<SendLegacyConfirmationsResponse>(sendLegacyRoute, 'POST', '/api/admin/subscribers/send-legacy-confirmations', { who: admin, body: { confirm: true } });
    expect(data(all.env)).toEqual({ sent: 0, skipped: 0 });
    const noConfirm = await call(sendLegacyRoute, 'POST', '/api/admin/subscribers/send-legacy-confirmations', { who: admin, body: {} });
    expect(noConfirm.status).toBe(400);

    // … and the click confirms the legacy row (consent line without a signup date — links.ts).
    const token = new URL(logs.find('newsletter.mail').at(-1)!.confirm_url as string).searchParams.get('t') as string;
    const confirmed = await confirmByToken(token, { ip: 'direct', userAgent: 'mail' });
    expect(confirmed.subscriber.status).toBe('confirmed');
    expect((await data((await detail(legacy.id)).env).subscriber).events.map((e) => e.kind)).toEqual(['legacy_confirmation_sent', 'confirmed']);
    // the legacy row's "unsubscribed" sibling is never eligible
    const notEligible = await sendConfirmation(rows[0].id);
    expect(notEligible.status).toBe(409);
    expect(err(notEligible.env).code).toBe('SUBSCRIBER_NOT_ELIGIBLE');

    // leave the database as the other files expect it
    await closeDb();
    await prepareTestDatabase(url);
    resetCurrentSiteForTests();
  });
});

describe('GET /api/admin/subscribers', () => {
  it('refuses a signed-out request for every format with 401', async () => {
    for (const q of ['', '?format=csv', '?format=audit']) {
      const res = await call(listRoute, 'GET', `/api/admin/subscribers${q}`, { cookie: null });
      expect(res.status).toBe(401);
      expect(err(res.env).code).toBe('UNAUTHENTICATED');
    }
  });

  it('lists newest first with counts per status; ?status= and ?q= filter; unknown status → 400', async () => {
    const t1 = await signup('one@example.com', '/p/first');
    await confirmByToken(t1, { ip: 'direct', userAgent: null });
    await new Promise((r) => setTimeout(r, 5));
    await signup('two@example.com');
    await new Promise((r) => setTimeout(r, 5));
    const t3 = await signup('three@example.com');
    await confirmByToken(t3, { ip: 'direct', userAgent: null });
    await call(adminUnsubscribeRoute, 'POST', `/api/admin/subscribers/${(await row('three@example.com')).id}/unsubscribe`, { who: admin, id: (await row('three@example.com')).id, body: { note: 'asked by mail' } });

    const all = await list();
    expect(all.status).toBe(200);
    const d = data(all.env);
    expect(d.subscribers.map((s) => s.email)).toEqual(['three@example.com', 'two@example.com', 'one@example.com']);
    expect(d.total).toBe(3);
    expect(d.counts).toEqual({ all: 3, pending: 1, confirmed: 1, unsubscribed: 1, bounced: 0, legacy_unconfirmed: 0 });
    expect(Number.isNaN(Date.parse(d.now))).toBe(false);
    expect(d.subscribers[2]).toMatchObject({ status: 'confirmed', sourceUrl: '/p/first', consentVersion: 'v1', source: 'footer', pendingExpired: false, canSendConfirmation: false, providerSyncedAt: null });
    expect(d.subscribers[1]).toMatchObject({ status: 'pending', canSendConfirmation: true });
    expect(d.subscribers[0].unsubscribedAt).not.toBeNull();

    const confirmed = data((await list('?status=confirmed')).env);
    expect(confirmed.subscribers.map((s) => s.email)).toEqual(['one@example.com']);
    expect(confirmed.total).toBe(1);
    expect(confirmed.counts.all).toBe(3); // counts are always for the whole site
    expect(data((await list('?q=TW')).env).subscribers.map((s) => s.email)).toEqual(['two@example.com']);
    expect(data((await list('?q=%25')).env).subscribers).toHaveLength(0); // a literal % matches nothing
    const bad = await list('?status=subscribed');
    expect(bad.status).toBe(400);
    expect(err(bad.env).code).toBe('VALIDATION_FAILED');
    expect((await list()).env).toMatchObject({ ok: true });
    expect(data((await list('?status=bounced')).env)).toMatchObject({ subscribers: [], total: 0 });
  });

  it('exports CSV with the Phase 7 header (filter applies, formulas neutralised) and the audit JSON bundle (everything, row for row)', async () => {
    const t = await signup('csv@example.com', '/archive?topic=Op-Ed');
    await confirmByToken(t, { ip: 'direct', userAgent: null });
    await subscribe({ ip: 'direct', userAgent: null }, { email: 'formula@example.com', name: '=HYPERLINK("x")', sourceUrl: '/' });
    const gone = await row('csv@example.com');
    await call(adminUnsubscribeRoute, 'POST', `/api/admin/subscribers/${gone.id}/unsubscribe`, { who: admin, id: gone.id, body: {} });

    const csv = await listRoute(new Request(`${ORIGIN}/api/admin/subscribers?format=csv`, { headers: { cookie: admin.cookie, host: 'localhost:3410' } }), ctx);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toMatch(/^attachment; filename="[A-Za-z0-9_-]+-subscribers-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = (await csv.text()).trimEnd().split('\r\n');
    expect(lines[0]).toBe('email,name,status,subscribed_at,confirmed_at,unsubscribed_at,source,source_url,consent_version');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^formula@example\.com,"'=HYPERLINK\(""x""\)",pending,20\d\d-[^,]+,,,footer,\/,v1$/);
    expect(lines[2]).toMatch(/^csv@example\.com,,unsubscribed,20\d\d-[^,]+,20\d\d-[^,]+,20\d\d-[^,]+,footer,\/archive\?topic=Op-Ed,v1$/);
    const filtered = await listRoute(new Request(`${ORIGIN}/api/admin/subscribers?format=csv&status=pending`, { headers: { cookie: admin.cookie, host: 'localhost:3410' } }), ctx);
    expect((await filtered.text()).trimEnd().split('\r\n')).toHaveLength(2);
    expect(subscribersToCsv([])).toBe('email,name,status,subscribed_at,confirmed_at,unsubscribed_at,source,source_url,consent_version\r\n');

    const audit = await listRoute(new Request(`${ORIGIN}/api/admin/subscribers?format=audit&status=pending`, { headers: { cookie: admin.cookie, host: 'localhost:3410' } }), ctx);
    expect(audit.status).toBe(200);
    expect(audit.headers.get('content-type')).toContain('application/json');
    expect(audit.headers.get('content-disposition')).toMatch(/^attachment; filename="[A-Za-z0-9_-]+-newsletter-audit-\d{4}-\d{2}-\d{2}\.json"$/);
    const bundle = (await audit.json()) as NewsletterAuditBundle;
    expect(bundle.format).toBe('blog0-newsletter-audit/1');
    expect(bundle.exportedBy).toBe('desk@example.test');
    expect(bundle.site).toEqual({ slug: currentSite.slug, brandName: 'blog0' });
    expect(bundle.settings).toEqual({ mode: 'manual', autoSend: false, digestDays: 7, digestPosts: 3, consentText: currentSite.newsletterConsentText, consentVersion: 'v1', modeSetAt: null });
    expect(bundle.subscribers.map((s) => s.email)).toEqual(['formula@example.com', 'csv@example.com']); // filters ignored
    const db = getDb();
    for (const s of bundle.subscribers) {
      const events = await db.select().from(newsletterSubscriberEvent).where(eq(newsletterSubscriberEvent.subscriberId, s.id)).orderBy(newsletterSubscriberEvent.createdAt, newsletterSubscriberEvent.id);
      expect(s.events.map((e) => [e.id, e.kind, e.source])).toEqual(events.map((e) => [e.id, e.kind, e.source]));
      expect(s).not.toHaveProperty('messages');
      expect(s).not.toHaveProperty('canSendConfirmation');
      expect(s.consentText).toBe(currentSite.newsletterConsentText);
      expect(s.signupUserAgent).toBe(s.email === 'csv@example.com' ? 'vitest-ua' : null);
    }
    const sup = await db.select().from(newsletterSuppression).where(eq(newsletterSuppression.siteId, currentSite.id));
    expect(bundle.suppressions.map((s) => [s.id, s.email, s.reason, s.source, s.subscriberId])).toEqual(sup.map((s) => [s.id, s.email, s.reason, s.source, s.subscriberId]));
    expect(bundle.suppressions[0]).toMatchObject({ email: 'csv@example.com', reason: 'admin', source: 'admin' });
    const csvRow = bundle.subscribers.find((s) => s.email === 'csv@example.com')!;
    expect(csvRow.suppressions).toHaveLength(1);
    expect(csvRow.events.at(-1)).toMatchObject({ kind: 'unsubscribed', source: 'admin', actor: 'Desk Admin', details: { reason: 'admin' } });
  });
});

describe('subscriber detail, send-confirmation and admin unsubscribe', () => {
  it('GET /:id shows every stored field, the timeline, suppressions and messages; unknown id → 404', async () => {
    const t = await signup('d@example.com', '/p/x');
    await confirmByToken(t, { ip: 'direct', userAgent: 'Mail/1' });
    const r = await row('d@example.com');

    const res = await detail(r.id);

    expect(res.status).toBe(200);
    const s = data(res.env).subscriber;
    expect(s).toMatchObject({
      id: r.id,
      email: 'd@example.com',
      status: 'confirmed',
      signupUserAgent: 'vitest-ua',
      signupIp: null,
      confirmedUserAgent: 'Mail/1',
      consentText: currentSite.newsletterConsentText,
      consentVersion: 'v1',
      sourceUrl: '/p/x',
      confirmationSentCount: 1,
      confirmTokenExpiresAt: null,
      legacyConfirmationSentAt: null,
      providerId: null,
      ipPrunedAt: null,
      suppressions: [],
    });
    expect(s.events.map((e) => e.kind)).toEqual(['signup', 'confirmation_sent', 'confirmed']);
    expect(s.events[1].details).toEqual({ outcome: 'stubbed', transport: 'stub' });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ kind: 'confirmation', transport: 'stub', status: 'stubbed' });
    expect(s.messages[0].subject).toBe('Confirm your subscription to blog0');

    const missing = await detail('00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
    expect((await detail('not-a-uuid')).status).toBe(404);
    expect((await call(detailRoute, 'GET', `/api/admin/subscribers/${r.id}`, { cookie: null, id: r.id })).status).toBe(401);
  });

  it('send-confirmation on a pending row resends with a new token under the cap; the 4th in 24 h is 409 with retryAt; confirmed → 409 NOT_ELIGIBLE', async () => {
    await signup('resend@example.com');
    const before = await row('resend@example.com');

    const one = await sendConfirmation(before.id);
    expect(one.status).toBe(200);
    expect(data(one.env)).toMatchObject({ sentTo: 'resend@example.com', transport: 'stub' });
    const after = await row('resend@example.com');
    expect(after.confirmTokenHash).not.toBe(before.confirmTokenHash);
    expect(after.confirmationSentCount).toBe(2);
    expect(data(one.env).subscriber.events.at(-1)).toMatchObject({ kind: 'confirmation_sent', source: 'admin', actor: 'Desk Admin', details: { resend: true, outcome: 'stubbed' } });

    const two = await sendConfirmation(before.id);
    expect(two.status).toBe(200);
    expect(data(two.env).subscriber.canSendConfirmation).toBe(false);
    const capped = await sendConfirmation(before.id);
    expect(capped.status).toBe(409);
    expect(err(capped.env).code).toBe('CONFIRMATION_ALREADY_SENT');
    expect(Number.isNaN(Date.parse((err(capped.env).details as { retryAt: string }).retryAt))).toBe(false);
    expect((await row('resend@example.com')).confirmationSentCount).toBe(3);

    // the old (first) token no longer confirms, the newest does
    const latest = new URL(logs.find('newsletter.mail').at(-1)!.confirm_url as string).searchParams.get('t') as string;
    const first = new URL(logs.find('newsletter.mail')[0].confirm_url as string).searchParams.get('t') as string;
    await expect(confirmByToken(first, { ip: 'direct', userAgent: null })).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    await confirmByToken(latest, { ip: 'direct', userAgent: null });
    const notEligible = await sendConfirmation(before.id);
    expect(notEligible.status).toBe(409);
    expect(err(notEligible.env).code).toBe('SUBSCRIBER_NOT_ELIGIBLE');
  });

  it('send-confirmation answers 502 MAIL_FAILED when the transport rejects and changes nothing', async () => {
    await signup('mailfail@example.com');
    const before = await row('mailfail@example.com');
    const failing: MailTransport = {
      kind: 'smtp',
      send: async () => {
        throw new MailError('smtp', 'relay down');
      },
    };
    resetMailTransportForTests(failing);

    const res = await sendConfirmation(before.id);

    expect(res.status).toBe(502);
    expect(err(res.env).code).toBe('MAIL_FAILED');
    const after = await row('mailfail@example.com');
    expect(after.confirmTokenHash).toBe(before.confirmTokenHash);
    expect(after.confirmationSentCount).toBe(before.confirmationSentCount);
    expect((await getDb().select().from(newsletterSubscriberEvent).where(eq(newsletterSubscriberEvent.subscriberId, before.id))).map((e) => e.kind)).toEqual(['signup', 'confirmation_sent']);
  });

  it('admin unsubscribe writes an admin-sourced suppression with the note; a second call is 409; a cross-origin call is 403', async () => {
    const t = await signup('adm@example.com');
    await confirmByToken(t, { ip: 'direct', userAgent: null });
    const r = await row('adm@example.com');

    const res = await call<AdminUnsubscribeResponse>(adminUnsubscribeRoute, 'POST', `/api/admin/subscribers/${r.id}/unsubscribe`, { who: admin, id: r.id, body: { note: ' Asked on X ' } });

    expect(res.status).toBe(200);
    const s = data(res.env).subscriber;
    expect(s.status).toBe('unsubscribed');
    expect(s.suppressions).toHaveLength(1);
    expect(s.suppressions[0]).toMatchObject({ reason: 'admin', source: 'admin', details: { note: 'Asked on X' } });
    expect(s.events.at(-1)).toMatchObject({ kind: 'unsubscribed', source: 'admin', actor: 'Desk Admin' });

    const again = await call(adminUnsubscribeRoute, 'POST', `/api/admin/subscribers/${r.id}/unsubscribe`, { who: admin, id: r.id, body: {} });
    expect(again.status).toBe(409);
    expect(err(again.env).code).toBe('SUBSCRIBER_NOT_ELIGIBLE');
    const cross = await call(adminUnsubscribeRoute, 'POST', `/api/admin/subscribers/${r.id}/unsubscribe`, { who: admin, id: r.id, body: {}, origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
    const longNote = await call(adminUnsubscribeRoute, 'POST', `/api/admin/subscribers/${r.id}/unsubscribe`, { who: admin, id: r.id, body: { note: 'n'.repeat(301) } });
    expect(longNote.status).toBe(400);
    expect(await getDb().select().from(newsletterSuppression).where(eq(newsletterSuppression.subscriberId, r.id))).toHaveLength(1);
  });
});

describe('legacy one-time confirmation under concurrency (R4)', () => {
  async function legacyRow(email: string) {
    const [r] = await getDb().insert(newsletterSubscriber).values({ siteId: currentSite.id, email, status: 'legacy_unconfirmed', source: 'legacy' }).returning();
    return r;
  }

  it('two racing sends (a click + "send all", or a double click) mail once: one 200, one 409 CONFIRMATION_ALREADY_SENT; one message, one event', async () => {
    const legacy = await legacyRow('legacy-race@example.com');
    const outcomes = await Promise.allSettled([sendLegacyConfirmation(currentSite.id, legacy, { userId: admin.user.id }), sendLegacyConfirmation(currentSite.id, legacy, { userId: admin.user.id })]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'CONFIRMATION_ALREADY_SENT', status: 409 });
    expect(await getDb().select().from(newsletterMessage).where(eq(newsletterMessage.subscriberId, legacy.id))).toHaveLength(1);
    const evs = await getDb().select().from(newsletterSubscriberEvent).where(eq(newsletterSubscriberEvent.subscriberId, legacy.id));
    expect(evs.map((e) => e.kind)).toEqual(['legacy_confirmation_sent']);
    expect(await row('legacy-race@example.com')).toMatchObject({ confirmationSentCount: 1 });

    // a stale in-memory row (legacyConfirmationSentAt still null) is re-checked under the lock
    await expect(sendLegacyConfirmation(currentSite.id, legacy, { userId: admin.user.id })).rejects.toMatchObject({ code: 'CONFIRMATION_ALREADY_SENT' });
    expect(await getDb().select().from(newsletterMessage).where(eq(newsletterMessage.subscriberId, legacy.id))).toHaveLength(1);
  });

  it('a mail failure releases the claim: the row is exactly as before (MAIL_FAILED changes nothing) and a later send works', async () => {
    const legacy = await legacyRow('legacy-fail@example.com');
    const before = await row('legacy-fail@example.com');
    resetMailTransportForTests({
      kind: 'smtp',
      send: async () => {
        throw new MailError('smtp', 'relay down');
      },
    });
    await expect(sendLegacyConfirmation(currentSite.id, legacy, { userId: admin.user.id })).rejects.toMatchObject({ code: 'MAIL_FAILED', status: 502 });
    expect(await row('legacy-fail@example.com')).toEqual(before);
    expect(await getDb().select().from(newsletterSubscriberEvent).where(eq(newsletterSubscriberEvent.subscriberId, legacy.id))).toHaveLength(0);

    resetMailTransportForTests();
    const ok = await sendLegacyConfirmation(currentSite.id, legacy, { userId: admin.user.id });
    expect(ok.subscriber.legacyConfirmationSentAt).not.toBeNull();
    expect(ok.subscriber.confirmTokenHash).not.toBeNull();
  });
});

describe('IP retention (pruneIps — pnpm newsletter:tick)', () => {
  it('13 months after confirmation nulls signup_ip / confirmed_ip on the row and its events, appends ip_pruned, keeps UA/source/consent; a second run changes nothing; young rows untouched', async () => {
    const t0 = new Date('2025-09-01T00:00:00Z');
    const old = await subscribe({ ip: '203.0.113.9', userAgent: 'Old UA', now: t0 }, { email: 'old@example.com', name: null, sourceUrl: '/p/old' });
    const oldToken = new URL(logs.find('newsletter.mail').at(-1)!.confirm_url as string).searchParams.get('t') as string;
    await confirmByToken(oldToken, { ip: '203.0.113.10', userAgent: 'Old Mail', now: new Date(t0.getTime() + 60_000) });
    const neverConfirmed = await subscribe({ ip: '203.0.113.11', userAgent: 'x', now: t0 }, { email: 'never@example.com', name: null, sourceUrl: '/' });
    const young = await subscribe({ ip: '203.0.113.12', userAgent: 'y', now: new Date() }, { email: 'young@example.com', name: null, sourceUrl: '/' });
    expect(old.subscriber.signupIp).toBe('203.0.113.9');

    const now = new Date(t0.getTime() + IP_RETENTION_MS + 30 * 86_400_000);
    const first = await pruneIps(now);

    expect(first).toEqual({ pruned: 2, eventRows: 5 }); // old: signup + confirmation_sent + confirmed carried IPs (3); never: signup + confirmation_sent (2)
    const o = await row('old@example.com');
    expect(o).toMatchObject({ signupIp: null, confirmedIp: null, signupUserAgent: 'Old UA', confirmedUserAgent: 'Old Mail', signupSourceUrl: '/p/old', consentVersion: 'v1', status: 'confirmed' });
    expect(o.consentText).toBe(currentSite.newsletterConsentText);
    expect(o.ipPrunedAt?.toISOString()).toBe(now.toISOString());
    const oEvents = await getDb().select().from(newsletterSubscriberEvent).where(eq(newsletterSubscriberEvent.subscriberId, o.id)).orderBy(newsletterSubscriberEvent.createdAt);
    expect(oEvents.map((e) => e.kind)).toEqual(['signup', 'confirmation_sent', 'confirmed', 'ip_pruned']);
    expect(oEvents.every((e) => e.ip === null)).toBe(true);
    expect(oEvents[0].userAgent).toBe('Old UA');
    expect(oEvents[2].details).toMatchObject({ consentVersion: 'v1' });
    expect(oEvents[3]).toMatchObject({ source: 'system', details: { hadSignupIp: true, hadConfirmedIp: true } });
    expect(await row('never@example.com')).toMatchObject({ signupIp: null, status: 'pending' });
    expect(neverConfirmed.subscriber.signupIp).toBe('203.0.113.11');
    expect((await row('young@example.com')).signupIp).toBe('203.0.113.12');
    expect(young.subscriber.ipPrunedAt).toBeNull();

    const second = await pruneIps(now);
    expect(second).toEqual({ pruned: 0, eventRows: 0 });
    expect((await getDb().select().from(newsletterSubscriberEvent).where(eq(newsletterSubscriberEvent.subscriberId, o.id))).length).toBe(4);
  });

  /** Confirmed two years ago (IPs on the row + events), unsubscribed 23 months ago (IP on the event), re-signed up `today` with a fresh IP. */
  async function oldThenResignup(email: string, today: Date) {
    const t0 = new Date(today.getTime() - 2 * IP_RETENTION_MS);
    await subscribe({ ip: '198.51.100.1', userAgent: 'Old UA', now: t0 }, { email, name: null, sourceUrl: '/old' });
    const tok = new URL(logs.find('newsletter.mail').at(-1)!.confirm_url as string).searchParams.get('t') as string;
    await confirmByToken(tok, { ip: '198.51.100.2', userAgent: 'Old Mail', now: new Date(t0.getTime() + 60_000) });
    const id = (await row(email)).id;
    await unsubscribeByToken(unsubscribeToken(id), 'email_link', { ip: '198.51.100.3', userAgent: 'Old Mail', now: new Date(t0.getTime() + 30 * 86_400_000) });
    await subscribe({ ip: '203.0.113.77', userAgent: 'New UA', now: today }, { email, name: null, sourceUrl: '/new' });
    return { id, t0 };
  }

  async function eventsOf(id: string) {
    return getDb().select().from(newsletterSubscriberEvent).where(eq(newsletterSubscriberEvent.subscriberId, id)).orderBy(newsletterSubscriberEvent.createdAt, newsletterSubscriberEvent.id);
  }

  it('B3: confirmed 2 years ago → unsubscribed → re-signup today with an IP → the prune keeps the new signup_ip and the new signup event IP, nulls the old event IPs and the old confirmed_ip', async () => {
    const today = new Date();
    const { id } = await oldThenResignup('back-again@example.com', today);
    const before = await row('back-again@example.com');
    expect(before).toMatchObject({ status: 'pending', signupIp: '203.0.113.77', confirmedIp: '198.51.100.2' });

    const first = await pruneIps(today);

    expect(first).toEqual({ pruned: 1, eventRows: 4 }); // old signup + confirmation_sent + confirmed + unsubscribed
    const after = await row('back-again@example.com');
    expect(after).toMatchObject({ signupIp: '203.0.113.77', confirmedIp: null, signupUserAgent: 'New UA', confirmedUserAgent: 'Old Mail', status: 'pending' });
    expect(after.ipPrunedAt?.toISOString()).toBe(today.toISOString());
    const evs = await eventsOf(id);
    const fresh = evs.filter((e) => e.createdAt.getTime() >= today.getTime() && e.kind !== 'ip_pruned');
    const old = evs.filter((e) => e.createdAt.getTime() < today.getTime());
    expect(old.map((e) => e.kind)).toEqual(['signup', 'confirmation_sent', 'confirmed', 'unsubscribed']);
    expect(old.every((e) => e.ip === null)).toBe(true);
    expect(old[0].userAgent).toBe('Old UA'); // only `ip` is touched
    expect(fresh.find((e) => e.kind === 'signup')).toMatchObject({ ip: '203.0.113.77', userAgent: 'New UA' });
    expect(evs.find((e) => e.kind === 'ip_pruned')).toMatchObject({ source: 'system', details: { hadSignupIp: false, hadConfirmedIp: true, eventRows: 4 } });

    // idempotent; and a year later the re-signup's own IPs age out too
    expect(await pruneIps(today)).toEqual({ pruned: 0, eventRows: 0 });
    const nextYear = new Date(today.getTime() + IP_RETENTION_MS + 86_400_000);
    const later = await pruneIps(nextYear);
    expect(later.pruned).toBe(1);
    expect(later.eventRows).toBeGreaterThanOrEqual(1);
    expect(await row('back-again@example.com')).toMatchObject({ signupIp: null, confirmedIp: null });
    expect((await eventsOf(id)).every((e) => e.ip === null)).toBe(true);
  });

  it('B3 boundary: an event exactly at the bar is kept; one 1 ms older is nulled (newsletter_prune_event_ips(p_before) is strict)', async () => {
    const now = new Date();
    const bar = new Date(now.getTime() - IP_RETENTION_MS);
    await subscribe({ ip: '192.0.2.1', userAgent: 'u', now: new Date(bar.getTime() - 1) }, { email: 'edge-old@example.com', name: null, sourceUrl: '/' });
    await subscribe({ ip: '192.0.2.2', userAgent: 'u', now: bar }, { email: 'edge-at@example.com', name: null, sourceUrl: '/' });
    await pruneIps(now);
    const oldEv = await eventsOf((await row('edge-old@example.com')).id);
    const atEv = await eventsOf((await row('edge-at@example.com')).id);
    expect(oldEv.find((e) => e.kind === 'signup')!.ip).toBeNull();
    expect((await row('edge-old@example.com')).signupIp).toBeNull();
    expect(atEv.find((e) => e.kind === 'signup')!.ip).toBe('192.0.2.2');
    expect((await row('edge-at@example.com')).signupIp).toBe('192.0.2.2');
  });

  it('B3 via the tick path: runTick (stub sender) prunes the same way and reports ips_pruned', async () => {
    const today = new Date();
    const { id } = await oldThenResignup('tick-back@example.com', today);
    const sender = new StubNewsletterSender({ recordToDb: false });

    const tick = await runTick(currentSite.id, { now: today, sender });

    expect(tick.errors).toEqual([]);
    expect(tick.ipsPruned).toBe(1);
    expect(await row('tick-back@example.com')).toMatchObject({ signupIp: '203.0.113.77', confirmedIp: null });
    const evs = await eventsOf(id);
    expect(evs.filter((e) => e.createdAt.getTime() < today.getTime()).every((e) => e.ip === null)).toBe(true);
    expect(evs.find((e) => e.kind === 'signup' && e.createdAt.getTime() === today.getTime())!.ip).toBe('203.0.113.77');
    expect(logs.find('newsletter.tick').at(-1)).toMatchObject({ ips_pruned: 1 });
    expect((await runTick(currentSite.id, { now: today, sender })).ipsPruned).toBe(0);
  });

  it('B3 error path: the old one-argument prune function is gone (no caller can null every event IP)', async () => {
    const r = await subscribe({ ip: '192.0.2.9', userAgent: 'u' }, { email: 'fn@example.com', name: null, sourceUrl: '/' });
    let caught: unknown = null;
    try {
      await getDb().execute(dsql`select newsletter_prune_event_ips(${r.subscriber.id}::uuid)`);
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect((await row('fn@example.com')).signupIp).toBe('192.0.2.9');
    // R5: the SECURITY DEFINER function pins its search_path
    const list = rowsOf<{ args: string; prosecdef: boolean; proconfig: string[] | null }>(
      await getDb().execute(dsql`select pg_get_function_identity_arguments(oid) as args, prosecdef, proconfig from pg_proc where proname = 'newsletter_prune_event_ips'`),
    );
    expect(list).toEqual([{ args: 'p_subscriber_id uuid, p_before timestamp with time zone', prosecdef: true, proconfig: ['search_path=public, pg_temp'] }]);
  });
});
