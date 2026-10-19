// The approved fix pass on the frozen newsletter (capability newsletter-list.md "Assumed (fix pass)"):
// scanner-safe link helpers (peek never changes state or counts), the unsubscribe secret, confirmation
// token redaction, the privacy link + postal address in mail and issues (+ the warning), and erasure
// through POST /api/admin/subscribers/:id/erase — against the real test Postgres with the stub transport.
// (The SQL function itself is covered on both engines in newsletter-erasure-sql.test.ts.)
import { and, asc, eq, sql as dsql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PATCH as siteRoute } from '@/app/api/admin/site/route';
import { GET as previewRoute } from '@/app/api/admin/newsletter/issues/[id]/preview/route';
import { POST as sendRoute } from '@/app/api/admin/newsletter/issues/[id]/send/route';
import { GET as getIssueRoute } from '@/app/api/admin/newsletter/issues/[id]/route';
import { POST as createIssueRoute } from '@/app/api/admin/newsletter/issues/route';
import { POST as eraseRoute } from '@/app/api/admin/subscribers/[id]/erase/route';
import { GET as listRoute } from '@/app/api/admin/subscribers/route';
import { POST as sendConfirmationRoute } from '@/app/api/admin/subscribers/[id]/send-confirmation/route';
import { GET as detailRoute } from '@/app/api/admin/subscribers/[id]/route';
import { GET as confirmGet } from '@/app/(site)/newsletter/confirm/route';
import { POST as confirmRoute } from '@/app/api/newsletter/confirm/route';
import { POST as newsletterRoute } from '@/app/api/newsletter/route';
import { POST as unsubscribeRoute } from '@/app/api/newsletter/unsubscribe/route';
import type {
  IssueDetailResponse,
  IssuePreviewDto,
  NewsletterConfirmResponse,
  NewsletterUnsubscribeResponse,
  SendConfirmationResponse,
  SiteSettingsResponse,
  NewsletterAuditBundle,
  SubscriberDetailResponse,
  SubscriberEraseResponse,
  SubscriberListResponse,
} from '@/lib/api/dto';
import type { Envelope } from '@/lib/api/envelope';
import { resetConfigForTests } from '@/server/config';
import { getDb, rowsOf } from '@/server/db/client';
import {
  newsletterErasureLog,
  newsletterErasureMarker,
  newsletterMessage,
  newsletterSubscriber,
  newsletterSubscriberEvent,
  newsletterSuppression,
  type SiteRow,
} from '@/server/db/schema';
import { runTick } from '@/server/newsletter/issues/tick';
import { senderSubscriberFrom } from '@/server/newsletter/sender/sync';
import { resetMailTransportForTests } from '@/server/newsletter/mail';
import { privacyUrl, unsubscribeToken, unsubscribeVerifySecrets } from '@/server/newsletter/links';
import { resetNewsletterLinkRateLimiterForTests, resetNewsletterRateLimiterForTests } from '@/server/newsletter/rate-limit';
import { resetNewsletterSenderForTests, StubNewsletterSender, type NewsletterSender, type SenderIssue } from '@/server/newsletter/sender';
import { peekUnsubscribeToken } from '@/server/newsletter/service';
import { erasureHash, signUnsubscribeToken, verifyUnsubscribeToken } from '@/server/newsletter/tokens';

import { actAs, call, createArticle, data, err, publish } from '../helpers/api';
import { resetDb } from '../helpers/db';
import { captureLogs } from '../helpers/logs';
import { loginAs, type TestLogin } from '../helpers/session';

const ORIGIN = 'http://localhost:3410';
const ctx = { params: Promise.resolve({}) };
const BODY = 'The deck shows the strongest lines of the article in order.\n\nWriters pick the lines by hand when the model is unavailable.';

const saved = {
  hops: process.env.BLOG0_TRUSTED_PROXY_HOPS,
  unsub: process.env.BLOG0_UNSUBSCRIBE_SECRET,
  session: process.env.BLOG0_SESSION_SECRET,
};

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  resetConfigForTests();
}

let currentSite: SiteRow;
let admin: TestLogin;
let logs: ReturnType<typeof captureLogs>;

beforeEach(async () => {
  currentSite = await resetDb();
  resetNewsletterRateLimiterForTests({ perEmail: 100, perIp: 100 });
  resetNewsletterLinkRateLimiterForTests();
  resetMailTransportForTests();
  resetNewsletterSenderForTests();
  setEnv('BLOG0_TRUSTED_PROXY_HOPS', '1');
  setEnv('BLOG0_UNSUBSCRIBE_SECRET', undefined);
  admin = actAs(await loginAs({ email: 'desk@example.test', displayName: 'Desk Admin' }));
  logs = captureLogs();
});

afterEach(() => {
  logs.stop();
  setEnv('BLOG0_TRUSTED_PROXY_HOPS', saved.hops);
  setEnv('BLOG0_UNSUBSCRIBE_SECRET', saved.unsub);
  setEnv('BLOG0_SESSION_SECRET', saved.session);
  resetNewsletterSenderForTests();
});

// --- helpers ------------------------------------------------------------------------------------

interface SignupOptions {
  ip?: string;
  ua?: string;
  name?: string;
  sourceUrl?: string;
}

