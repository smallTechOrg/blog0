import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Secret } from '@/server/config';
import { BLOG0_TEMPLATE_BODY, BLOG0_TEMPLATE_NAME, ListmonkSender, SenderError, type SenderSubscriber } from '@/server/newsletter/sender';
import { CONSENT_PLACEHOLDER, UNSUBSCRIBE_PLACEHOLDER } from '@/server/newsletter/sender/types';

import { captureLogs } from '../helpers/logs';
import { dockerReachable, listmonkRaw, PENDING_DOCKER_REASON, readListmonkDevEnv, type ListmonkDevEnv } from '../helpers/listmonk';

// The Listmonk adapter against a REAL Listmonk v5.1.0 container (docker-compose.yml, spec/architecture.md
// §12.6 + §13.3; newsletter-issues.md success criteria). Adapter-only: no blog0 tables are touched.
// Skip rule (spec/roadmap.md Phase 7): no Docker daemon ⇒ the whole file SKIPS with a visible
// `PENDING DOCKER` reason — never a pass; Docker up but var/listmonk-dev.env missing ⇒ FAIL
// ("run pnpm listmonk:up"). Nothing is delivered: compose leaves Listmonk's SMTP unconfigured.

const docker = dockerReachable();
// Visible in every reporter: the skipped file is "pending docker", never a pass.
if (!docker) console.warn(`newsletter-listmonk.test.ts skipped — ${PENDING_DOCKER_REASON}`);
const run = Date.now().toString(36);
const emailOf = (tag: string) => `s72-${run}-${tag}@example.test`;

function subscriber(tag: string, overrides: Partial<SenderSubscriber> = {}): SenderSubscriber {
  const id = `00000000-0000-4000-8000-${run.padStart(12, '0').slice(-12)}`;
  return {
    subscriberId: `${id}-${tag}`,
    email: emailOf(tag),
    name: `Sub ${tag}`,
    status: 'enabled',
    attribs: {
      blog0_subscriber_id: `${id}-${tag}`,
      blog0_unsubscribe_url: `http://localhost:3410/newsletter/unsubscribe?t=tok-${tag}`,
      blog0_consent_line: 'You’re getting this because you subscribed at blog0 on 1 Oct 2026 and confirmed on 2 Oct 2026.',
      consent_version: 'v1',
      consented_at: '2026-10-01T10:00:00.000Z',
      confirmed_at: '2026-10-02T10:00:00.000Z',
      signup_source_url: '/',
    },
    ...overrides,
  };
}

