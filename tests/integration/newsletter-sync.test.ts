// blog0 → Listmonk sync + the Listmonk-backed issue path against a REAL Listmonk container
// (docker-compose.yml; spec/architecture.md §13.3 "Sync", §13.5 send.ts; capability
// newsletter-issues.md success criteria). Covers syncAll counts + idempotence (a second run changes
// no blog0 row), `pnpm newsletter:sync` itself, the live hooks after confirm / unsubscribe, a real
// campaign sent from an issue, stats, and `pnpm newsletter:tick` pulling a provider blocklist into a
// blog0 suppression.
// Runs ONLY against the TEST stack (docker-compose.yml profile `test`: listmonk-test on :9001,
// SMTP → Mailpit). Stack not up ⇒ the file SKIPS visibly naming `pnpm listmonk:test-up` — never a
// pass. Sink guard: unless every enabled SMTP server of the instance is the Mailpit sink the suite
// FAILS loudly before any campaign is created (campaigns sent here are real sends).
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as sendRoute } from '@/app/api/admin/newsletter/issues/[id]/send/route';
import { POST as statsRoute } from '@/app/api/admin/newsletter/issues/[id]/stats/route';
import { POST as createIssueRoute } from '@/app/api/admin/newsletter/issues/route';
import { GET as settingsGetRoute } from '@/app/api/admin/newsletter/settings/route';
import { POST as syncRoute } from '@/app/api/admin/newsletter/sync/route';
import type { IssueDetailResponse, NewsletterSettingsResponse, NewsletterSyncResponse } from '@/lib/api/dto';
import { resetConfigForTests } from '@/server/config';
import { getDb, rowsOf } from '@/server/db/client';
import { newsletterSubscriber, newsletterSubscriberEvent, newsletterSuppression, type SiteRow } from '@/server/db/schema';
import { runTick } from '@/server/newsletter/issues/tick';
import { consentLine, unsubscribeToken, unsubscribeUrl } from '@/server/newsletter/links';
import { resetMailTransportForTests } from '@/server/newsletter/mail';
import { resetNewsletterSenderForTests } from '@/server/newsletter/sender';
import { syncAll } from '@/server/newsletter/sender/sync';
import { confirmByToken, subscribe, unsubscribeByToken } from '@/server/newsletter/service';

import { actAs, call, createArticle, data, publish } from '../helpers/api';
import { resetDb } from '../helpers/db';
import { getTestDatabaseUrl } from '../helpers/env';
import { assertListmonkSmtpIsSink, LISTMONK_TEST_STACK_DOWN_REASON, listmonkRaw, mailpit, probeListmonkTestStack, type ListmonkTestEnv } from '../helpers/listmonk';
import { captureLogs } from '../helpers/logs';
import { loginAs } from '../helpers/session';

const stack = await probeListmonkTestStack();
if (stack === null) console.warn(`newsletter-sync.test.ts skipped — ${LISTMONK_TEST_STACK_DOWN_REASON}`);

const run = Date.now().toString(36);
const emailOf = (tag: string) => `s73-${run}-${tag}@example.test`;
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const LISTMONK_VARS = ['BLOG0_NEWSLETTER_SENDER', 'BLOG0_LISTMONK_URL', 'BLOG0_LISTMONK_API_USER', 'BLOG0_LISTMONK_API_TOKEN', 'BLOG0_LISTMONK_LIST_ID'] as const;
const BODY = 'Listmonk carries the issue. blog0 keeps the list, the consent and the send log.\n\nA second paragraph for the reader.';