async function signup(email: string, opts: SignupOptions = {}): Promise<string | null> {
  const before = logs.find('newsletter.mail').length;
  const res = await newsletterRoute(
    new Request(`${ORIGIN}/api/newsletter`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        host: 'localhost:3410',
        'x-forwarded-for': opts.ip ?? '203.0.113.7',
        'user-agent': opts.ua ?? 'vitest-signup',
      },
      body: JSON.stringify({ email, name: opts.name, sourceUrl: opts.sourceUrl ?? '/', fillMs: 5000 }),
    }),
    ctx,
  );
  expect(res.status).toBe(200);
  const line = logs.find('newsletter.mail')[before];
  return line ? (new URL(line.confirm_url as string).searchParams.get('t') as string) : null;
}

async function postJson<T>(handler: typeof confirmRoute, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await handler(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost:3410', 'x-forwarded-for': '203.0.113.7', ...headers },
      body: JSON.stringify(body),
    }),
    ctx,
  );
  return { status: res.status, env: (await res.json()) as Envelope<T> };
}

const confirm = (token: string, headers?: Record<string, string>) => postJson<NewsletterConfirmResponse>(confirmRoute, '/api/newsletter/confirm', { token }, headers);
const unsubscribe = (token: string, headers?: Record<string, string>) =>
  postJson<NewsletterUnsubscribeResponse>(unsubscribeRoute, '/api/newsletter/unsubscribe', { token, source: 'email_link' }, headers);

async function row(email: string) {
  const [r] = await getDb().select().from(newsletterSubscriber).where(and(eq(newsletterSubscriber.siteId, currentSite.id), eq(newsletterSubscriber.email, email)));
  return r;
}

async function eventKinds(subscriberId: string): Promise<string[]> {
  const rows = await getDb().select().from(newsletterSubscriberEvent).where(eq(newsletterSubscriberEvent.subscriberId, subscriberId)).orderBy(asc(newsletterSubscriberEvent.createdAt), asc(newsletterSubscriberEvent.id));
  return rows.map((r) => r.kind);
}

async function confirmed(email: string, opts: SignupOptions = {}) {
  const token = (await signup(email, opts)) as string;
  expect((await confirm(token, { 'x-forwarded-for': opts.ip ?? '203.0.113.7', 'user-agent': opts.ua ?? 'vitest-signup' })).status).toBe(200);
  return row(email);
}

// --- (1) link GETs: confirm on open; unsubscribe scanner-safe -------------------------------------------------------------------

describe('confirm on open (owner decision 2026-10-19) / peekUnsubscribeToken (what the unsubscribe page calls)', () => {
  it('the confirm link GET confirms and spends the same link cap as the POST: with a cap of ONE, the open goes through and the POST after it is 429', async () => {
    resetNewsletterLinkRateLimiterForTests({ perIp: 1, siteWide: 1 });
    const token = (await signup('open@example.com')) as string;
    const before = await row('open@example.com');
    expect(before.status).toBe('pending');

    const opened = await confirmGet(new Request(`${ORIGIN}/newsletter/confirm?t=${token}`, { headers: { host: 'localhost:3410', 'user-agent': 'vitest-open' } }));
    expect(opened.status).toBe(303);
    expect(opened.headers.get('location')).toBe('/newsletter/confirmed?status=ok');
    expect(await row('open@example.com')).toMatchObject({ status: 'confirmed', confirmTokenHash: null, confirmedUserAgent: 'vitest-open' });
    expect(await eventKinds(before.id)).toContain('confirmed');
    expect((await confirm(token)).status).toBe(429); // one cap shared by GET and POST
  });

  it('peekUnsubscribeToken verifies the signature without a lookup: a confirmed subscriber stays confirmed with no suppression; the POST { token, source: email_link } unsubscribes', async () => {
    const sub = await confirmed('peek-unsub@example.com');
    resetNewsletterLinkRateLimiterForTests({ perIp: 1, siteWide: 1 }); // a fresh cap of ONE (signing up spent none, confirming spent one)
    const token = unsubscribeToken(sub.id);
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    const foreign = signUnsubscribeToken(sub.id, 'some-other-secret-that-was-never-configured-1');

    for (let i = 0; i < 5; i += 1) expect(peekUnsubscribeToken(token)).toBe(true);
    expect(peekUnsubscribeToken(tampered)).toBe(false);
    expect(peekUnsubscribeToken(foreign)).toBe(false);
    expect(peekUnsubscribeToken('x.y')).toBe(false);
    expect(peekUnsubscribeToken(null)).toBe(false);

    expect((await row('peek-unsub@example.com')).status).toBe('confirmed');
    expect(await getDb().select().from(newsletterSuppression)).toHaveLength(0);

    const res = await unsubscribe(token);
    expect(res.status).toBe(200);
    expect(data(res.env)).toEqual({ unsubscribed: true, alreadyUnsubscribed: false });
    expect((await row('peek-unsub@example.com')).status).toBe('unsubscribed');
    const suppressions = await getDb().select().from(newsletterSuppression);
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0]).toMatchObject({ reason: 'unsubscribed', source: 'email_link' });
  });

  it('the POST routes stay rate-limited and a bad signature is a 404 that changes nothing', async () => {
    const sub = await confirmed('limit@example.com');
    resetNewsletterLinkRateLimiterForTests({ perIp: 2, siteWide: 100 });
    const bad = await unsubscribe(signUnsubscribeToken(sub.id, 'x'.repeat(40)));
    expect(bad.status).toBe(404);
    expect((await row('limit@example.com')).status).toBe('confirmed');
    expect((await unsubscribe(unsubscribeToken(sub.id))).status).toBe(200);
    const limited = await unsubscribe(unsubscribeToken(sub.id));
    expect(limited.status).toBe(429);
    expect(limited.env.ok).toBe(false);
  });
});

