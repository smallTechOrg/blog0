import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetConfigForTests } from '@/server/config';
import { resetLoggerForTests } from '@/server/log';
import {
  getNewsletterSender,
  resetNewsletterSenderForTests,
  SenderError,
  StubNewsletterSender,
  escapeGoTemplate,
  toListmonkExpressions,
  type SenderSubscriber,
} from '@/server/newsletter/sender';
import { CONSENT_PLACEHOLDER, UNSUBSCRIBE_PLACEHOLDER } from '@/server/newsletter/sender/types';

import { captureLogs } from '../../helpers/logs';

// The stub sender's in-memory half (spec/architecture.md §13.3). Its `newsletter_message` rows
// are wave 2 (S7.3) and are covered there.

function sub(tag: string, overrides: Partial<SenderSubscriber> = {}): SenderSubscriber {
  return {
    subscriberId: `id-${tag}`,
    email: `${tag}@example.test`,
    name: null,
    status: 'enabled',
    attribs: {
      blog0_subscriber_id: `id-${tag}`,
      blog0_unsubscribe_url: `http://localhost:3410/newsletter/unsubscribe?t=${tag}`,
      blog0_consent_line: 'consent',
      consent_version: 'v1',
      consented_at: null,
      confirmed_at: null,
      signup_source_url: null,
    },
    ...overrides,
  };
}

const issue = { issueId: 'issue-1', number: 1, subject: 'Hello', html: `<p>Hi ${UNSUBSCRIBE_PLACEHOLDER}</p>`, text: `Hi ${UNSUBSCRIBE_PLACEHOLDER}` };

