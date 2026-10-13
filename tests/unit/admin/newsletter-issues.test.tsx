import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { IssueCompose } from '@/components/admin/newsletter/IssueCompose';
import { IssueDetail, sendAffordance, STUCK_SENDING_TEXT } from '@/components/admin/newsletter/IssueDetail';
import { IssueList } from '@/components/admin/newsletter/IssueList';
import { IssuePreview } from '@/components/admin/newsletter/IssuePreview';
import { IssueStats } from '@/components/admin/newsletter/IssueStats';
import { PostPicker } from '@/components/admin/newsletter/PostPicker';
import { SendDialog } from '@/components/admin/newsletter/SendDialog';
import { SendLog } from '@/components/admin/newsletter/SendLog';
import { moveId, postsInvalidMessage, publishedArticles, toggleId, validateCompose } from '@/components/admin/newsletter/issue-edit';
import { ISSUE_STATUS_LABEL, issueEventLabel, issueStatusClass, ORIGIN_LABEL, sendConfirmTitle, senderNote } from '@/components/admin/newsletter/newsletter-api';
import type { ArticleListItemDto, IssueDetailDto, IssueEventDto, IssueStatsDto } from '@/lib/api/dto';

vi.mock('@/components/admin/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/components/admin/api')>();
  return { ...original, apiRequest: vi.fn(async () => ({ ok: false, status: 0, error: { code: 'NETWORK', message: 'offline' } })) };
});

// Newsletter issues (spec/ui.md §4 "Newsletter", "New issue", "Issue"): pure helpers and the
// static markup of the list, compose, detail, preview, send dialog, send log and stats.

const noop = () => {};

function article(id: string, title: string, status: ArticleListItemDto['status'], firstPublishedAt: string | null): ArticleListItemDto {
  return { id, slug: id, title, topic: 'AI', status, formats: [], hasUnpublishedChanges: false, updatedAt: '2026-10-12T00:00:00Z', updatedBy: 'Sai', firstPublishedAt };
}
const ARTICLES = [
  article('a1', 'Older', 'published', '2026-09-01T00:00:00Z'),
  article('a2', 'Draft one', 'draft', null),
  article('a3', 'Newer', 'published', '2026-10-01T00:00:00Z'),
];