describe.skipIf(stack === null)(`blog0 → Listmonk sync and sends against the test stack (listmonk-test → Mailpit)${stack ? '' : ` — ${LISTMONK_TEST_STACK_DOWN_REASON}`}`, () => {
  let env: ListmonkTestEnv;
  let raw: ReturnType<typeof listmonkRaw>;
  let currentSite: SiteRow;
  const saved = new Map<string, string | undefined>();
  const createdEmails = new Set<string>();
  const createdCampaigns = new Set<string>();

  async function add(tag: string, status: 'pending' | 'confirmed' | 'unsubscribed' | 'legacy_unconfirmed', at = new Date(), name: string | null = `Reader ${tag}`) {
    const email = emailOf(tag);
    createdEmails.add(email);
    const [row] = await getDb()
      .insert(newsletterSubscriber)
      .values({
        siteId: currentSite.id,
        email,
        name,
        status,
        consentText: 'One issue a week at most.',
        consentVersion: 'v1',
        consentedAt: at,
        signupSourceUrl: '/',
        confirmedAt: status === 'confirmed' || status === 'unsubscribed' ? at : null,
        unsubscribedAt: status === 'unsubscribed' ? at : null,
      })
      .returning();
    return row;
  }

  /** md5 of every newsletter list row, in a stable order — "no blog0 row changed". */
  async function checksum(): Promise<string> {
    const q = (table: string) =>
      getDb().execute(sql.raw(`select coalesce(md5(string_agg(t::text, '|' order by t.id)), '') as h from "${table}" t`));
    const parts: string[] = [];
    for (const t of ['newsletter_subscriber', 'newsletter_subscriber_event', 'newsletter_suppression']) {
      parts.push(rowsOf<{ h: string }>(await q(t))[0]?.h ?? '');
    }
    return parts.join(':');
  }

  beforeAll(async () => {
    env = stack!;
    await assertListmonkSmtpIsSink(env); // throws ⇒ every test fails; nothing below runs
    raw = listmonkRaw(env);
    for (const k of LISTMONK_VARS) saved.set(k, process.env[k]);
    process.env.BLOG0_NEWSLETTER_SENDER = 'listmonk';
    process.env.BLOG0_LISTMONK_URL = env.url;
    process.env.BLOG0_LISTMONK_API_USER = env.apiUser;
    process.env.BLOG0_LISTMONK_API_TOKEN = env.apiToken;
    process.env.BLOG0_LISTMONK_LIST_ID = String(env.listId);
    resetConfigForTests();
    resetNewsletterSenderForTests();
  });

  afterAll(async () => {
    for (const id of createdCampaigns) await raw.deleteCampaign(id).catch(() => undefined);
    for (const email of createdEmails) await raw.deleteSubscriberByEmail(email).catch(() => undefined);
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    process.env.BLOG0_NEWSLETTER_SENDER = 'stub';
    resetConfigForTests();
    resetNewsletterSenderForTests();
  });

  beforeEach(async () => {
    currentSite = await resetDb();
    resetMailTransportForTests();
    resetNewsletterSenderForTests();
    actAs(await loginAs({ email: 'desk@example.test', displayName: 'Desk Admin' }));
  });

  it('syncAll: 2 confirmed, 1 pending, 1 unsubscribed → synced 2, blocklisted 1, skipped 1; a second run changes nothing anywhere', async () => {
    const c1 = await add('c1', 'confirmed');
    // no name: Listmonk derives one from the address — a re-sync must still be a no-op
    const c2 = await add('c2', 'confirmed', new Date(), null);
    await add('p1', 'pending');
    const u1 = await add('u1', 'unsubscribed');

    const first = await syncAll('script');
    expect(first).toEqual({ synced: 2, blocklisted: 1, skipped: 1, suppressedFromProvider: 0, changed: 3, errors: [] });

    const remote1 = await raw.subscriberByEmail(c1.email);
    expect(remote1).toMatchObject({ status: 'enabled', name: 'Reader c1' });
    expect(remote1!.attribs).toMatchObject({
      blog0_subscriber_id: c1.id,
      blog0_unsubscribe_url: unsubscribeUrl(c1.id),
      blog0_consent_line: consentLine(c1, currentSite),
      consent_version: 'v1',
      signup_source_url: '/',
    });
    expect(remote1!.lists).toEqual(expect.arrayContaining([expect.objectContaining({ id: env.listId, subscription_status: 'confirmed' })]));
    expect((await raw.subscriberByEmail(c2.email))!.status).toBe('enabled');
    expect((await raw.subscriberByEmail(u1.email))!.status).toBe('blocklisted');
    expect(await raw.subscriberByEmail(emailOf('p1'))).toBeNull();

    const rows = await getDb().select().from(newsletterSubscriber);
    expect(rows.find((r) => r.id === c1.id)).toMatchObject({ providerId: String(remote1!.id), status: 'confirmed' });
    expect(rows.find((r) => r.id === c1.id)?.providerSyncedAt).not.toBeNull();
    expect(rows.find((r) => r.email === emailOf('p1'))?.providerSyncedAt).toBeNull();
    const kinds = (await getDb().select().from(newsletterSubscriberEvent)).map((e) => `${e.email}:${e.kind}`).sort();
    expect(kinds).toEqual([`${c1.email}:provider_synced`, `${c2.email}:provider_synced`, `${u1.email}:provider_removed`].sort());

    const before = await checksum();
    expect(before).toMatch(/^[0-9a-f]{32}:[0-9a-f]{32}:/); // subscribers + events (no suppression rows in this setup)
    const second = await syncAll('script');
    expect(second).toEqual({ synced: 0, blocklisted: 0, skipped: 1, suppressedFromProvider: 0, changed: 0, errors: [] });
    expect(await checksum()).toBe(before);
    expect(rows.every((r) => r.status === (r.email === emailOf('p1') ? 'pending' : r.email === u1.email ? 'unsubscribed' : 'confirmed'))).toBe(true);
  });

  it('pnpm newsletter:sync prints the counts and is idempotent (second run "0 changed"); POST …/sync answers the same', async () => {
    await add('s1', 'confirmed');
    await add('s2', 'confirmed');
    await add('s3', 'pending');
    await add('s4', 'unsubscribed');
    const childEnv = { ...process.env, BLOG0_DATABASE_URL: getTestDatabaseUrl(), BLOG0_LOG_LEVEL: 'warn' };
    const tsx = path.join(ROOT, 'node_modules', '.bin', 'tsx');
    const sync = () => promisify(execFile)(tsx, ['scripts/newsletter-sync.ts'], { cwd: ROOT, env: childEnv, timeout: 120_000 });

    const first = await sync();
    const before = await checksum();
    const second = await sync();

    expect(first.stdout).toContain('synced 2, blocklisted 1, skipped 1, 3 changed');
    expect(second.stdout).toContain('synced 0, blocklisted 0, skipped 1, 0 changed');
    expect(`${first.stdout}${second.stdout}${first.stderr}${second.stderr}`).not.toContain(env.apiToken);
    expect(await checksum()).toBe(before);

    const viaRoute = await call<NewsletterSyncResponse>(syncRoute, 'POST', '/api/admin/newsletter/sync', { body: { confirm: true } });
    expect(data(viaRoute.env)).toEqual({ synced: 0, blocklisted: 0, skipped: 1, suppressedFromProvider: 0, changed: 0, errors: [] });

    const status = data((await call<NewsletterSettingsResponse>(settingsGetRoute, 'GET', '/api/admin/newsletter/settings')).env).status;
    expect(status.sender).toMatchObject({ kind: 'listmonk', configured: true, healthy: true, listId: String(env.listId), listName: 'blog0-test' });
    expect(status.sender.lastSyncAt).not.toBeNull();
  });

  it('live hooks: confirm → enabled at Listmonk; unsubscribe link → blocklisted; re-subscribe + confirm → enabled again', async () => {
    const email = emailOf('live');
    createdEmails.add(email);
    const logs = captureLogs();
    const tokenFromLog = () => new URL(logs.find('newsletter.mail').at(-1)!.confirm_url as string).searchParams.get('t') as string;
    try {
      await subscribe({ ip: 'direct', userAgent: 'vitest' }, { email, name: null, sourceUrl: '/' });
      const confirmed = await confirmByToken(tokenFromLog(), { ip: 'direct', userAgent: 'vitest' });
      expect((await raw.subscriberByEmail(email))!.status).toBe('enabled');

      await unsubscribeByToken(unsubscribeToken(confirmed.subscriber.id), 'email_link', { ip: 'direct', userAgent: 'vitest' });
      expect((await raw.subscriberByEmail(email))!.status).toBe('blocklisted');

      await subscribe({ ip: 'direct', userAgent: 'vitest' }, { email, name: null, sourceUrl: '/' });
      await confirmByToken(tokenFromLog(), { ip: 'direct', userAgent: 'vitest' });
      const remote = await raw.subscriberByEmail(email);
      expect(remote!.status).toBe('enabled');
      expect(remote!.lists).toEqual(expect.arrayContaining([expect.objectContaining({ id: env.listId, subscription_status: 'confirmed' })]));

      const kinds = (await getDb().select().from(newsletterSubscriberEvent).where(eq(newsletterSubscriberEvent.subscriberId, confirmed.subscriber.id))).map((e) => e.kind);
      expect(kinds.filter((k) => k.startsWith('provider_'))).toEqual(['provider_synced', 'provider_removed', 'provider_synced']);
      expect(logs.find('newsletter.sync').some((l) => l.trigger === 'confirm' && l.sender === 'listmonk')).toBe(true);
    } finally {
      logs.stop();
    }
  });

  it('send through Listmonk: a real campaign with the issue title + attribute expressions, status sent, stats are numbers', async () => {
    await add('send1', 'confirmed');
    const created = await createArticle({ title: `S73 issue ${run}`, topic: 'Analysis', bodyMd: BODY });
    await publish(created.id, created.currentRevision.id);
    const issue = data((await call<IssueDetailResponse>(createIssueRoute, 'POST', '/api/admin/newsletter/issues', { body: { title: `S73 issue ${run}`, articleIds: [created.id] } })).env).issue;

    const { status, env: res } = await call<IssueDetailResponse>(sendRoute, 'POST', `/api/admin/newsletter/issues/${issue.id}/send`, { id: issue.id, body: { confirm: true } });
    const sent = data(res).issue;
    createdCampaigns.add(sent.providerCampaignId as string);

    expect(status).toBe(200);
    expect(sent).toMatchObject({ status: 'sent', recipientCount: 1 });
    expect(sent.providerCampaignId).toMatch(/^\d+$/);
    expect(sent.events.map((e) => e.kind)).toEqual(['created', 'send_requested', 'provider_created', 'provider_started', 'sent']);

    const campaign = await raw.campaign(sent.providerCampaignId as string);
    expect(['running', 'finished']).toContain(campaign.status);
    expect(campaign.subject).toBe(`S73 issue ${run}`);
    expect(campaign.body).toContain(`S73 issue ${run}`);
    expect(campaign.body).toContain('{{ .Subscriber.Attribs.blog0_unsubscribe_url }}');
    expect(campaign.altbody).toContain('{{ .Subscriber.Attribs.blog0_consent_line }}');
    expect(campaign.tags).toEqual(expect.arrayContaining(['blog0', `issue:${issue.id}`]));

    // Delivered — into Mailpit, the only SMTP the test stack has.
    const delivered = await mailpit(env).waitForMessagesTo(emailOf('send1'));
    expect(delivered.map((m) => m.Subject)).toContain(`S73 issue ${run}`);
    await mailpit(env).deleteMessages(delivered.map((m) => m.ID));

    const withStats = data((await call<IssueDetailResponse>(statsRoute, 'POST', `/api/admin/newsletter/issues/${issue.id}/stats`, { id: issue.id, body: {} })).env).issue;
    expect(typeof withStats.stats?.recipients).toBe('number');
    expect(typeof withStats.stats?.sent).toBe('number');
    expect(withStats.stats?.delivered).toBeNull();
  });

  it('newsletter:tick pulls a Listmonk blocklist into a blog0 suppression (source provider), once', async () => {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const sub = await add('tick1', 'confirmed', hourAgo);
    await syncAll('script');
    const remote = await raw.subscriberByEmail(sub.email);
    await raw.call('PUT', '/api/subscribers/blocklist', { ids: [remote!.id] });

    const first = await runTick(currentSite.id);
    const [row] = await getDb().select().from(newsletterSubscriber).where(eq(newsletterSubscriber.id, sub.id));
    const supp = await getDb().select().from(newsletterSuppression).where(eq(newsletterSuppression.subscriberId, sub.id));

    expect(first.errors).toEqual([]);
    expect(first.suppressionsPulled).toBeGreaterThanOrEqual(1);
    expect(row.status).toBe('unsubscribed');
    expect(supp).toHaveLength(1);
    expect(supp[0]).toMatchObject({ reason: 'unsubscribed', source: 'provider' });

    const second = await runTick(currentSite.id);
    expect(second.errors).toEqual([]);
    expect(await getDb().select().from(newsletterSuppression).where(eq(newsletterSuppression.subscriberId, sub.id))).toHaveLength(1);
  });
  /** What Listmonk does for the List-Unsubscribe header / its own unsubscribe page: list subscription `unsubscribed`, no blocklist. */
  async function listUnsubscribeAtListmonk(email: string): Promise<number> {
    const remote = await raw.subscriberByEmail(email);
    await raw.call('PUT', '/api/subscribers/lists', { ids: [remote!.id], action: 'unsubscribe', target_list_ids: [env.listId] });
    return remote!.id;
  }

  const membership = async (email: string) => (await raw.subscriberByEmail(email))!.lists.find((l) => l.id === env.listId)?.subscription_status;

  it('a list-level unsubscribe in Listmonk → newsletter:tick suppresses in blog0 → sync never re-adds; a fresh re-confirmation re-adds', async () => {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const sub = await add('lu1', 'confirmed', hourAgo, null);
    expect((await syncAll('script')).synced).toBe(1);
    expect(await membership(sub.email)).toBe('confirmed');
    await listUnsubscribeAtListmonk(sub.email);
    expect((await raw.subscriberByEmail(sub.email))!.status).toBe('enabled');

    const tick = await runTick(currentSite.id);
    expect(tick.errors).toEqual([]);
    expect(tick.suppressionsPulled).toBeGreaterThanOrEqual(1);
    const [row] = await getDb().select().from(newsletterSubscriber).where(eq(newsletterSubscriber.id, sub.id));
    expect(row.status).toBe('unsubscribed');
    const supp = await getDb().select().from(newsletterSuppression).where(eq(newsletterSuppression.subscriberId, sub.id));
    expect(supp).toHaveLength(1);
    expect(supp[0]).toMatchObject({ reason: 'unsubscribed', source: 'provider', details: expect.objectContaining({ optOut: 'list_unsubscribed', listId: env.listId }) });

    // the full sync leaves the membership alone (blocklist only) — never re-subscribed
    const synced = await syncAll('script');
    expect(synced.errors).toEqual([]);
    expect(synced.synced).toBe(0);
    expect(await membership(sub.email)).toBe('unsubscribed');
    expect((await raw.subscriberByEmail(sub.email))!.status).toBe('blocklisted');
    expect((await runTick(currentSite.id)).errors).toEqual([]);
    expect(await getDb().select().from(newsletterSuppression).where(eq(newsletterSuppression.subscriberId, sub.id))).toHaveLength(1);

    // a fresh double opt-in in blog0 after the opt-out → re-enabled and re-added, and stays so
    const logs = captureLogs();
    try {
      await subscribe({ ip: 'direct', userAgent: 'vitest' }, { email: sub.email, name: null, sourceUrl: '/' });
      const token = new URL(logs.find('newsletter.mail').at(-1)!.confirm_url as string).searchParams.get('t') as string;
      await confirmByToken(token, { ip: 'direct', userAgent: 'vitest' });
    } finally {
      logs.stop();
    }
    expect((await raw.subscriberByEmail(sub.email))!.status).toBe('enabled');
    expect(await membership(sub.email)).toBe('confirmed');
    expect(await syncAll('script')).toEqual({ synced: 0, blocklisted: 0, skipped: 0, suppressedFromProvider: 0, changed: 0, errors: [] });
    expect((await runTick(currentSite.id)).errors).toEqual([]);
    const [after] = await getDb().select().from(newsletterSubscriber).where(eq(newsletterSubscriber.id, sub.id));
    expect(after.status).toBe('confirmed');
  });

  it('sync without a tick: a newer provider opt-out is recorded in blog0 as suppressed_from_provider, not re-added; a newer blog0 confirmation re-adds', async () => {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const optedOut = await add('lu2', 'confirmed', hourAgo);
    const reconfirmed = await add('lu3', 'confirmed', hourAgo);
    expect((await syncAll('script')).synced).toBe(2);
    await listUnsubscribeAtListmonk(optedOut.email);
    await listUnsubscribeAtListmonk(reconfirmed.email);
    // lu3 confirms again in blog0 after its provider opt-out (a fresh double opt-in); 1.1 s covers
    // the container clock running up to ~100 ms apart from the host's
    await new Promise((r) => setTimeout(r, 1100));
    const fresh = new Date();
    await getDb().update(newsletterSubscriber).set({ consentedAt: fresh, confirmedAt: fresh }).where(eq(newsletterSubscriber.id, reconfirmed.id));

    const logs = captureLogs();
    let result: NewsletterSyncResponse;
    try {
      result = await syncAll('script');
    } finally {
      logs.stop();
    }
    expect(result).toEqual({ synced: 1, blocklisted: 0, skipped: 0, suppressedFromProvider: 1, changed: 1, errors: [] });
    expect(logs.find('newsletter.sync').some((l) => l.suppressed_from_provider === 1)).toBe(true);

    const rows = await getDb().select().from(newsletterSubscriber);
    expect(rows.find((r) => r.id === optedOut.id)?.status).toBe('unsubscribed');
    expect(rows.find((r) => r.id === reconfirmed.id)?.status).toBe('confirmed');
    const supp = await getDb().select().from(newsletterSuppression);
    expect(supp).toEqual([expect.objectContaining({ subscriberId: optedOut.id, reason: 'unsubscribed', source: 'provider', details: expect.objectContaining({ optOut: 'list_unsubscribed', trigger: 'script' }) })]);
    expect(await membership(optedOut.email)).toBe('unsubscribed');
    expect(await membership(reconfirmed.email)).toBe('confirmed');
    expect((await raw.subscriberByEmail(reconfirmed.email))!.status).toBe('enabled');

    // idempotent from here on: nothing more to suppress, nothing re-added
    const before = await checksum();
    expect(await syncAll('script')).toEqual({ synced: 0, blocklisted: 0, skipped: 0, suppressedFromProvider: 0, changed: 0, errors: [] });
    expect(await checksum()).toBe(before);
    expect(await membership(optedOut.email)).toBe('unsubscribed');
  });
});
