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
  SubscriberDetailResponse,
  SubscriberEraseResponse,
} from '@/lib/api/dto';
import type { Envelope } from '@/lib/api/envelope';
import { resetConfigForTests } from '@/server/config';
import { getDb, rowsOf } from '@/server/db/client';
import { newsletterMessage, newsletterSubscriber, newsletterSubscriberEvent, newsletterSuppression, type SiteRow } from '@/server/db/schema';
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
      body: JSON.stringify({ email, name: opts.name, sourceUrl: opts.sourceUrl ?? '/' }),
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

// --- (3c) erasure through the admin route ------------------------------------------------------

const EMAIL = 'erase.route@example.com';
const IP = '203.0.113.77';
const UA = 'EraseRoute/3.1 (very-identifying-agent)';
const SOURCE = '/p/erase-route-source';
const NAME = 'Route Eraser';

const erase = (id: string, body: unknown) => call<SubscriberEraseResponse>(eraseRoute, 'POST', `/api/admin/subscribers/${id}/erase`, { id, body });

/** Every row that belongs to the subscriber, as one lower-cased blob. */
async function footprint(id: string): Promise<string> {
  const db = getDb();
  const parts: string[] = [];
  for (const [table, where] of [
    ['newsletter_subscriber', `id = '${id}'`],
    ['newsletter_subscriber_event', `subscriber_id = '${id}'`],
    ['newsletter_suppression', `subscriber_id = '${id}'`],
    ['newsletter_message', `subscriber_id = '${id}'`],
  ] as const) {
    const rows = rowsOf<{ j: string }>(await db.execute(dsql.raw(`select to_jsonb(t)::text as j from ${table} t where ${where}`)));
    parts.push(...rows.map((r) => r.j));
  }
  return parts.join('\n').toLowerCase();
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
  kind: 'stub' | 'listmonk' = 'stub';
  readonly inner = new StubNewsletterSender({ recordToDb: false });
  removed: string[] = [];
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

  it('erases: no raw address, IP, user agent, name or source URL remains in the subscriber, its events, suppressions or messages; the log line carries none either', async () => {
    const sender = new RecordingSender();
    resetNewsletterSenderForTests(sender);
    const sub = await livedSubscriber();
    const bystander = await confirmed('bystander@example.com', { ip: '198.51.100.9', ua: 'Bystander/2.0' });
    const bystanderBefore = await footprint(bystander.id);
    const suppressionsBefore = await getDb().select().from(newsletterSuppression).where(eq(newsletterSuppression.subscriberId, sub.id));
    expect(suppressionsBefore).toHaveLength(1);
    expect(await footprint(sub.id)).toContain(EMAIL); // the scan would catch it

    const res = await erase(sub.id, { confirmEmail: `  ${EMAIL.toUpperCase()} ` });

    expect(res.status).toBe(200);
    expect(data(res.env)).toEqual({ erased: true, providerRemoved: false }); // stub sender: nothing to remove
    expect(sender.removed).toEqual([EMAIL]); // asked once, BEFORE the address was redacted

    const blob = await footprint(sub.id);
    for (const needle of [EMAIL, 'erase.route', IP, UA, NAME, SOURCE]) expect(blob, `still holds ${needle}`).not.toContain(needle.toLowerCase());
    const tombstone = `erased+${erasureHash(currentSite.newsletterEraseSalt, EMAIL)}@erased.invalid`;
    const erased = await row(tombstone);
    expect(erased).toMatchObject({ id: sub.id, status: 'unsubscribed', name: null, signupIp: null, confirmedIp: null });

    const events = await getDb().select().from(newsletterSubscriberEvent).where(eq(newsletterSubscriberEvent.subscriberId, sub.id));
    const erasedEvents = events.filter((e) => e.kind === 'erased');
    expect(erasedEvents).toHaveLength(1);
    expect(erasedEvents[0]).toMatchObject({ ip: null, userAgent: null, details: {}, email: tombstone });
    const sups = await getDb().select().from(newsletterSuppression).where(eq(newsletterSuppression.subscriberId, sub.id));
    expect(sups.map((s) => s.reason).sort()).toEqual(['erased', 'unsubscribed']);

    // the log: outcome without any personal data
    const lines = logs.find('newsletter.erase');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ subscriber_id: sub.id, outcome: 'erased', provider: 'skipped', user_id: admin.user.id });
    const logBlob = JSON.stringify(logs.lines).toLowerCase();
    expect(logBlob).not.toContain(`"${EMAIL}"`);
    expect(JSON.stringify(lines)).not.toContain('erase.route');

    // the unrelated subscriber is untouched
    expect(await footprint(bystander.id)).toBe(bystanderBefore);
    expect(await footprint(bystander.id)).toContain('bystander@example.com');

    // the admin timeline shows the erased entry and nothing personal
    const detail = data((await call<SubscriberDetailResponse>(detailRoute, 'GET', `/api/admin/subscribers/${sub.id}`, { id: sub.id })).env).subscriber;
    expect(detail.email).toBe(tombstone);
    expect(detail.events.at(-1)!.kind).toBe('erased');
    expect(JSON.stringify(detail).toLowerCase()).not.toContain('erase.route');
  });

  it('a second erase → 409 SUBSCRIBER_NOT_ELIGIBLE; an unknown id → 404; a provider failure never fails the erase (providerRemoved false, warn)', async () => {
    const sender = new RecordingSender();
    sender.fail = true;
    resetNewsletterSenderForTests(sender);
    const sub = await livedSubscriber();

    const res = await erase(sub.id, { confirmEmail: EMAIL });
    expect(res.status).toBe(200);
    expect(data(res.env)).toEqual({ erased: true, providerRemoved: false });
    expect(await footprint(sub.id)).not.toContain(EMAIL);
    const warn = logs.find('newsletter.erase').at(0)!;
    expect(warn).toMatchObject({ provider: 'failed', outcome: 'erased', level: 'warn' });
    expect(JSON.stringify(warn)).not.toContain(EMAIL);

    const tombstone = (await getDb().select().from(newsletterSubscriber).where(eq(newsletterSubscriber.id, sub.id)))[0].email;
    const again = await erase(sub.id, { confirmEmail: tombstone });
    expect(again.status).toBe(409);
    expect(err(again.env).code).toBe('SUBSCRIBER_NOT_ELIGIBLE');
    expect((await erase('00000000-0000-4000-8000-000000000000', { confirmEmail: 'x@example.com' })).status).toBe(404);
    expect((await erase('not-a-uuid', { confirmEmail: 'x@example.com' })).status).toBe(404);
  });

  it('requires an admin session and the site origin', async () => {
    const sub = await livedSubscriber();
    const anon = await call<SubscriberEraseResponse>(eraseRoute, 'POST', `/api/admin/subscribers/${sub.id}/erase`, { id: sub.id, body: { confirmEmail: EMAIL }, cookie: null });
    const cross = await call<SubscriberEraseResponse>(eraseRoute, 'POST', `/api/admin/subscribers/${sub.id}/erase`, { id: sub.id, body: { confirmEmail: EMAIL }, origin: 'https://evil.example' });
    expect(anon.status).toBe(401);
    expect(cross.status).toBe(403);
    expect((await row(EMAIL)).status).toBe('confirmed');
  });

  it('re-signup of an erased address (any casing) is a NEW pending row that needs a fresh double opt-in; the erased row and its suppression stay', async () => {
    const sub = await livedSubscriber();
    expect((await erase(sub.id, { confirmEmail: EMAIL })).status).toBe(200);
    const tombstoneSuppressions = async () => (await getDb().select().from(newsletterSuppression).where(eq(newsletterSuppression.reason, 'erased'))).length;
    expect(await tombstoneSuppressions()).toBe(1);

    const token = (await signup(' ERASE.Route@Example.COM ', { ip: IP, ua: UA })) as string;
    const fresh = await row(EMAIL);

    expect(fresh.id).not.toBe(sub.id);
    expect(fresh).toMatchObject({ status: 'pending', confirmedAt: null });
    expect(fresh.confirmTokenHash).not.toBeNull();
    const signupEvent = (await getDb().select().from(newsletterSubscriberEvent).where(and(eq(newsletterSubscriberEvent.subscriberId, fresh.id), eq(newsletterSubscriberEvent.kind, 'signup'))))[0];
    expect(signupEvent.details).toMatchObject({ erasedBefore: true, resignup: true });
    expect(await tombstoneSuppressions()).toBe(1); // not a clean slate: the marker stays
    const stillErased = await getDb().select().from(newsletterSubscriber).where(eq(newsletterSubscriber.id, sub.id));
    expect(stillErased[0].email).toMatch(/^erased\+[0-9a-f]{64}@erased\.invalid$/);

    // nothing is mailed to the list until the reader clicks: still not confirmed, and confirming works as a normal first confirmation
    expect((await row(EMAIL)).status).toBe('pending');
    expect((await confirm(token)).status).toBe(200);
    expect((await row(EMAIL)).status).toBe('confirmed');
    expect(await tombstoneSuppressions()).toBe(1);

    // an address that was never erased has no erasedBefore flag
    await signup('never-erased@example.com');
    const clean = await row('never-erased@example.com');
    const cleanSignup = (await getDb().select().from(newsletterSubscriberEvent).where(eq(newsletterSubscriberEvent.subscriberId, clean.id)))[0];
    expect(cleanSignup.details).not.toHaveProperty('erasedBefore');
  });

  it('the full sync never sends a tombstone to the provider', async () => {
    const sender = new RecordingSender();
    sender.kind = 'listmonk'; // not the stub: syncAll walks every row
    const synced: string[] = [];
    sender.syncSubscriber = async (s) => {
      synced.push(s.email);
      return { providerId: 'p1', changed: false };
    };
    const sub = await livedSubscriber();
    await erase(sub.id, { confirmEmail: EMAIL });
    const { syncAll } = await import('@/server/newsletter/sender/sync');

    const result = await syncAll('script', { sender });

    expect(synced.some((e) => e.includes('erased.invalid'))).toBe(false);
    expect(result.errors).toEqual([]);
  });
});