describe.skipIf(!docker)(`Listmonk adapter against the compose container${docker ? '' : ` — ${PENDING_DOCKER_REASON}`}`, () => {
  let env: ListmonkDevEnv;
  let sender: ListmonkSender;
  let raw: ReturnType<typeof listmonkRaw>;
  const createdEmails = new Set<string>();
  const createdCampaigns = new Set<string>();

  beforeAll(async () => {
    const read = readListmonkDevEnv();
    if (read === null) {
      throw new Error('Docker is running but var/listmonk-dev.env is missing or incomplete — run pnpm listmonk:up');
    }
    env = read;
    sender = new ListmonkSender({ url: env.url, apiUser: env.apiUser, apiToken: new Secret(env.apiToken), listId: env.listId });
    raw = listmonkRaw(env);
  });

  afterAll(async () => {
    for (const id of createdCampaigns) await raw.deleteCampaign(id);
    for (const email of createdEmails) await raw.deleteSubscriberByEmail(email);
  });

  it('healthcheck: ok with the list name; an unknown list id reports ok: false', async () => {
    const health = await sender.healthcheck();
    expect(health).toEqual({ ok: true, message: expect.stringContaining('blog0-test'), listName: 'blog0-test' });

    const wrongList = new ListmonkSender({ url: env.url, apiUser: env.apiUser, apiToken: new Secret(env.apiToken), listId: 987_654 });
    expect(await wrongList.healthcheck()).toEqual({ ok: false, message: 'list 987654 not found' });
  });

  it('syncSubscriber twice → one Listmonk subscriber with the consent attribs, enabled, in the list; second call changed: false', async () => {
    const s = subscriber('a');
    createdEmails.add(s.email);
    const logs = captureLogs();
    try {
      const first = await sender.syncSubscriber(s);
      expect(first.changed).toBe(true);
      expect(first.providerId).toMatch(/^\d+$/);

      const second = await sender.syncSubscriber(s);
      expect(second).toEqual({ providerId: first.providerId, changed: false });

      const row = await raw.subscriberByEmail(s.email);
      expect(row).not.toBeNull();
      expect(String(row!.id)).toBe(first.providerId);
      expect(row!.status).toBe('enabled');
      expect(row!.name).toBe('Sub a');
      expect(row!.attribs).toMatchObject({
        blog0_subscriber_id: s.subscriberId,
        blog0_unsubscribe_url: s.attribs.blog0_unsubscribe_url,
        blog0_consent_line: s.attribs.blog0_consent_line,
        consent_version: 'v1',
        signup_source_url: '/',
      });
      expect(row!.lists).toEqual([expect.objectContaining({ id: env.listId, subscription_status: 'confirmed' })]);

      // a changed attribute (rotated unsubscribe link) is pushed and reported
      const rotated = { ...s, attribs: { ...s.attribs, blog0_unsubscribe_url: 'http://localhost:3410/newsletter/unsubscribe?t=rotated' } };
      expect(await sender.syncSubscriber(rotated)).toEqual({ providerId: first.providerId, changed: true });
      expect((await raw.subscriberByEmail(s.email))!.attribs.blog0_unsubscribe_url).toBe('http://localhost:3410/newsletter/unsubscribe?t=rotated');

      // every call is logged without the token or the full address
      const lines = logs.find('newsletter.provider');
      expect(lines.length).toBeGreaterThanOrEqual(4);
      const dumped = JSON.stringify(lines);
      expect(dumped).not.toContain(env.apiToken);
      expect(dumped).not.toContain(s.email);
      expect(lines[0]).toMatchObject({ provider: 'listmonk', method: 'GET', path: '/api/subscribers', status: 200, outcome: 'ok' });
    } finally {
      logs.stop();
    }
  });

  it('removeSubscriber → blocklisted (idempotent); unknown email → changed: false; a re-sync re-enables and re-confirms the list membership', async () => {
    const s = subscriber('b');
    createdEmails.add(s.email);
    await sender.syncSubscriber(s);

    expect(await sender.removeSubscriber(s.email)).toEqual({ changed: true });
    expect(await sender.removeSubscriber(s.email)).toEqual({ changed: false });
    expect((await raw.subscriberByEmail(s.email))!.status).toBe('blocklisted');

    expect(await sender.removeSubscriber(emailOf('never-synced'))).toEqual({ changed: false });

    // blocklisted input through syncSubscriber is the same blocklist call
    const c = subscriber('c', { status: 'blocklisted' });
    createdEmails.add(c.email);
    const blocked = await sender.syncSubscriber(c);
    expect(blocked.changed).toBe(true);
    expect((await raw.subscriberByEmail(c.email))!.status).toBe('blocklisted');
    expect(await sender.syncSubscriber(c)).toEqual({ providerId: blocked.providerId, changed: false });

    // re-confirmation in blog0 → enabled again, and the list subscription is confirmed again
    const again = await sender.syncSubscriber(s);
    expect(again.changed).toBe(true);
    const row = await raw.subscriberByEmail(s.email);
    expect(row!.status).toBe('enabled');
    expect(row!.lists).toEqual([expect.objectContaining({ id: env.listId, subscription_status: 'confirmed' })]);
    expect(await sender.syncSubscriber(s)).toEqual({ providerId: again.providerId, changed: false });
  });

  it('createIssue + sendIssue → a campaign on the blog0 template, running/finished within 60 s; sendIssue is idempotent; fetchStats returns numbers', async () => {
    const d = subscriber('d');
    createdEmails.add(d.email);
    await sender.syncSubscriber(d);

    const issue = {
      issueId: `11111111-2222-4333-8444-${run.padStart(12, '0').slice(-12)}`,
      number: 42,
      subject: `S7.2 probe ${run}`,
      html: `<p>Hello from blog0 — ${run}</p><p><a href="${UNSUBSCRIBE_PLACEHOLDER}">Unsubscribe</a></p><p>${CONSENT_PLACEHOLDER}</p>`,
      text: `Hello from blog0 — ${run}\nUnsubscribe: ${UNSUBSCRIBE_PLACEHOLDER}\n${CONSENT_PLACEHOLDER}\n`,
    };
    const { campaignId } = await sender.createIssue(issue);
    createdCampaigns.add(campaignId);
    expect(campaignId).toMatch(/^\d+$/);

    const created = await raw.campaign(campaignId);
    expect(created.status).toBe('draft');
    expect(created.name).toBe(`blog0 #42 — S7.2 probe ${run}`);
    expect(created.subject).toBe(issue.subject);
    expect(created.tags).toEqual(['blog0', `issue:${issue.issueId}`]);
    expect(created.body).toContain(`Hello from blog0 — ${run}`);
    expect(created.body).toContain('{{ .Subscriber.Attribs.blog0_unsubscribe_url }}');
    expect(created.body).toContain('{{ .Subscriber.Attribs.blog0_consent_line }}');
    expect(created.body).not.toContain('%%BLOG0_');
    expect(created.altbody).toContain('{{ .Subscriber.Attribs.blog0_unsubscribe_url }}');
    const templates = await raw.call<Array<{ id: number; name: string; body: string }>>('GET', '/api/templates');
    const tpl = templates.find((t) => t.id === created.template_id);
    expect(tpl).toMatchObject({ name: BLOG0_TEMPLATE_NAME, body: BLOG0_TEMPLATE_BODY });

    // a second createIssue reuses the template (no duplicate)
    const second = await sender.createIssue({ ...issue, number: 43, subject: `S7.2 probe ${run} #2` });
    createdCampaigns.add(second.campaignId);
    expect((await raw.campaign(second.campaignId)).template_id).toBe(created.template_id);
    expect((await raw.call<Array<{ name: string }>>('GET', '/api/templates')).filter((t) => t.name === BLOG0_TEMPLATE_NAME)).toHaveLength(1);

    await sender.sendIssue(campaignId);
    const deadline = Date.now() + 60_000;
    let status = (await raw.campaign(campaignId)).status;
    while (!['running', 'finished'].includes(status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      status = (await raw.campaign(campaignId)).status;
    }
    expect(['running', 'finished']).toContain(status);

    await expect(sender.sendIssue(campaignId)).resolves.toBeUndefined(); // no-op: Listmonk would answer 400 otherwise

    const stats = await sender.fetchStats(campaignId);
    expect(stats).toEqual({
      recipients: expect.any(Number),
      sent: expect.any(Number),
      delivered: null,
      opens: expect.any(Number),
      clicks: expect.any(Number),
      bounces: expect.any(Number),
      unsubscribes: null,
    });
    expect(stats.recipients).toBeGreaterThanOrEqual(1);
  });

  it('fetchSuppressions(since) lists the blocklisted address as unsubscribed (and not those blocklisted before `since`)', async () => {
    const e = subscriber('e');
    createdEmails.add(e.email);
    await sender.syncSubscriber(e);
    const before = new Date(Date.now() - 1000);
    await new Promise((r) => setTimeout(r, 1100));
    const since = new Date();
    await new Promise((r) => setTimeout(r, 1100));
    await sender.removeSubscriber(e.email);

    const recent = await sender.fetchSuppressions(since);
    const mine = recent.find((s) => s.email === e.email);
    expect(mine).toMatchObject({ email: e.email, reason: 'unsubscribed', details: { providerId: expect.stringMatching(/^\d+$/) } });
    expect(mine!.at.getTime()).toBeGreaterThan(since.getTime());
    for (const s of recent) expect(['unsubscribed', 'bounced', 'complaint']).toContain(s.reason);

    const earlier = await sender.fetchSuppressions(before);
    expect(earlier.some((s) => s.email === e.email)).toBe(true);
    const future = await sender.fetchSuppressions(new Date(Date.now() + 60_000));
    expect(future.some((s) => s.email === e.email)).toBe(false);
  });

  it('error paths: bad token → SenderError HTTP 403, unknown campaign → HTTP 400, closed port → UNAVAILABLE after one retry', async () => {
    const badToken = new ListmonkSender({ url: env.url, apiUser: env.apiUser, apiToken: new Secret('not-the-token'), listId: env.listId });
    await expect(badToken.fetchStats('1')).rejects.toMatchObject({ name: 'SenderError', code: 'HTTP', httpStatus: 403 });
    expect((await badToken.healthcheck()).ok).toBe(false);

    await expect(sender.fetchStats('999999')).rejects.toMatchObject({ code: 'HTTP', httpStatus: 400 });
    await expect(sender.sendIssue('not-a-number')).rejects.toMatchObject({ code: 'INVALID' });

    const logs = captureLogs();
    try {
      const closed = new ListmonkSender({ url: 'http://127.0.0.1:1', apiUser: 'x', apiToken: new Secret('y'), listId: 1 });
      const error = await closed.removeSubscriber('nobody@example.test').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SenderError);
      expect((error as SenderError).code).toBe('UNAVAILABLE');
      const attempts = logs.find('newsletter.provider').map((l) => [l.attempt, l.outcome]);
      expect(attempts).toEqual([
        [1, 'retry'],
        [2, 'failed'],
      ]);
    } finally {
      logs.stop();
    }
  });
});
