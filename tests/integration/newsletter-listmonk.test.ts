import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Secret } from '@/server/config';
import { BLOG0_TEMPLATE_BODY, BLOG0_TEMPLATE_NAME, ListmonkSender, SenderError, type SenderSubscriber } from '@/server/newsletter/sender';
import { CONSENT_PLACEHOLDER, UNSUBSCRIBE_PLACEHOLDER } from '@/server/newsletter/sender/types';

import { captureLogs } from '../helpers/logs';
import { assertListmonkSmtpIsSink, LISTMONK_TEST_STACK_DOWN_REASON, listmonkRaw, mailpit, probeListmonkTestStack, type ListmonkTestEnv } from '../helpers/listmonk';

// The Listmonk adapter against a REAL Listmonk v5.1.0 container — the TEST stack only
// (docker-compose.yml profile `test`: listmonk-test on :9001, SMTP → Mailpit; spec/architecture.md
// §12.6 + §13.3; newsletter-issues.md success criteria). Adapter-only: no blog0 tables are touched.
// Skip rule: the test stack is not up (var/listmonk-test.env missing or its token does not answer)
// ⇒ the whole file SKIPS with a visible reason naming `pnpm listmonk:test-up` — never a pass.
// Sink guard: before anything else, the instance's /api/settings must show ONLY the Mailpit sink as
// enabled SMTP — otherwise the suite FAILS loudly (campaigns started here are real sends).

const stack = await probeListmonkTestStack();
// Visible in every reporter: the skipped file names the command that starts the stack.
if (stack === null) console.warn(`newsletter-listmonk.test.ts skipped — ${LISTMONK_TEST_STACK_DOWN_REASON}`);
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