// --- (2) BLOG0_UNSUBSCRIBE_SECRET ---------------------------------------------------------------

describe('BLOG0_UNSUBSCRIBE_SECRET end to end', () => {
  const UNSUB = 'a-dedicated-unsubscribe-secret-for-tests-1';

  it('without it the session secret signs and is the only verifier', () => {
    const secrets = unsubscribeVerifySecrets();
    expect(secrets).toHaveLength(1);
    expect(verifyUnsubscribeToken(unsubscribeToken('00000000-0000-4000-8000-000000000001'), secrets)).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('with it: new links are signed with it, session-signed links still work, and rotating the session secret only breaks the latter', async () => {
    const sub = await confirmed('rotate@example.com');
    const legacyToken = unsubscribeToken(sub.id); // signed with the session secret (nothing configured yet)
    setEnv('BLOG0_UNSUBSCRIBE_SECRET', UNSUB);

    const dedicated = unsubscribeToken(sub.id);
    expect(dedicated).not.toBe(legacyToken);
    expect(verifyUnsubscribeToken(dedicated, UNSUB)).toBe(sub.id);
    expect(verifyUnsubscribeToken(dedicated, process.env.BLOG0_SESSION_SECRET as string)).toBeNull();
    expect(unsubscribeVerifySecrets()).toEqual([UNSUB, process.env.BLOG0_SESSION_SECRET]);
    expect(peekUnsubscribeToken(dedicated)).toBe(true);
    expect(peekUnsubscribeToken(legacyToken)).toBe(true); // adding the secret did not break old mail

    // rotate the session secret: the dedicated link survives, the old session-signed one no longer verifies
    setEnv('BLOG0_SESSION_SECRET', 'a-brand-new-session-secret-after-the-rotation-1234');
    expect(peekUnsubscribeToken(dedicated)).toBe(true);
    expect(peekUnsubscribeToken(legacyToken)).toBe(false);
    const stale = await unsubscribe(legacyToken);
    expect(stale.status).toBe(404);
    expect((await row('rotate@example.com')).status).toBe('confirmed');

    const ok = await unsubscribe(dedicated);
    expect(ok.status).toBe(200);
    expect((await row('rotate@example.com')).status).toBe('unsubscribed');
  });

  it('the confirmation email carries a link signed with the unsubscribe secret', async () => {
    setEnv('BLOG0_UNSUBSCRIBE_SECRET', UNSUB);
    await signup('signed@example.com');
    const sub = await row('signed@example.com');
    const [message] = await getDb().select().from(newsletterMessage).where(eq(newsletterMessage.subscriberId, sub.id));
    const t = new URL(/href="([^"]*\/newsletter\/unsubscribe\?t=[^"]+)"/.exec(message.html)?.[1] as string).searchParams.get('t') as string;
    expect(verifyUnsubscribeToken(t, UNSUB)).toBe(sub.id);
  });
});

// --- (4) confirmation token redaction ----------------------------------------------------------

describe('confirmation messages are stored without the token', () => {
  it('signup: the stored html/text carry /newsletter/confirm?t=[redacted] and never the token; the transport log keeps the real link and it confirms', async () => {
    const token = (await signup('redact@example.com')) as string;
    const sub = await row('redact@example.com');
    const [message] = await getDb().select().from(newsletterMessage).where(and(eq(newsletterMessage.subscriberId, sub.id), eq(newsletterMessage.kind, 'confirmation')));

    expect(message.html).toContain('/newsletter/confirm?t=[redacted]');
    expect(message.text).toContain('/newsletter/confirm?t=[redacted]');
    expect(message.html).not.toContain(token);
    expect(message.text).not.toContain(token);
    const everything = JSON.stringify(await getDb().select().from(newsletterMessage));
    expect(everything).not.toContain(token);

    const line = logs.find('newsletter.mail').at(-1)!;
    expect(line.confirm_url).toBe(`http://localhost:3410/newsletter/confirm?t=${token}`);
    expect((await confirm(token)).status).toBe(200);
    expect((await row('redact@example.com')).status).toBe('confirmed');
  });

  it('admin send-confirmation (resend) redacts too, while the log line keeps confirm_url', async () => {
    const [pending] = await getDb()
      .insert(newsletterSubscriber)
      .values({ siteId: currentSite.id, email: 'resend@example.com', status: 'pending', source: 'footer' })
      .returning();
    const res = await call<SendConfirmationResponse>(sendConfirmationRoute, 'POST', `/api/admin/subscribers/${pending.id}/send-confirmation`, { id: pending.id, body: {} });
    expect(res.status).toBe(200);

    const token = new URL(logs.find('newsletter.mail').at(-1)!.confirm_url as string).searchParams.get('t') as string;
    const [message] = await getDb().select().from(newsletterMessage).where(eq(newsletterMessage.subscriberId, pending.id));
    expect(token).toHaveLength(43);
    expect(message.html).toContain('/newsletter/confirm?t=[redacted]');
    expect(message.html + message.text).not.toContain(token);
  });
});

// --- (3b) privacy link + postal address in mail and issues -------------------------------------

const patchSite = (body: unknown) => call<SiteSettingsResponse>(siteRoute, 'PATCH', '/api/admin/site', { body });
const ADDRESS = 'smallTech, 1 Example Street\nMumbai 400001';

async function publishNew(title: string) {
  const created = await createArticle({ title, topic: 'Analysis', dek: `${title} — the dek.`, bodyMd: BODY });
  const { status, env } = await publish(created.id, created.currentRevision.id);
  expect(status).toBe(200);
  return data(env).article;
}

async function addConfirmed(email: string) {
  const [r] = await getDb()
    .insert(newsletterSubscriber)
    .values({ siteId: currentSite.id, email, status: 'confirmed', source: 'footer', consentText: 'c', consentVersion: 'v1', consentedAt: new Date(), confirmedAt: new Date() })
    .returning();
  return r;
}

describe('privacy link and postal address (fix pass)', () => {
  it('the confirmation email links /privacy; the address appears only once set', async () => {
    await signup('no-address@example.com');
    const [plain] = await getDb().select().from(newsletterMessage).where(eq(newsletterMessage.kind, 'confirmation'));
    expect(plain.html).toContain(`href="${privacyUrl()}"`);
    expect(plain.text).toContain(`Privacy: ${privacyUrl()}`);
    expect(plain.html).not.toContain('Example Street');

    expect((await patchSite({ newsletterPostalAddress: ADDRESS })).status).toBe(200);
    await signup('with-address@example.com');
    const sub = await row('with-address@example.com');
    const [withAddress] = await getDb().select().from(newsletterMessage).where(eq(newsletterMessage.subscriberId, sub.id));
    expect(withAddress.html).toContain('smallTech, 1 Example Street<br>Mumbai 400001');
    expect(withAddress.text).toContain(ADDRESS);
  });

  it('issue preview: warns while the address is empty, links /privacy, prints the address once set', async () => {
    const article = await publishNew('Footer matters');
    const issue = data((await call<IssueDetailResponse>(createIssueRoute, 'POST', '/api/admin/newsletter/issues', { body: { title: 'Footer matters', articleIds: [article.id] } })).env).issue;
    expect(issue.warnings).toEqual(['postal_address_missing']);

    const empty = data((await call<IssuePreviewDto>(previewRoute, 'GET', `/api/admin/newsletter/issues/${issue.id}/preview`, { id: issue.id })).env);
    expect(empty.warnings).toEqual(['postal_address_missing']);
    expect(empty.html).toContain(`href="${privacyUrl()}"`);
    expect(empty.text).toContain(`Privacy: ${privacyUrl()}`);
    expect(empty.html).not.toContain('Example Street');

    expect((await patchSite({ newsletterPostalAddress: ADDRESS })).status).toBe(200);
    const filled = data((await call<IssuePreviewDto>(previewRoute, 'GET', `/api/admin/newsletter/issues/${issue.id}/preview`, { id: issue.id })).env);
    expect(filled.warnings).toEqual([]);
    expect(filled.html).toContain('smallTech, 1 Example Street<br>Mumbai 400001');
    expect(filled.text).toContain(ADDRESS);
    expect(data((await call<IssueDetailResponse>(getIssueRoute, 'GET', `/api/admin/newsletter/issues/${issue.id}`, { id: issue.id })).env).issue.warnings).toEqual([]);
  });

  it('sending with an empty address warns but never blocks; the address, once set, is in the frozen bodies', async () => {
    await addConfirmed('r1@example.test');
    const article = await publishNew('Warn then send');
    const make = async (title: string) =>
      data((await call<IssueDetailResponse>(createIssueRoute, 'POST', '/api/admin/newsletter/issues', { body: { title, articleIds: [article.id] } })).env).issue;

    const first = await make('Without address');
    const sentFirst = await call<IssueDetailResponse>(sendRoute, 'POST', `/api/admin/newsletter/issues/${first.id}/send`, { id: first.id, body: { confirm: true } });
    expect(sentFirst.status).toBe(200);
    expect(data(sentFirst.env).issue).toMatchObject({ status: 'sent', warnings: ['postal_address_missing'] });
    const [m1] = await getDb().select().from(newsletterMessage).where(and(eq(newsletterMessage.issueId, first.id), eq(newsletterMessage.kind, 'issue')));
    expect(m1.html).toContain(`href="${privacyUrl()}"`);
    expect(m1.html).not.toContain('Example Street');

    await patchSite({ newsletterPostalAddress: ADDRESS });
    const second = await make('With address');
    const sentSecond = await call<IssueDetailResponse>(sendRoute, 'POST', `/api/admin/newsletter/issues/${second.id}/send`, { id: second.id, body: { confirm: true } });
    expect(data(sentSecond.env).issue).toMatchObject({ status: 'sent', warnings: [] });
    const [m2] = await getDb().select().from(newsletterMessage).where(and(eq(newsletterMessage.issueId, second.id), eq(newsletterMessage.kind, 'issue')));
    expect(m2.html).toContain('smallTech, 1 Example Street<br>Mumbai 400001');
    expect(m2.text).toContain(ADDRESS);
    expect(m2.html).not.toContain('%%BLOG0_');
  });
});

// --- (3c) erasure through the admin route (owner decision 2026-10-19: delete + hashed marker) ----

const EMAIL = 'erase.route@example.com';
const IP = '203.0.113.77';
const UA = 'EraseRoute/3.1 (very-identifying-agent)';
const SOURCE = '/p/erase-route-source';
const NAME = 'Route Eraser';
const PII = [EMAIL, 'erase.route', IP, UA, NAME, SOURCE];
const NEWSLETTER_TABLES = [
  'newsletter_subscriber',
  'newsletter_subscriber_event',
  'newsletter_suppression',
  'newsletter_message',
  'newsletter_issue',
  'newsletter_issue_event',
  'newsletter_erasure_marker',
  'newsletter_erasure_log',
];

const erase = (id: string, body: unknown) => call<SubscriberEraseResponse>(eraseRoute, 'POST', `/api/admin/subscribers/${id}/erase`, { id, body });

/** Every row of one table (optionally filtered), as one lower-cased blob. */
async function tableBlob(table: string, where = 'true'): Promise<string> {
  const rows = rowsOf<{ j: string }>(await getDb().execute(dsql.raw(`select to_jsonb(t)::text as j from ${table} t where ${where}`)));
  return rows.map((r) => r.j).join('\n').toLowerCase();
}

/** Every row that belongs to the subscriber, as one lower-cased blob. */
async function footprint(id: string): Promise<string> {
  const parts: string[] = [];
  for (const [table, where] of [
    ['newsletter_subscriber', `id = '${id}'`],
    ['newsletter_subscriber_event', `subscriber_id = '${id}'`],
    ['newsletter_suppression', `subscriber_id = '${id}'`],
    ['newsletter_message', `subscriber_id = '${id}'`],
  ] as const) {
    parts.push(await tableBlob(table, where));
  }
  return parts.join('\n');
}

/** Every newsletter table, minus the bystander's own rows (they legitimately hold the bystander's data). */
async function newsletterBlobExcept(bystanderId: string | null): Promise<string> {
  const parts: string[] = [];
  for (const t of NEWSLETTER_TABLES) {
    const where =
      bystanderId === null ? 'true' : t === 'newsletter_subscriber' ? `id <> '${bystanderId}'` : ['newsletter_subscriber_event', 'newsletter_suppression', 'newsletter_message'].includes(t) ? `subscriber_id is distinct from '${bystanderId}'` : 'true';
    parts.push(await tableBlob(t, where));
  }
  return parts.join('\n');
}

/** The reader's full life: signup → confirm → unsubscribe link → signup again → confirm again. */
async function livedSubscriber() {
  const headers = { 'x-forwarded-for': IP, 'user-agent': UA };
  const first = (await signup(EMAIL, { ip: IP, ua: UA, name: NAME, sourceUrl: SOURCE })) as string;
  expect((await confirm(first, headers)).status).toBe(200);
  const sub = await row(EMAIL);
  expect((await unsubscribe(unsubscribeToken(sub.id), headers)).status).toBe(200);
  const second = (await signup(EMAIL, { ip: IP, ua: UA, name: NAME, sourceUrl: SOURCE })) as string;
  expect((await confirm(second, headers)).status).toBe(200);
  const after = await row(EMAIL);
  expect(after.status).toBe('confirmed');
  expect(after.signupIp).toBe(IP);
  return after;
}

class RecordingSender implements NewsletterSender {
  async trackingPublic() {
    return true;
  }
  kind: 'stub' | 'listmonk' = 'stub';
  readonly inner = new StubNewsletterSender({ recordToDb: false });
  removed: string[] = [];
  deletes: Array<{ providerId: string | null; email: string | null }> = [];
  fail = false;
  healthcheck() {
    return this.inner.healthcheck();
  }
  syncSubscriber(...a: Parameters<NewsletterSender['syncSubscriber']>) {
    return this.inner.syncSubscriber(...a);
  }
  async removeSubscriber(email: string) {
    this.removed.push(email);
    if (this.fail) throw new Error(`provider exploded for ${email}`);
    return this.inner.removeSubscriber(email);
  }
  findSubscriberId(email: string) {
    return this.inner.findSubscriberId(email);
  }
  async deleteSubscriber(target: Parameters<NewsletterSender['deleteSubscriber']>[0]) {
    this.deletes.push({ providerId: target.providerId, email: target.email });
    if (this.fail) throw new Error(`Listmonk unreachable at http://localhost:9000: provider exploded for ${target.email ?? 'id ' + target.providerId}`);
    return this.inner.deleteSubscriber(target);
  }
  createIssue(i: SenderIssue) {
    return this.inner.createIssue(i);
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

async function exports() {
  const headers = { cookie: admin.cookie, host: 'localhost:3410' };
  const list = data((await call<SubscriberListResponse>(listRoute, 'GET', '/api/admin/subscribers')).env);
  const csv = await (await listRoute(new Request(`${ORIGIN}/api/admin/subscribers?format=csv`, { headers }), ctx)).text();
  const audit = await (await listRoute(new Request(`${ORIGIN}/api/admin/subscribers?format=audit`, { headers }), ctx)).text();
  return { list, csv, audit };
}

describe('POST /api/admin/subscribers/:id/erase', () => {
  it('a wrong confirmation address → 400 VALIDATION_FAILED and nothing changes; a missing body → 400', async () => {
    const sub = await livedSubscriber();
    const before = await footprint(sub.id);

    const wrong = await erase(sub.id, { confirmEmail: 'someone.else@example.com' });
    const missing = await erase(sub.id, {});
    const extra = await erase(sub.id, { confirmEmail: EMAIL, force: true });

    for (const res of [wrong, missing, extra]) {
      expect(res.status).toBe(400);
      expect(err(res.env).code).toBe('VALIDATION_FAILED');
    }
    expect(JSON.stringify(wrong.env)).not.toContain(EMAIL);
    expect(await footprint(sub.id)).toBe(before);
    expect(logs.find('newsletter.erase')).toHaveLength(0);
  });

  it('deletes the subscriber: no newsletter table holds the address, IP or user agent; a PII-free audit row remains; the person is gone from the list, CSV and audit export; the log line carries no address', async () => {
    const sender = new RecordingSender();
    resetNewsletterSenderForTests(sender);
    const sub = await livedSubscriber();
    const bystander = await confirmed('bystander@example.com', { ip: '198.51.100.9', ua: 'Bystander/2.0' });
    const bystanderBefore = await footprint(bystander.id);
    expect(await footprint(sub.id)).toContain(EMAIL); // the scan would catch it

    const res = await erase(sub.id, { confirmEmail: `  ${EMAIL.toUpperCase()} ` });

    expect(res.status).toBe(200);
    const body = data(res.env);
    expect(body).toMatchObject({ deleted: true, provider: 'skipped', providerError: null, providerRetry: false }); // stub sender
    expect(body.erasureId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sender.deletes).toEqual([{ providerId: sub.providerId, email: EMAIL }]); // the stub copy goes too

    // nothing personal anywhere in the newsletter tables (apart from the bystander's own rows)
    const blob = await newsletterBlobExcept(bystander.id);
    for (const needle of PII) expect(blob, `still holds ${needle}`).not.toContain(needle.toLowerCase());
    expect(await footprint(sub.id)).toBe('\n\n\n'); // four empty scans: the rows are gone
    expect(await row(EMAIL)).toBeUndefined();

    // the marker + the audit row (who, when, how much; provider outcome recorded)
    const [marker] = await getDb().select().from(newsletterErasureMarker);
    expect(marker.emailHash).toBe(erasureHash(currentSite.newsletterEraseSalt, EMAIL));
    const [audit] = await getDb().select().from(newsletterErasureLog);
    expect(audit).toMatchObject({ id: body.erasureId, source: 'admin', erasedBy: admin.user.id, providerOutcome: 'skipped', emailHash: marker.emailHash });
    expect(audit.details).toMatchObject({ subscribers: 1, suppressions: 1 });
    expect(audit.providerCheckedAt).not.toBeNull();

    // the log: outcome without any personal data
    const lines = logs.find('newsletter.erase');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ subscriber_id: sub.id, erasure_id: body.erasureId, outcome: 'deleted', provider: 'skipped', user_id: admin.user.id });
    expect(JSON.stringify(lines).toLowerCase()).not.toContain('erase.route');
    expect(JSON.stringify(logs.lines).toLowerCase()).not.toContain(`"${EMAIL}"`);

    // the list and both exports: the person is gone, the erasure is proven without PII
    const { list, csv, audit: auditJson } = await exports();
    expect(list.subscribers.map((x) => x.email)).toEqual(['bystander@example.com']);
    expect(list.counts.all).toBe(1);
    expect(csv.toLowerCase()).not.toContain('erase.route');
    expect(auditJson.toLowerCase()).not.toContain('erase.route');
    expect(auditJson).not.toContain(marker.emailHash);
    const bundle = JSON.parse(auditJson) as NewsletterAuditBundle;
    expect(bundle.erasures).toEqual([
      expect.objectContaining({ id: body.erasureId, source: 'admin', erasedBy: 'Desk Admin', providerOutcome: 'skipped', deleted: expect.objectContaining({ subscribers: 1 }) }),
    ]);

    // the unrelated subscriber is untouched; the detail page of the deleted one is a 404
    expect(await footprint(bystander.id)).toBe(bystanderBefore);
    expect(await footprint(bystander.id)).toContain('bystander@example.com');
    expect((await call<SubscriberDetailResponse>(detailRoute, 'GET', `/api/admin/subscribers/${sub.id}`, { id: sub.id })).status).toBe(404);
  });

  it('erase → re-subscribe → confirm → erase again succeeds (the 0004 bug was a 500 here); one marker, two audit rows', async () => {
    const sub = await livedSubscriber();
    expect((await erase(sub.id, { confirmEmail: EMAIL })).status).toBe(200);

    const token = (await signup(' ERASE.Route@Example.COM ', { ip: IP, ua: UA })) as string;
    const fresh = await row(EMAIL);
    expect(fresh.id).not.toBe(sub.id);
    expect(fresh).toMatchObject({ status: 'pending', confirmedAt: null });
    const signupEvent = (await getDb().select().from(newsletterSubscriberEvent).where(and(eq(newsletterSubscriberEvent.subscriberId, fresh.id), eq(newsletterSubscriberEvent.kind, 'signup'))))[0];
    expect(signupEvent.details).toMatchObject({ erasedBefore: true, resignup: true });
    expect((await confirm(token)).status).toBe(200);
    expect((await row(EMAIL)).status).toBe('confirmed');

    const again = await erase(fresh.id, { confirmEmail: EMAIL });
    expect(again.status).toBe(200);
    expect(data(again.env)).toMatchObject({ deleted: true });
    expect(await row(EMAIL)).toBeUndefined();
    expect(await getDb().select().from(newsletterErasureMarker)).toHaveLength(1);
    expect(await getDb().select().from(newsletterErasureLog)).toHaveLength(2);
    const blob = await newsletterBlobExcept(null);
    for (const needle of PII) expect(blob, `still holds ${needle}`).not.toContain(needle.toLowerCase());
  });

  it('an unknown or already deleted id → 404 naming it; a Listmonk failure never undoes blog0 (deleted, provider failed + named, warn, retried by the tick by id until done)', async () => {
    const sender = new RecordingSender();
    sender.kind = 'listmonk';
    resetNewsletterSenderForTests(sender);
    const sub = await livedSubscriber();
    await sender.inner.syncSubscriber({ ...senderSubscriberFrom(sub, currentSite) }); // the provider holds a copy
    const providerId = await sender.inner.findSubscriberId(EMAIL);
    expect(providerId).not.toBeNull();
    sender.fail = true;

    const res = await erase(sub.id, { confirmEmail: EMAIL });
    expect(res.status).toBe(200);
    const body = data(res.env);
    expect(body).toMatchObject({ deleted: true, provider: 'failed', providerRetry: true });
    expect(body.providerError).toContain('Listmonk unreachable');
    expect(body.providerError).not.toContain(EMAIL);
    expect(await footprint(sub.id)).not.toContain(EMAIL);
    const warn = logs.find('newsletter.erase').at(0)!;
    expect(warn).toMatchObject({ provider: 'failed', outcome: 'deleted', level: 'warn', provider_retry: true });
    expect(JSON.stringify(warn)).not.toContain(EMAIL);
    const [audit] = await getDb().select().from(newsletterErasureLog);
    expect(audit).toMatchObject({ providerOutcome: 'failed', providerRef: providerId });

    // already deleted / unknown / malformed → 404
    const twice = await erase(sub.id, { confirmEmail: EMAIL });
    expect(twice.status).toBe(404);
    expect(err(twice.env).message).toContain('already have been deleted');
    expect((await erase('00000000-0000-4000-8000-000000000000', { confirmEmail: 'x@example.com' })).status).toBe(404);
    expect((await erase('not-a-uuid', { confirmEmail: 'x@example.com' })).status).toBe(404);

    // the tick retries by id (no address — blog0 no longer has it); still failing → stays failed
    let tick = await runTick(currentSite.id, { sender });
    expect(tick.erasuresRetried).toBe(0);
    expect(tick.errors.some((e) => e.startsWith('erasures:'))).toBe(true);
    expect(sender.deletes.at(-1)).toEqual({ providerId, email: null });
    sender.fail = false;
    tick = await runTick(currentSite.id, { sender });
    expect(tick.erasuresRetried).toBe(1);
    expect((await getDb().select().from(newsletterErasureLog))[0].providerOutcome).toBe('deleted');
    expect(await sender.inner.findSubscriberId(EMAIL)).toBeNull();
    // done rows are never retried again
    tick = await runTick(currentSite.id, { sender });
    expect(tick.erasuresRetried).toBe(0);
  });

  it('a retry never deletes the Listmonk copy of someone who signed up again since (kept)', async () => {
    const sender = new RecordingSender();
    sender.kind = 'listmonk';
    resetNewsletterSenderForTests(sender);
    const sub = await livedSubscriber();
    await sender.inner.syncSubscriber(senderSubscriberFrom(sub, currentSite));
    const providerId = (await sender.inner.findSubscriberId(EMAIL))!;
    sender.fail = true;
    expect(data((await erase(sub.id, { confirmEmail: EMAIL })).env).provider).toBe('failed');
    sender.fail = false;
    // the reader signs up again and is re-synced: like Listmonk (one record per address), the provider
    // record under the SAME id now carries the new blog0 subscriber id
    const fresh = await confirmed(EMAIL);
    sender.inner.subscribers.set(providerId, senderSubscriberFrom(fresh, currentSite));

    const tick = await runTick(currentSite.id, { sender });

    expect(tick.erasuresRetried).toBe(1);
    expect((await getDb().select().from(newsletterErasureLog))[0].providerOutcome).toBe('kept');
    expect(sender.inner.subscribers.get(providerId)?.subscriberId).toBe(fresh.id);
  });

  it('a database failure is named and deletes nothing (500 ERASE_FAILED, no address in the message)', async () => {
    const sub = await livedSubscriber();
    const before = await footprint(sub.id);
    // the 0004-era failure mode: make the function's DELETE refuse (an unexpected suppression row of
    // another subscriber holding this address — the ledger guard raises and the transaction rolls back)
    const other = await confirmed('someone.else@example.com');
    await getDb().insert(newsletterSuppression).values({ siteId: currentSite.id, subscriberId: other.id, email: EMAIL, reason: 'admin', source: 'admin' });

    const res = await erase(sub.id, { confirmEmail: EMAIL });

    expect(res.status).toBe(500);
    expect(err(res.env).code).toBe('ERASE_FAILED');
    expect(err(res.env).message).toMatch(/^The database refused the deletion \(newsletter ledger is append-only: DELETE on newsletter_suppression refused\)\. Nothing was deleted/);
    expect(JSON.stringify(res.env)).not.toContain(EMAIL);
    expect(await footprint(sub.id)).toBe(before);
    expect(await getDb().select().from(newsletterErasureLog)).toHaveLength(0);
    expect(logs.find('newsletter.erase').at(0)).toMatchObject({ outcome: 'failed', level: 'error' });
  });

  it('requires an admin session and the site origin', async () => {
    const sub = await livedSubscriber();
    const anon = await call<SubscriberEraseResponse>(eraseRoute, 'POST', `/api/admin/subscribers/${sub.id}/erase`, { id: sub.id, body: { confirmEmail: EMAIL }, cookie: null });
    const cross = await call<SubscriberEraseResponse>(eraseRoute, 'POST', `/api/admin/subscribers/${sub.id}/erase`, { id: sub.id, body: { confirmEmail: EMAIL }, origin: 'https://evil.example' });
    expect(anon.status).toBe(401);
    expect(cross.status).toBe(403);
    expect((await row(EMAIL)).status).toBe('confirmed');
  });

  it('the marker blocks silent re-adding: a direct import of the erased address as confirmed is refused; sync and provider suppressions never bring it back', async () => {
    const sender = new RecordingSender();
    sender.kind = 'listmonk'; // not the stub: syncAll walks every row
    const synced: string[] = [];
    sender.syncSubscriber = async (s) => {
      synced.push(s.email);
      return { providerId: 'p1', changed: false };
    };
    const sub = await livedSubscriber();
    await erase(sub.id, { confirmEmail: EMAIL });

    // an import / restore script inserting the address straight in as confirmed or legacy
    for (const status of ['confirmed', 'legacy_unconfirmed'] as const) {
      const refused = await getDb()
        .insert(newsletterSubscriber)
        .values({ siteId: currentSite.id, email: EMAIL, status, source: 'legacy' })
        .then(() => '')
        .catch((e: Error & { cause?: Error }) => `${e.message} ${e.cause?.message ?? ''}`);
      expect(refused, status).toMatch(/was erased — it can only be re-added by a new double opt-in signup/);
    }
    // the provider reporting an opt-out for the address never creates a row
    const { suppressByEmail } = await import('@/server/newsletter/service');
    expect(await suppressByEmail(currentSite.id, EMAIL, { reason: 'unsubscribed', source: 'provider' })).toMatchObject({ accepted: false, subscriber: null });
    // the full sync has nothing of the person to send
    const { syncAll } = await import('@/server/newsletter/sender/sync');
    const result = await syncAll('script', { sender });
    expect(synced).not.toContain(EMAIL);
    expect(result.errors).toEqual([]);
    expect(await row(EMAIL)).toBeUndefined();
  });

  it('issue numbers survive: a delivered issue keeps its stats after a recipient is deleted', async () => {
    resetNewsletterSenderForTests(new StubNewsletterSender({ recordToDb: true }));
    const sub = await livedSubscriber();
    await confirmed('bystander@example.com');
    const article = await publishNew('Erasure keeps the counts');
    const created = data((await call<IssueDetailResponse>(createIssueRoute, 'POST', '/api/admin/newsletter/issues', { body: { title: 'Counts', articleIds: [article.id] } })).env).issue;
    expect((await call<IssueDetailResponse>(sendRoute, 'POST', `/api/admin/newsletter/issues/${created.id}/send`, { id: created.id, body: { confirm: true } })).status).toBe(200);
    const before = data((await call<IssueDetailResponse>(getIssueRoute, 'GET', `/api/admin/newsletter/issues/${created.id}`, { id: created.id })).env).issue;
    expect(before.recipientCount).toBe(2);

    expect((await erase(sub.id, { confirmEmail: EMAIL })).status).toBe(200);

    const { refreshStats } = await import('@/server/newsletter/issues/send');
    await refreshStats(currentSite.id, created.id, { userId: null });
    const after = data((await call<IssueDetailResponse>(getIssueRoute, 'GET', `/api/admin/newsletter/issues/${created.id}`, { id: created.id })).env).issue;
    expect(after.recipientCount).toBe(2);
    expect(after.stats).toMatchObject({ recipients: 2, sent: 2 });
    const left = await getDb().select().from(newsletterMessage).where(and(eq(newsletterMessage.issueId, created.id), eq(newsletterMessage.kind, 'issue')));
    expect(left.map((m) => m.toEmail)).toEqual(['bystander@example.com']);
  });
});