describe('stub newsletter sender', () => {
  let stub: StubNewsletterSender;

  beforeEach(() => {
    resetConfigForTests();
    resetLoggerForTests();
    stub = new StubNewsletterSender();
  });

  afterEach(() => {
    resetNewsletterSenderForTests();
  });

  it('healthcheck is ok and labelled as the stub', async () => {
    expect(await stub.healthcheck()).toEqual({ ok: true, message: expect.stringContaining('stub'), listName: 'stub' });
    expect(stub.kind).toBe('stub');
  });

  it('syncSubscriber is an idempotent upsert keyed by subscriberId with providerId stub-<id>', async () => {
    expect(await stub.syncSubscriber(sub('a'))).toEqual({ providerId: 'stub-id-a', changed: true });
    expect(await stub.syncSubscriber(sub('a'))).toEqual({ providerId: 'stub-id-a', changed: false });
    expect(await stub.syncSubscriber(sub('a', { name: 'Ann' }))).toEqual({ providerId: 'stub-id-a', changed: true });
    expect(stub.subscribers.size).toBe(1);
    expect(stub.subscribers.get('stub-id-a')?.name).toBe('Ann');
  });

  it('removeSubscriber blocklists (never deletes), idempotently; unknown → changed: false', async () => {
    await stub.syncSubscriber(sub('b'));
    expect(await stub.removeSubscriber('B@example.test')).toEqual({ changed: true });
    expect(stub.subscribers.get('stub-id-b')?.status).toBe('blocklisted');
    expect(await stub.removeSubscriber('b@example.test')).toEqual({ changed: false });
    expect(await stub.removeSubscriber('nobody@example.test')).toEqual({ changed: false });
    expect(stub.subscribers.size).toBe(1);
    // a re-sync (re-confirmation) enables again
    expect(await stub.syncSubscriber(sub('b'))).toEqual({ providerId: 'stub-id-b', changed: true });
    expect(stub.subscribers.get('stub-id-b')?.status).toBe('enabled');
  });

  it('createIssue → stub-<issueId>; sendIssue freezes the enabled recipients once and logs newsletter.issue; fetchStats counts them', async () => {
    await stub.syncSubscriber(sub('c1'));
    await stub.syncSubscriber(sub('c2'));
    await stub.syncSubscriber(sub('c3', { status: 'blocklisted' }));
    const { campaignId } = await stub.createIssue(issue);
    expect(campaignId).toBe('stub-issue-1');
    expect(await stub.fetchStats(campaignId)).toEqual({ recipients: 0, sent: 0, delivered: null, opens: null, clicks: null, bounces: null, unsubscribes: null });

    const logs = captureLogs();
    try {
      await stub.sendIssue(campaignId);
      expect(logs.find('newsletter.issue')).toEqual([
        expect.objectContaining({ sender: 'stub', action: 'send', issueId: 'issue-1', campaignId, recipients: 2, outcome: 'stubbed' }),
      ]);
      expect(JSON.stringify(logs.lines)).not.toContain('c1@example.test'); // addresses are masked
    } finally {
      logs.stop();
    }
    expect(stub.campaigns.get(campaignId)?.recipients).toEqual(['c1@example.test', 'c2@example.test']);
    expect(await stub.fetchStats(campaignId)).toMatchObject({ recipients: 2, sent: 2, delivered: null });

    // idempotent: a later subscriber does not join an already-sent campaign; createIssue keeps the sent state
    await stub.syncSubscriber(sub('c4'));
    await stub.sendIssue(campaignId);
    expect(await stub.createIssue(issue)).toEqual({ campaignId });
    expect(stub.campaigns.get(campaignId)?.status).toBe('sent');
    expect((await stub.fetchStats(campaignId)).recipients).toBe(2);
  });

  it('sendIssue / fetchStats on an unknown campaign throw SenderError INVALID; fetchSuppressions is empty', async () => {
    await expect(stub.sendIssue('stub-nope')).rejects.toMatchObject({ name: 'SenderError', code: 'INVALID' });
    await expect(stub.fetchStats('stub-nope')).rejects.toBeInstanceOf(SenderError);
    expect(await stub.fetchSuppressions(new Date(0))).toEqual([]);
  });

  it('getNewsletterSender() is the stub by default (sender unset), one instance until reset', async () => {
    delete process.env.BLOG0_NEWSLETTER_SENDER;
    resetConfigForTests();
    resetNewsletterSenderForTests();
    const s = getNewsletterSender();
    expect(s.kind).toBe('stub');
    expect(getNewsletterSender()).toBe(s);
    await s.syncSubscriber(sub('z'));
    expect((s as StubNewsletterSender).subscribers.size).toBe(1);
    resetNewsletterSenderForTests();
    expect((s as StubNewsletterSender).subscribers.size).toBe(0); // the stub's memory is cleared on reset
    expect(getNewsletterSender()).not.toBe(s);
    // injection
    resetNewsletterSenderForTests(stub);
    expect(getNewsletterSender()).toBe(stub);
  });

  it('toListmonkExpressions replaces both placeholders everywhere and leaves other text alone', () => {
    const body = `<a href="${UNSUBSCRIBE_PLACEHOLDER}">x</a> ${CONSENT_PLACEHOLDER} / ${UNSUBSCRIBE_PLACEHOLDER} %%OTHER%%`;
    expect(toListmonkExpressions(body)).toBe(
      '<a href="{{ .Subscriber.Attribs.blog0_unsubscribe_url }}">x</a> {{ .Subscriber.Attribs.blog0_consent_line }} / {{ .Subscriber.Attribs.blog0_unsubscribe_url }} %%OTHER%%',
    );
    expect(toListmonkExpressions('plain')).toBe('plain');
  });

  it('toListmonkExpressions escapes literal Go-template delimiters first (one pass), then inserts the placeholders', () => {
    expect(toListmonkExpressions(`<h2>Templating with {{ x }}</h2><a href="${UNSUBSCRIBE_PLACEHOLDER}">u</a>`)).toBe(
      '<h2>Templating with {{ "{{" }} x {{ "}}" }}</h2><a href="{{ .Subscriber.Attribs.blog0_unsubscribe_url }}">u</a>',
    );
    // edge cases: unbalanced, adjacent and triple braces; the inserted text is never re-scanned
    expect(escapeGoTemplate('a }} b {{')).toBe('a {{ "}}" }} b {{ "{{" }}');
    expect(escapeGoTemplate('{{{{')).toBe('{{ "{{" }}{{ "{{" }}');
    expect(escapeGoTemplate('{{{')).toBe('{{ "{{" }}{');
    expect(escapeGoTemplate('{ single } braces')).toBe('{ single } braces');
    expect(escapeGoTemplate('')).toBe('');
  });
});