describe.skipIf(stack === null)(`Listmonk adapter against the test stack (listmonk-test → Mailpit)${stack ? '' : ` — ${LISTMONK_TEST_STACK_DOWN_REASON}`}`, () => {
  let env: ListmonkTestEnv;
  let sender: ListmonkSender;
  let raw: ReturnType<typeof listmonkRaw>;
  const createdEmails = new Set<string>();
  const createdCampaigns = new Set<string>();

  beforeAll(async () => {
    env = stack!;
    await assertListmonkSmtpIsSink(env); // throws ⇒ every test fails; nothing below runs
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
    const blockedRow = (await raw.subscriberByEmail(c.email))!;
    expect(blockedRow.status).toBe('blocklisted');
    expect(blockedRow.lists).toEqual([]); // a suppressed row never gets a list membership — blocklist only
    expect(await sender.syncSubscriber(c)).toEqual({ providerId: blocked.providerId, changed: false });

    // blog0's own blocklists carry the blog0 marker (they mirror a blog0 suppression, not a provider opt-out)
    expect((await raw.subscriberByEmail(s.email))!.attribs.blog0_blocklisted_at).toEqual(expect.any(String));
    expect(blockedRow.attribs.blog0_blocklisted_at).toEqual(expect.any(String));

    // re-confirmation in blog0 → enabled again, and the list subscription is confirmed again (blog0's own
    // blocklist never blocks blog0's later confirmation, whatever the clocks say); the marker is dropped
    const reconfirmed = s;
    const again = await sender.syncSubscriber(reconfirmed);
    expect(again.changed).toBe(true);
    expect(again.optOut).toBeUndefined();
    const row = await raw.subscriberByEmail(s.email);
    expect(row!.status).toBe('enabled');
    expect(row!.lists).toEqual([expect.objectContaining({ id: env.listId, subscription_status: 'confirmed' })]);
    expect(row!.attribs.blog0_blocklisted_at).toBeUndefined();
    expect(await sender.syncSubscriber(reconfirmed)).toEqual({ providerId: again.providerId, changed: false });
  });

  it('deleteSubscriber (erasure): by id → the record is DELETED (not blocklisted); by address when the id is unknown or stale; nothing there → not_found (done); a live re-signup is kept', async () => {
    const logs = captureLogs();
    try {
      // by the id blog0 remembered
      const a = subscriber('del-a');
      createdEmails.add(a.email);
      const { providerId } = await sender.syncSubscriber(a);
      expect(await sender.findSubscriberId(a.email)).toBe(providerId);
      expect(await sender.deleteSubscriber({ providerId, email: a.email })).toEqual({ outcome: 'deleted', providerId });
      expect(await raw.subscriberByEmail(a.email)).toBeNull(); // gone, not blocklisted
      expect(await sender.findSubscriberId(a.email)).toBeNull();
      // a retry of the same delete: Listmonk has nothing → not_found counts as done
      expect(await sender.deleteSubscriber({ providerId, email: null })).toEqual({ outcome: 'not_found', providerId });
      expect(await sender.deleteSubscriber({ providerId: null, email: a.email })).toEqual({ outcome: 'not_found', providerId: null });

      // no id known (never synced by blog0) → found by address; a blocklisted record is deleted too
      const b = subscriber('del-b', { status: 'blocklisted' });
      createdEmails.add(b.email);
      await sender.syncSubscriber(b);
      const byAddress = await sender.deleteSubscriber({ providerId: null, email: b.email });
      expect(byAddress.outcome).toBe('deleted');
      expect(await raw.subscriberByEmail(b.email)).toBeNull();

      // a stale id that now carries ANOTHER address is never deleted during an erase; the address wins
      const c = subscriber('del-c');
      const bystander = subscriber('del-bystander');
      createdEmails.add(c.email);
      createdEmails.add(bystander.email);
      await sender.syncSubscriber(c);
      const other = await sender.syncSubscriber(bystander);
      expect((await sender.deleteSubscriber({ providerId: other.providerId, email: c.email })).outcome).toBe('deleted');
      expect(await raw.subscriberByEmail(c.email)).toBeNull();
      expect(await raw.subscriberByEmail(bystander.email)).not.toBeNull();

      // the retry guard: the record belongs to a live blog0 subscriber → kept
      const kept = await sender.deleteSubscriber({ providerId: other.providerId, email: null, keep: async (id) => id === bystander.subscriberId });
      expect(kept).toEqual({ outcome: 'kept', providerId: other.providerId });
      expect(await raw.subscriberByEmail(bystander.email)).not.toBeNull();

      // the outcome is logged per call, never with an address
      const lines = logs.find('newsletter.provider').filter((l) => l.action === 'delete');
      expect(lines.map((l) => l.outcome)).toEqual(['deleted', 'not_found', 'not_found', 'deleted', 'deleted', 'kept']);
      expect(JSON.stringify(logs.lines)).not.toContain('@example.test');
    } finally {
      logs.stop();
    }
  });

  it('a list-level unsubscribe at Listmonk (subscriber stays enabled) → fetchSuppressions reports it; syncSubscriber never re-adds over it unless blog0 re-confirmed later', async () => {
    const f = subscriber('f', { attribs: { ...subscriber('f').attribs, consented_at: new Date(Date.now() - 3_600_000).toISOString(), confirmed_at: new Date(Date.now() - 3_600_000).toISOString() } });
    createdEmails.add(f.email);
    const { providerId } = await sender.syncSubscriber(f);
    const since = new Date();
    await new Promise((r) => setTimeout(r, 50));
    // what Listmonk does for the List-Unsubscribe header / its own unsubscribe page (no blocklist)
    await raw.call('PUT', '/api/subscribers/lists', { ids: [Number(providerId)], action: 'unsubscribe', target_list_ids: [env.listId] });
    const remote = (await raw.subscriberByEmail(f.email))!;
    expect(remote.status).toBe('enabled');
    expect(remote.lists).toEqual([expect.objectContaining({ id: env.listId, subscription_status: 'unsubscribed' })]);

    const found = (await sender.fetchSuppressions(since)).filter((x) => x.email === f.email);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ reason: 'unsubscribed', details: { providerId, providerStatus: 'enabled', optOut: 'list_unsubscribed', listId: env.listId } });
    expect(found[0]!.at.getTime()).toBeGreaterThan(since.getTime());
    expect((await sender.fetchSuppressions(new Date(Date.now() + 60_000))).some((x) => x.email === f.email)).toBe(false);

    // blog0's confirmation (an hour ago) is older than the opt-out: no re-add, no write, the opt-out is handed back
    const logs = captureLogs();
    try {
      const refused = await sender.syncSubscriber(f);
      expect(refused).toEqual({ providerId, changed: false, optOut: expect.objectContaining({ email: f.email, reason: 'unsubscribed', at: found[0]!.at }) });
      expect(logs.find('newsletter.provider').filter((l) => l.method === 'PUT')).toEqual([]);
      expect(logs.find('newsletter.provider').some((l) => l.outcome === 'provider_opt_out' && l.optOut === 'list_unsubscribed')).toBe(true);
    } finally {
      logs.stop();
    }
    expect((await raw.subscriberByEmail(f.email))!.lists).toEqual([expect.objectContaining({ id: env.listId, subscription_status: 'unsubscribed' })]);
    // an attribute change does not sneak a re-add through either
    const rotated = { ...f, attribs: { ...f.attribs, blog0_unsubscribe_url: 'http://localhost:3410/newsletter/unsubscribe?t=f2' } };
    expect((await sender.syncSubscriber(rotated)).optOut).toBeDefined();
    expect((await raw.subscriberByEmail(f.email))!.attribs.blog0_unsubscribe_url).toBe(f.attribs.blog0_unsubscribe_url);

    // a fresh double opt-in in blog0 after the opt-out → re-added, confirmed (1.1 s: the container's
    // clock runs up to ~100 ms apart from the host's)
    await new Promise((r) => setTimeout(r, 1100));
    const fresh = new Date().toISOString();
    const reconfirmed = { ...f, attribs: { ...f.attribs, consented_at: fresh, confirmed_at: fresh } };
    expect(await sender.syncSubscriber(reconfirmed)).toEqual({ providerId, changed: true });
    const back = (await raw.subscriberByEmail(f.email))!;
    expect(back.status).toBe('enabled');
    expect(back.lists).toEqual([expect.objectContaining({ id: env.listId, subscription_status: 'confirmed' })]);
    expect((await sender.fetchSuppressions(since)).some((x) => x.email === f.email)).toBe(false);
    expect(await sender.syncSubscriber(reconfirmed)).toEqual({ providerId, changed: false });
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

    // Delivered — into Mailpit, the only SMTP the test stack has.
    const delivered = await mailpit(env).waitForMessagesTo(d.email);
    expect(delivered.map((m) => m.Subject)).toContain(issue.subject);
    await mailpit(env).deleteMessages(delivered.map((m) => m.ID));

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

  it('an issue whose title / body carry literal Go-template braces ({{ x }}) → createIssue succeeds and Listmonk renders them literally (B4)', async () => {
    const title = `Templating with {{ x }} and }} {{ ${run}`;
    const issue = {
      issueId: `22222222-2222-4333-8444-${run.padStart(12, '0').slice(-12)}`,
      number: 77,
      subject: title,
      html: `<h1>${title}</h1><p>Use {{ .Subscriber.Email }} in a template.</p><p><a href="${UNSUBSCRIBE_PLACEHOLDER}">Unsubscribe</a></p><p>${CONSENT_PLACEHOLDER}</p>`,
      text: `${title}\nUse {{ .Subscriber.Email }} in a template.\nUnsubscribe: ${UNSUBSCRIBE_PLACEHOLDER}\n${CONSENT_PLACEHOLDER}\n`,
    };
    const { campaignId } = await sender.createIssue(issue);
    createdCampaigns.add(campaignId);
    const created = await raw.campaign(campaignId);
    // Baseline: the same body unescaped is refused by Listmonk's template compiler (what B4 fixed).
    await expect(
      raw.call('POST', '/api/campaigns', { name: `raw ${run}`, subject: 'raw', lists: [env.listId], type: 'regular', content_type: 'html', body: issue.html, template_id: created.template_id }),
    ).rejects.toThrow(/→ 400/);
    expect(created.body).toContain('{{ "{{" }} x {{ "}}" }}');
    expect(created.body).toContain('{{ .Subscriber.Attribs.blog0_unsubscribe_url }}');

    const preview = await raw.previewCampaign(campaignId);
    expect(preview).toContain(`<h1>${title}</h1>`);
    expect(preview).toContain('Use {{ .Subscriber.Email }} in a template.');
    expect(preview).not.toContain('{{ "{{" }}');
    expect(preview).not.toContain('%%BLOG0_');
  });

  it('fetchSuppressions(since) lists the blocklisted address as unsubscribed (and not those blocklisted before `since`)', async () => {
    const e = subscriber('e');
    createdEmails.add(e.email);
    await sender.syncSubscriber(e);
    const before = new Date(Date.now() - 1000);
    await new Promise((r) => setTimeout(r, 1100));
    const since = new Date();
    await new Promise((r) => setTimeout(r, 1100));
    // a blocklist made at Listmonk (its admin UI / API), not by blog0
    await raw.call('PUT', '/api/subscribers/blocklist', { ids: [(await raw.subscriberByEmail(e.email))!.id] });

    const recent = await sender.fetchSuppressions(since);
    const mine = recent.find((s) => s.email === e.email);
    expect(mine).toMatchObject({ email: e.email, reason: 'unsubscribed', details: { providerId: expect.stringMatching(/^\d+$/) } });
    expect(mine!.at.getTime()).toBeGreaterThan(since.getTime());
    for (const s of recent) expect(['unsubscribed', 'bounced', 'complaint']).toContain(s.reason);

    const earlier = await sender.fetchSuppressions(before);
    expect(earlier.some((s) => s.email === e.email)).toBe(true);
    const future = await sender.fetchSuppressions(new Date(Date.now() + 60_000));
    expect(future.some((s) => s.email === e.email)).toBe(false);

    // blog0's own blocklist (removeSubscriber) is blog0's state mirrored — never pulled back as a provider event
    const own = subscriber('e2');
    createdEmails.add(own.email);
    await sender.syncSubscriber(own);
    await sender.removeSubscriber(own.email);
    expect((await raw.subscriberByEmail(own.email))!.status).toBe('blocklisted');
    expect((await sender.fetchSuppressions(before)).some((s) => s.email === own.email)).toBe(false);
  });

  it('a blocklist made at Listmonk newer than blog0\'s confirmation → syncSubscriber refuses to re-enable and reports it; a newer blog0 confirmation re-enables + re-adds', async () => {
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const g = subscriber('g', { attribs: { ...subscriber('g').attribs, consented_at: hourAgo, confirmed_at: hourAgo } });
    createdEmails.add(g.email);
    const { providerId } = await sender.syncSubscriber(g);
    await raw.call('PUT', '/api/subscribers/blocklist', { ids: [Number(providerId)] });

    const refused = await sender.syncSubscriber(g);
    expect(refused).toMatchObject({ providerId, changed: false, optOut: { email: g.email, reason: 'unsubscribed', details: { optOut: 'blocklisted', providerStatus: 'blocklisted' } } });
    const still = (await raw.subscriberByEmail(g.email))!;
    expect(still.status).toBe('blocklisted');
    expect(still.lists).toEqual([expect.objectContaining({ id: env.listId, subscription_status: 'unsubscribed' })]);

    await new Promise((r) => setTimeout(r, 1100)); // container clock skew (see above)
    const fresh = new Date().toISOString();
    const reconfirmed = { ...g, attribs: { ...g.attribs, consented_at: fresh, confirmed_at: fresh } };
    expect(await sender.syncSubscriber(reconfirmed)).toEqual({ providerId, changed: true });
    const back = (await raw.subscriberByEmail(g.email))!;
    expect(back.status).toBe('enabled');
    expect(back.lists).toEqual([expect.objectContaining({ id: env.listId, subscription_status: 'confirmed' })]);
  });

  it('open + click tracking: content links go out as TrackLink (unsubscribe / privacy untracked), an outdated blog0-issue template is updated with TrackView, and a hit on the tracked link / pixel shows up in fetchStats', async () => {
    // An existing template with the pre-tracking body (what installs before this fix carry) is brought up to date.
    const templates = await raw.call<Array<{ id: number; name: string; type: string; body: string }>>('GET', '/api/templates');
    const existing = templates.find((t) => t.name === BLOG0_TEMPLATE_NAME && t.type === 'campaign');
    if (existing) await raw.call('PUT', `/api/templates/${existing.id}`, { name: BLOG0_TEMPLATE_NAME, type: 'campaign', body: '{{ template "content" . }}' });
    const fresh = new ListmonkSender({ url: env.url, apiUser: env.apiUser, apiToken: new Secret(env.apiToken), listId: env.listId });

    const t = subscriber('t');
    createdEmails.add(t.email);
    await fresh.syncSubscriber(t);

    const target = `https://example.test/p/tracked-${run}?a=1&b=2`;
    const issue = {
      issueId: `33333333-2222-4333-8444-${run.padStart(12, '0').slice(-12)}`,
      number: 91,
      subject: `tracking probe ${run}`,
      html: `<p><a href="${target.replace(/&/g, '&amp;')}">Read</a></p><p><a href="${UNSUBSCRIBE_PLACEHOLDER}">Unsubscribe</a> · <a href="https://example.test/privacy">Privacy</a> · <a href="mailto:hi@example.test">Mail</a></p><p>${CONSENT_PLACEHOLDER}</p>`,
      text: `Read: ${target}\nUnsubscribe: ${UNSUBSCRIBE_PLACEHOLDER}\n${CONSENT_PLACEHOLDER}\n`,
    };
    const { campaignId } = await fresh.createIssue(issue);
    createdCampaigns.add(campaignId);

    const created = await raw.call<{ uuid: string; body: string; altbody: string; template_id: number }>('GET', `/api/campaigns/${campaignId}`);
    expect(created.body).toContain(`href="{{ TrackLink "${target}" }}"`);
    expect(created.body).toContain('href="{{ .Subscriber.Attribs.blog0_unsubscribe_url }}"');
    expect(created.body).toContain('href="https://example.test/privacy"');
    expect(created.body).toContain('href="mailto:hi@example.test"');
    expect(created.body.match(/TrackLink/g)).toHaveLength(1);
    expect(created.altbody).not.toContain('TrackLink');
    const tpl = (await raw.call<Array<{ id: number; name: string; body: string }>>('GET', '/api/templates')).find((x) => x.id === created.template_id);
    expect(tpl).toMatchObject({ name: BLOG0_TEMPLATE_NAME, body: BLOG0_TEMPLATE_BODY });
    expect(tpl!.body).toContain('{{ TrackView }}');
    if (existing) expect(created.template_id).toBe(existing.id);

    // Listmonk's rendering: the content link points at its /link/ redirector, the privacy link does not, the pixel is there.
    const preview = await raw.previewCampaign(campaignId);
    const linkMatch = new RegExp(`href="${env.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/link/([0-9a-f-]{36})/`).exec(preview);
    expect(linkMatch).not.toBeNull();
    expect(preview).toContain('href="https://example.test/privacy"');
    expect(preview).toMatch(/<img[^>]+\/campaign\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/px\.png/);

    await fresh.sendIssue(campaignId);
    const deadline = Date.now() + 60_000;
    while (!['running', 'finished'].includes((await raw.campaign(campaignId)).status) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
    const before = await fresh.fetchStats(campaignId);

    const subUuid = (await raw.call<{ results: Array<{ uuid: string }> }>('GET', `/api/subscribers?query=${encodeURIComponent(`subscribers.email='${t.email}'`)}&per_page=1`)).results[0]!.uuid;
    const click = await fetch(`${env.url}/link/${linkMatch![1]}/${created.uuid}/${subUuid}`, { redirect: 'manual' });
    expect(click.status).toBeGreaterThanOrEqual(300);
    expect(click.status).toBeLessThan(400);
    expect(click.headers.get('location')).toBe(target);
    const pixel = await fetch(`${env.url}/campaign/${created.uuid}/${subUuid}/px.png`);
    expect(pixel.status).toBe(200);
    expect(pixel.headers.get('content-type')).toContain('image/png');

    let after = await fresh.fetchStats(campaignId);
    const statsDeadline = Date.now() + 15_000;
    while ((after.clicks! <= before.clicks! || after.opens! <= before.opens!) && Date.now() < statsDeadline) {
      await new Promise((r) => setTimeout(r, 500));
      after = await fresh.fetchStats(campaignId);
    }
    expect(after.clicks).toBe(before.clicks! + 1);
    expect(after.opens).toBe(before.opens! + 1);

    // idempotent ensure: a second sender finds the template up to date and leaves it alone
    const logs = captureLogs();
    try {
      const again = new ListmonkSender({ url: env.url, apiUser: env.apiUser, apiToken: new Secret(env.apiToken), listId: env.listId });
      const second = await again.createIssue({ ...issue, number: 92 });
      createdCampaigns.add(second.campaignId);
      expect(logs.find('newsletter.provider').filter((l) => l.method === 'PUT')).toEqual([]);
    } finally {
      logs.stop();
    }
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