describe('issue compose helpers', () => {
  it('lists only published articles, newest first', () => {
    expect(publishedArticles(ARTICLES).map((a) => a.id)).toEqual(['a3', 'a1']);
  });

  it('toggles ids in order with the 10-post cap and moves them', () => {
    expect(toggleId([], 'a')).toEqual(['a']);
    expect(toggleId(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleId(['a', 'b'], 'a')).toEqual(['b']);
    const ten = Array.from({ length: 10 }, (_, i) => `p${i}`);
    expect(toggleId(ten, 'p10')).toEqual(ten);
    expect(moveId(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveId(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
    expect(moveId(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
  });

  it('validates title, intro and the post count against the shared limits', () => {
    expect(validateCompose({ title: 'Weekly', introMd: '', articleIds: ['a1'] })).toEqual({});
    expect(validateCompose({ title: '   ', introMd: '', articleIds: ['a1'] })).toEqual({ title: 'A title is required.' });
    expect(validateCompose({ title: 'x'.repeat(151), introMd: '', articleIds: ['a1'] })).toEqual({ title: 'At most 150 characters.' });
    expect(validateCompose({ title: 'ok', introMd: 'x'.repeat(5001), articleIds: ['a1'] })).toEqual({ introMd: 'At most 5,000 characters.' });
    expect(validateCompose({ title: 'ok', introMd: '', articleIds: [] })).toEqual({ articleIds: 'Pick between 1 and 10 published posts.' });
  });

  it('names the offending titles from ISSUE_POSTS_INVALID details', () => {
    expect(postsInvalidMessage({ articleIds: ['a2', 'zz'] }, ARTICLES)).toBe('These posts can’t go in an issue: Draft one, zz.');
    expect(postsInvalidMessage(undefined, ARTICLES)).toBeNull();
    expect(postsInvalidMessage({ articleIds: [] }, ARTICLES)).toBeNull();
  });
});

describe('issue labels', () => {
  it('labels statuses, origins and every send-log event', () => {
    expect(ISSUE_STATUS_LABEL).toEqual({ draft: 'Draft', sending: 'Sending', sent: 'Sent', failed: 'Failed' });
    expect(ORIGIN_LABEL).toEqual({ per_post: 'Per post', digest: 'Digest', manual: 'Manual' });
    expect(issueStatusClass('sent')).toBe('spill spill--sent');
    const ev = (kind: IssueEventDto['kind'], details: Record<string, unknown> = {}): IssueEventDto => ({ id: 'e', kind, actor: 'Sai', details, createdAt: '2026-10-12T00:00:00Z' });
    expect(issueEventLabel(ev('created'))).toBe('Created');
    expect(issueEventLabel(ev('updated'))).toBe('Updated');
    expect(issueEventLabel(ev('test_sent', { sentTo: 'me@x.test' }))).toBe('Test sent to me@x.test');
    expect(issueEventLabel(ev('test_sent', { toEmail: 'me@x.test', transport: 'stub' }))).toBe('Test sent to me@x.test');
    expect(issueEventLabel(ev('send_requested', { recipients: 42 }))).toBe('Send requested (42 recipients)');
    expect(issueEventLabel(ev('send_requested', { recipientCount: 1 }))).toBe('Send requested (1 recipient)');
    expect(issueEventLabel(ev('provider_created', { campaignId: 'c9' }))).toBe('Campaign created c9');
    expect(issueEventLabel(ev('provider_started'))).toBe('Campaign started');
    expect(issueEventLabel(ev('sent'))).toBe('Sent');
    expect(issueEventLabel(ev('failed', { error: 'boom' }))).toBe('Failed: boom');
    expect(issueEventLabel(ev('stats_fetched'))).toBe('Stats fetched');
    expect(issueEventLabel(ev('deleted'))).toBe('Deleted');
  });

  it('writes the one-click send confirmation with the count and the sender', () => {
    expect(sendConfirmTitle(42)).toBe('Send to 42 confirmed subscribers?');
    expect(sendConfirmTitle(1)).toBe('Send to 1 confirmed subscriber?');
    expect(senderNote({ kind: 'listmonk', configured: true, listId: '3', listName: 'blog0', lastSyncAt: null, healthy: true, message: null })).toBe('via Listmonk · list blog0');
    expect(senderNote({ kind: 'stub', configured: true, listId: null, listName: null, lastSyncAt: null, healthy: null, message: null })).toBe('via the stub sender — recorded, not delivered');
  });
});

const ISSUE: IssueDetailDto = {
  id: 'i1', number: 3, status: 'draft', origin: 'per_post', title: 'Hello world', postCount: 1, recipientCount: null,
  createdAt: '2026-10-12T11:50:00Z', sentAt: null, lastError: null, introMd: 'Intro', providerCampaignId: null, stats: null,
  createdBy: 'Sai', sentBy: null, editable: true, stuckSending: false, warnings: [],
  posts: [{ articleId: 'a1', slug: 'hello', title: 'Hello', dek: 'Dek', excerpt: 'Ex', topic: 'AI', publishedLabel: '1 Oct 2026', readUrl: 'https://b/p/hello', tldrUrl: null, listenUrl: null }],
  events: [{ id: 'e1', kind: 'created', actor: 'Sai', details: {}, createdAt: '2026-10-12T11:50:00Z' }],
};

describe('IssueList / IssueCompose / IssueDetail shells', () => {
  it('render their loading states with the head and primary actions', () => {
    const list = renderToStaticMarkup(<IssueList timeZone="UTC" />);
    expect(list).toContain('Newsletter');
    expect(list).toContain('Loading issues…');
    expect(list).toContain('href="/admin/newsletter/new"');
    expect(list).toContain('href="/admin/site#newsletter"');

    const compose = renderToStaticMarkup(<IssueCompose timeZone="UTC" />);
    expect(compose).toContain('New issue');
    expect(compose).toContain('Loading published posts…');

    const detail = renderToStaticMarkup(<IssueDetail id="i1" timeZone="UTC" />);
    expect(detail).toContain('Loading the issue…');
  });
});

describe('PostPicker', () => {
  it('is a checklist newest first with ↑ ↓ on the checked ones in their order', () => {
    const html = renderToStaticMarkup(<PostPicker articles={publishedArticles(ARTICLES)} selected={['a1', 'a3']} onChange={noop} timeZone="UTC" />);
    expect(html.indexOf('Newer')).toBeLessThan(html.indexOf('Older'));
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('aria-label="Move Older up"');
    expect(html).toContain('aria-label="Move Newer down"');
    expect(html).toContain('1 Oct 2026');
    expect(html).toContain('2 of 10 picked');
  });

  it('says so when nothing is published', () => {
    expect(renderToStaticMarkup(<PostPicker articles={[]} selected={[]} onChange={noop} timeZone="UTC" />)).toContain('No published posts yet.');
  });
});

describe('IssuePreview', () => {
  it('renders the HTML tab in a sandboxed srcdoc iframe and the text tab as pre', () => {
    const preview = { subject: 'Hello', html: '<p>Hi</p>', text: 'Hi\nhttps://b/p/hello', sampleRecipient: { email: 'me@x.test', consentLine: 'You subscribed.' }, warnings: [] };
    const html = renderToStaticMarkup(<IssuePreview preview={preview} tab="html" onTab={noop} refreshed={false} />);
    expect(html).toContain('<iframe');
    expect(html).toContain('sandbox=""');
    expect(html).toContain('srcDoc="&lt;p&gt;Hi&lt;/p&gt;"');
    expect(html).toContain('title="Issue preview"');
    expect(html).toContain('Preview uses sample values for the unsubscribe link and consent line.');
    expect(html).toContain('role="tablist"');

    const text = renderToStaticMarkup(<IssuePreview preview={preview} tab="text" onTab={noop} refreshed />);
    expect(text).toContain('<pre class="issue-preview__text">Hi\nhttps://b/p/hello</pre>');
    expect(text).toContain('Posts refreshed from their published versions');
    expect(text).not.toContain('<iframe');
  });
});

describe('SendDialog', () => {
  it('asks once with the recipient count and the sender line', () => {
    const html = renderToStaticMarkup(
      <SendDialog recipients={2} sender={{ kind: 'stub', configured: true, listId: null, listName: null, lastSyncAt: null, healthy: null, message: null }} pending={false} onSend={noop} onCancel={noop} />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Send to 2 confirmed subscribers?');
    expect(html).toContain('via the stub sender — recorded, not delivered');
    expect(html).toContain('>Send now</button>');
    expect(html).toContain('>Cancel</button>');
    const busy = renderToStaticMarkup(
      <SendDialog recipients={2} sender={{ kind: 'stub', configured: true, listId: null, listName: null, lastSyncAt: null, healthy: null, message: null }} pending onSend={noop} onCancel={noop} />,
    );
    expect(busy).toMatch(/<button[^>]*disabled[^>]*>Sending…<\/button>/);
  });
});

describe('SendLog + IssueStats', () => {
  it('lists events oldest first with actor and time', () => {
    const events: IssueEventDto[] = [
      { id: 'e1', kind: 'send_requested', actor: 'Sai', details: { recipients: 2 }, createdAt: '2026-10-12T11:50:00Z' },
      { id: 'e2', kind: 'sent', actor: null, details: {}, createdAt: '2026-10-12T11:51:00Z' },
    ];
    const html = renderToStaticMarkup(<SendLog events={events} timeZone="UTC" />);
    expect(html).toContain('<ol class="timeline">');
    expect(html.indexOf('Send requested (2 recipients)')).toBeLessThan(html.indexOf('>Sent<'));
    expect(html).toContain('Sai');
    expect(html).toContain('dateTime="2026-10-12T11:51:00Z"');
  });

  it('shows the six tiles with n/a for unknown counts', () => {
    const stats: IssueStatsDto = { recipients: 2, sent: 2, delivered: null, opens: null, clicks: 1, bounces: 0, unsubscribes: null, fetchedAt: '2026-10-12T11:55:00Z' };
    const html = renderToStaticMarkup(<IssueStats stats={stats} now={new Date('2026-10-12T12:00:00Z')} timeZone="UTC" />);
    expect(html).toContain('class="statbox"');
    expect((html.match(/class="statbox"/g) ?? []).length).toBe(6);
    expect(html).toContain('Recipients');
    expect(html).toContain('Unsubscribes');
    expect(html).toContain('>n/a<');
    expect(html).toContain('as of 5 min ago');
  });
});

describe('sendAffordance (R1: an issue stuck in sending can be retried)', () => {
  it('draft / failed offer Send; failed shows its error above Try again', () => {
    expect(sendAffordance(ISSUE, null)).toEqual({ canSend: true, shownFailure: null, polling: false });
    expect(sendAffordance({ ...ISSUE, status: 'failed', lastError: 'Listmonk down' }, null)).toEqual({ canSend: true, shownFailure: 'Listmonk down', polling: false });
  });

  it('a fresh `sending` polls and offers nothing; a stuck one (> 10 min) stops polling and offers Try again', () => {
    expect(sendAffordance({ ...ISSUE, status: 'sending' }, null)).toEqual({ canSend: false, shownFailure: null, polling: true });
    expect(sendAffordance({ ...ISSUE, status: 'sending', stuckSending: true }, null)).toEqual({ canSend: true, shownFailure: STUCK_SENDING_TEXT, polling: false });
  });

  it('sent never offers Send; this session\'s own failure text wins', () => {
    expect(sendAffordance({ ...ISSUE, status: 'sent' }, null)).toEqual({ canSend: false, shownFailure: null, polling: false });
    expect(sendAffordance({ ...ISSUE, status: 'failed', lastError: 'x' }, 'fresh')).toMatchObject({ shownFailure: 'fresh' });
  });
});

describe('issue fixture', () => {
  it('is a draft per-post issue (keeps the DTO shape honest for the tests above)', () => {
    expect(ISSUE.editable).toBe(true);
    expect(ISSUE.origin).toBe('per_post');
  });
});
