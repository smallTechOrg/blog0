// Capability newsletter-issues, the issues half (spec/capabilities/newsletter-issues.md success
// criteria; HOW spec/architecture.md §13.4–13.5): triggers per_post / digest / manual from the real
// publish route, manual compose + edit + delete, preview (HTML + text), test message, the one-click
// send through the recording stub sender (newsletter_message rows per confirmed subscriber), auto-send,
// failure + retry with an injected adapter, stats, settings + status, and state across a restart —
// against the real test Postgres with the stub sender + stub mail transport.
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DELETE as deleteIssueRoute, GET as getIssueRoute, PATCH as patchIssueRoute } from '@/app/api/admin/newsletter/issues/[id]/route';
import { GET as previewRoute } from '@/app/api/admin/newsletter/issues/[id]/preview/route';
import { POST as sendRoute } from '@/app/api/admin/newsletter/issues/[id]/send/route';
import { POST as statsRoute } from '@/app/api/admin/newsletter/issues/[id]/stats/route';
import { POST as testRoute } from '@/app/api/admin/newsletter/issues/[id]/test/route';
import { GET as listIssuesRoute, POST as createIssueRoute } from '@/app/api/admin/newsletter/issues/route';
import { GET as settingsGetRoute, PATCH as settingsPatchRoute } from '@/app/api/admin/newsletter/settings/route';
import { POST as syncRoute } from '@/app/api/admin/newsletter/sync/route';
import { POST as unpublishRoute } from '@/app/api/admin/articles/[id]/unpublish/route';
import { PATCH as patchArticleRoute } from '@/app/api/admin/articles/[id]/route';
import type {
  ArticleDetailDto,
  ArticleResponse,
  IssueDeleteResponse,
  IssueDetailDto,
  IssueDetailResponse,
  IssueListResponse,
  IssuePreviewDto,
  IssueTestResponse,
  NewsletterSettingsPatch,
  NewsletterSettingsResponse,
  NewsletterSyncResponse,
  UpdateArticleResponse,
} from '@/lib/api/dto';
import { publishArticle } from '@/server/articles/service';
import { closeDb, getDb } from '@/server/db/client';
import { articleFormat, newsletterIssue, newsletterIssueEvent, newsletterMessage, newsletterSubscriber, type SiteRow } from '@/server/db/schema';
import { runTick } from '@/server/newsletter/issues/tick';
import { unsubscribeUrl } from '@/server/newsletter/links';
import { resetMailTransportForTests } from '@/server/newsletter/mail';
import { resetNewsletterSenderForTests, SenderError, StubNewsletterSender, type NewsletterSender, type SenderIssue } from '@/server/newsletter/sender';
import { verifyUnsubscribeToken } from '@/server/newsletter/tokens';
import { getConfig } from '@/server/config';
import { resetCurrentSiteForTests } from '@/server/site/current';

import { actAs, call, createArticle, data, err, publish } from '../helpers/api';
import { resetDb } from '../helpers/db';
import { captureLogs } from '../helpers/logs';
import { deckFrom, seedArticle } from '../helpers/seed-articles';
import { loginAs, type TestLogin } from '../helpers/session';

const BODY = [
  'The deck shows the strongest lines of the article in order. Each slide holds exactly one sentence from the text.',
  '',
  'Writers pick the lines by hand when the model is unavailable. That keeps publishing moving on a bad day.',
].join('\n');

let currentSite: SiteRow;
let admin: TestLogin;
let logs: ReturnType<typeof captureLogs>;

// --- helpers ------------------------------------------------------------------------------------

const settings = (patch: NewsletterSettingsPatch) => call<NewsletterSettingsResponse>(settingsPatchRoute, 'PATCH', '/api/admin/newsletter/settings', { body: patch });
const getIssue = (id: string) => call<IssueDetailResponse>(getIssueRoute, 'GET', `/api/admin/newsletter/issues/${id}`, { id });
const listIssues = (q = '') => call<IssueListResponse>(listIssuesRoute, 'GET', `/api/admin/newsletter/issues${q}`);
const createIssue = (body: unknown) => call<IssueDetailResponse>(createIssueRoute, 'POST', '/api/admin/newsletter/issues', { body });
const patchIssue = (id: string, body: unknown) => call<IssueDetailResponse>(patchIssueRoute, 'PATCH', `/api/admin/newsletter/issues/${id}`, { id, body });
const deleteIssue = (id: string) => call<IssueDeleteResponse>(deleteIssueRoute, 'DELETE', `/api/admin/newsletter/issues/${id}`, { id });
const preview = (id: string) => call<IssuePreviewDto>(previewRoute, 'GET', `/api/admin/newsletter/issues/${id}/preview`, { id });
const sendTest = (id: string) => call<IssueTestResponse>(testRoute, 'POST', `/api/admin/newsletter/issues/${id}/test`, { id, body: {} });
const send = (id: string, body: unknown = { confirm: true }) => call<IssueDetailResponse>(sendRoute, 'POST', `/api/admin/newsletter/issues/${id}/send`, { id, body });
const stats = (id: string) => call<IssueDetailResponse>(statsRoute, 'POST', `/api/admin/newsletter/issues/${id}/stats`, { id, body: {} });

async function publishNew(title: string, opts: { topic?: string; dek?: string; bodyMd?: string } = {}): Promise<ArticleDetailDto> {
  const created = await createArticle({ title, topic: opts.topic ?? 'Analysis', dek: opts.dek ?? `${title} — the dek.`, bodyMd: opts.bodyMd ?? BODY });
  const { status, env } = await publish(created.id, created.currentRevision.id);
  expect(status).toBe(200);
  return data(env).article;
}

async function issueRows() {
  return getDb().select().from(newsletterIssue).where(eq(newsletterIssue.siteId, currentSite.id)).orderBy(asc(newsletterIssue.number));
}

async function issueMessages(issueId: string, kind: 'issue' | 'test_issue' = 'issue') {
  return getDb()
    .select()
    .from(newsletterMessage)
    .where(and(eq(newsletterMessage.issueId, issueId), eq(newsletterMessage.kind, kind)))
    .orderBy(asc(newsletterMessage.toEmail));
}

async function addSubscriber(email: string, status: 'pending' | 'confirmed' | 'unsubscribed' | 'bounced' | 'legacy_unconfirmed') {
  const now = new Date();
  const [row] = await getDb()
    .insert(newsletterSubscriber)
    .values({
      siteId: currentSite.id,
      email,
      status,
      source: status === 'legacy_unconfirmed' ? 'legacy' : 'footer',
      consentText: 'One issue a week at most.',
      consentVersion: 'v1',
      consentedAt: status === 'legacy_unconfirmed' ? null : now,
      confirmedAt: status === 'confirmed' || status === 'unsubscribed' ? now : null,
      unsubscribedAt: status === 'unsubscribed' || status === 'bounced' ? now : null,
    })
    .returning();
  return row;
}

/** A sender wrapping the DB-recording stub whose steps can be made to fail; counts createIssue calls. */
class FlakySender implements NewsletterSender {
  async trackingPublic() {
    return true;
  }
  kind: 'stub' | 'listmonk' = 'stub';
  readonly inner = new StubNewsletterSender({ recordToDb: true });
  healthy = true;
  failCreate = false;
  failStart = false;
  createCalls = 0;
  async healthcheck() {
    return this.healthy ? this.inner.healthcheck() : { ok: false, message: 'connect ECONNREFUSED' };
  }
  syncSubscriber(...a: Parameters<NewsletterSender['syncSubscriber']>) {
    return this.inner.syncSubscriber(...a);
  }
  removeSubscriber(email: string) {
    return this.inner.removeSubscriber(email);
  }
  findSubscriberId(email: string) {
    return this.inner.findSubscriberId(email);
  }
  deleteSubscriber(...a: Parameters<NewsletterSender['deleteSubscriber']>) {
    return this.inner.deleteSubscriber(...a);
  }
  async createIssue(i: SenderIssue) {
    this.createCalls += 1;
    if (this.failCreate) throw new SenderError('HTTP', 'provider said 500 on create', 500);
    return this.inner.createIssue(i);
  }
  async sendIssue(campaignId: string) {
    if (this.failStart) throw new SenderError('TIMEOUT', 'provider timed out starting the campaign');
    return this.inner.sendIssue(campaignId);
  }
  fetchStats(campaignId: string) {
    return this.inner.fetchStats(campaignId);
  }
  fetchSuppressions(since: Date) {
    return this.inner.fetchSuppressions(since);
  }
}

beforeEach(async () => {
  currentSite = await resetDb();
  resetMailTransportForTests();
  resetNewsletterSenderForTests();
  admin = actAs(await loginAs({ email: 'desk@example.test', displayName: 'Desk Admin' }));
  logs = captureLogs();
});

afterAll(() => {
  resetNewsletterSenderForTests();
  logs?.stop();
});

// --- triggers -----------------------------------------------------------------------------------

describe('per_post trigger', () => {
  it('a first publish creates one draft issue with the post snapshot; republish and unpublish create nothing', async () => {
    const saved = data((await settings({ mode: 'per_post', autoSend: false })).env);
    expect(saved.settings).toMatchObject({ mode: 'per_post', autoSend: false });
    expect(saved.settings.modeSetAt).not.toBeNull();

    const article = await publishNew('Why decks work', { dek: 'The strongest lines, in order.' });
    const [issue] = await issueRows();
    const list = data((await listIssues()).env);
    const detail = data((await getIssue(issue.id)).env).issue;

    expect(list.total).toBe(1);
    expect(list.issues[0]).toMatchObject({ status: 'draft', origin: 'per_post', title: 'Why decks work', postCount: 1, number: 1 });
    expect(detail.posts).toEqual([
      expect.objectContaining({
        articleId: article.id,
        slug: 'why-decks-work',
        title: 'Why decks work',
        dek: 'The strongest lines, in order.',
        excerpt: 'The deck shows the strongest lines of the article in order. Each slide holds exactly one sentence from the text.',
        topic: 'Analysis',
        readUrl: `${getConfig().publicBaseUrl}/p/why-decks-work`,
        tldrUrl: null,
        listenUrl: null,
      }),
    ]);
    expect(detail.introMd).toBe('The strongest lines, in order.');
    expect(detail.createdBy).toBeNull();
    expect(detail.editable).toBe(true);
    expect(detail.events.map((e) => e.kind)).toEqual(['created']);
    expect(logs.find('newsletter.issue')).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'created', outcome: 'ok', origin: 'per_post', number: 1 })]));

    // publish a change: no second issue
    const edited = data(
      (await call<UpdateArticleResponse>(patchArticleRoute, 'PATCH', `/api/admin/articles/${article.id}`, { id: article.id, body: { baseRevisionId: article.currentRevision.id, title: 'Why decks work, revised' } })).env,
    ).article;
    expect((await publish(article.id, edited.currentRevision.id)).status).toBe(200);
    // unpublish + republish: still nothing
    await call<ArticleResponse>(unpublishRoute, 'POST', `/api/admin/articles/${article.id}/unpublish`, { id: article.id });
    expect((await publish(article.id, edited.currentRevision.id)).status).toBe(200);

    expect(await issueRows()).toHaveLength(1);
    expect(await getDb().select().from(newsletterMessage)).toHaveLength(0);
  });

  it('manual mode (the default): publishes create no issue', async () => {
    await publishNew('First manual');
    await publishNew('Second manual');
    expect(await issueRows()).toHaveLength(0);
    expect(data((await call<NewsletterSettingsResponse>(settingsGetRoute, 'GET', '/api/admin/newsletter/settings')).env).settings.mode).toBe('manual');
  });
});

describe('digest trigger', () => {
  it('posts rule on publish; the days rule only via the tick; an article goes in one automatic issue only', async () => {
    await settings({ mode: 'digest', digestPosts: 2, digestDays: 7 });

    const a = await publishNew('Digest one');
    expect(await issueRows()).toHaveLength(0);
    const status1 = data((await call<NewsletterSettingsResponse>(settingsGetRoute, 'GET', '/api/admin/newsletter/settings')).env).status;
    expect(status1.digest).toMatchObject({ lastIssueAt: null, newPostsSince: 1 });
    expect(status1.digest?.dueAt).not.toBeNull();

    const b = await publishNew('Digest two');
    const afterTwo = await issueRows();
    expect(afterTwo).toHaveLength(1);
    expect(afterTwo[0]).toMatchObject({ origin: 'digest', status: 'draft', title: `${currentSite.brandName} · 2 new articles`, introMd: '' });
    expect(afterTwo[0].articleIds).toEqual([a.id, b.id]);

    // a third publish 8 days later: posts rule not met → nothing until the tick
    const later = new Date(afterTwo[0].createdAt.getTime() + 8 * 24 * 60 * 60 * 1000);
    const c = await createArticle({ title: 'Digest three', topic: 'Analysis', bodyMd: BODY });
    await publishArticle({ siteId: currentSite.id, user: admin.user }, c.id, c.currentRevision.id, later);
    expect(await issueRows()).toHaveLength(1);

    const tick = await runTick(currentSite.id, { now: later });
    const afterTick = await issueRows();
    expect(tick).toMatchObject({ digestCreated: true, digestIssueNumber: 2, errors: [] });
    expect(afterTick).toHaveLength(2);
    expect(afterTick[1]).toMatchObject({ origin: 'digest', title: `${currentSite.brandName} · 1 new article` });
    expect(afterTick[1].articleIds).toEqual([c.id]);

    // nothing new: a second tick creates nothing
    expect((await runTick(currentSite.id, { now: new Date(later.getTime() + 60_000) })).digestCreated).toBe(false);
    expect(logs.find('newsletter.tick').at(-1)).toMatchObject({ digest_created: false, suppressions_pulled: 0 });
  });
});

describe('manual compose, edit, delete', () => {
  it('creates a draft in the given order, PATCH reorders and removes, DELETE a draft; a sent issue cannot be deleted', async () => {
    const a = await publishNew('Alpha');
    const b = await publishNew('Bravo');
    const c = await publishNew('Charlie');
    expect(await issueRows()).toHaveLength(0);

    const created = await createIssue({ title: 'Hand-picked', introMd: 'Three for *you*.', articleIds: [b.id, a.id, c.id] });
    expect(created.status).toBe(201);
    const issue = data(created.env).issue;
    expect(issue).toMatchObject({ origin: 'manual', status: 'draft', title: 'Hand-picked', introMd: 'Three for *you*.', postCount: 3, createdBy: 'Desk Admin' });
    expect(issue.posts.map((p) => p.title)).toEqual(['Bravo', 'Alpha', 'Charlie']);

    const patched = data((await patchIssue(issue.id, { title: 'Two picks', articleIds: [c.id, b.id] })).env).issue;
    expect(patched.title).toBe('Two picks');
    expect(patched.posts.map((p) => p.title)).toEqual(['Charlie', 'Bravo']);
    expect(patched.events.map((e) => e.kind)).toEqual(['created', 'updated']);
    expect(patched.events[1]).toMatchObject({ actor: 'Desk Admin', details: { fields: ['title', 'articleIds'] } });

    expect(data((await deleteIssue(issue.id)).env)).toEqual({ deleted: true });
    expect(await issueRows()).toHaveLength(0);
    expect((await getIssue(issue.id)).status).toBe(404);

    // a sent issue: 409 on delete / patch
    await addSubscriber('reader@example.test', 'confirmed');
    const toSend = data((await createIssue({ title: 'Sent one', articleIds: [a.id] })).env).issue;
    expect((await send(toSend.id)).status).toBe(200);
    const del = await deleteIssue(toSend.id);
    const edit = await patchIssue(toSend.id, { title: 'nope' });
    expect(del.status).toBe(409);
    expect(err(del.env).code).toBe('ISSUE_NOT_DRAFT');
    expect(err(edit.env).code).toBe('ISSUE_NOT_DRAFT');
  });

  it('refuses invalid post lists with 422 ISSUE_POSTS_INVALID naming the ids; unknown keys and bad bodies with 400', async () => {
    const a = await publishNew('Published one');
    const draft = await createArticle({ title: 'Never published', topic: 'Analysis', bodyMd: BODY });

    const unpublished = await createIssue({ title: 'x', articleIds: [a.id, draft.id] });
    const dupes = await createIssue({ title: 'x', articleIds: [a.id, a.id] });
    const empty = await createIssue({ title: 'x', articleIds: [] });
    const eleven = await createIssue({ title: 'x', articleIds: Array.from({ length: 11 }, () => a.id) });
    const unknownKey = await createIssue({ title: 'x', articleIds: [a.id], origin: 'per_post' });
    const noTitle = await createIssue({ title: '  ', articleIds: [a.id] });

    expect(unpublished.status).toBe(422);
    expect(err(unpublished.env)).toMatchObject({ code: 'ISSUE_POSTS_INVALID', details: { articleIds: [draft.id] } });
    expect(err(dupes.env)).toMatchObject({ code: 'ISSUE_POSTS_INVALID', details: { articleIds: [a.id] } });
    expect(empty.status).toBe(422);
    expect(eleven.status).toBe(422);
    expect(unknownKey.status).toBe(400);
    expect(noTitle.status).toBe(400);
    expect(await issueRows()).toHaveLength(0);
  });

  it('rejects unauthenticated requests and a cross-origin mutation', async () => {
    const anon = await call(listIssuesRoute, 'GET', '/api/admin/newsletter/issues', { cookie: null });
    const foreign = await call(createIssueRoute, 'POST', '/api/admin/newsletter/issues', { body: { title: 'x', articleIds: [] }, origin: 'https://evil.example' });
    expect(anon.status).toBe(401);
    expect(foreign.status).toBe(403);
  });
});

// --- preview + test -------------------------------------------------------------------------------

describe('preview and test message', () => {
  it('preview: HTML with titles, Read, TLDR for a published deck, the brand, an unsubscribe link and the consent line; text without tags', async () => {
    const withDeck = await seedArticle({ siteId: currentSite.id, slug: 'with-deck', title: 'With a deck', bodyMd: BODY, deck: { malformed: true } });
    const real = await seedArticle({ siteId: currentSite.id, slug: 'real-deck', title: 'Real deck', bodyMd: BODY });
    // a real published deck payload built from the rendered sentences (the malformed one above offers no TLDR)
    await getDb()
      .insert(articleFormat)
      .values({ siteId: currentSite.id, articleId: real.id, kind: 'tldr', publishedPayload: deckFrom(real.rendered, [0, 1]), publishedRevisionId: real.revisionId, publishedAt: new Date() });

    const issue = data((await createIssue({ title: 'Preview me', introMd: 'Hello **readers**.', articleIds: [withDeck.id, real.id] })).env).issue;
    const { status, env } = await preview(issue.id);
    const p = data(env);
    const base = getConfig().publicBaseUrl;

    expect(status).toBe(200);
    expect(p.subject).toBe('Preview me');
    expect(p.html).toContain('With a deck');
    expect(p.html).toContain('Real deck');
    expect(p.html).toContain('>Read</a>');
    expect(p.html).toContain(`href="${base}/p/real-deck/tldr"`);
    expect(p.html).not.toContain(`${base}/p/with-deck/tldr`);
    expect(p.html).toContain(currentSite.brandName.slice(0, -1));
    expect(p.html).toMatch(/href="http[^"]*\/newsletter\/unsubscribe\?t=[^"]+"[^>]*>Unsubscribe</);
    expect(p.html).toContain(p.sampleRecipient.consentLine);
    expect(p.html).toContain('<strong>readers</strong>');
    expect(p.html).not.toContain('%%BLOG0_');
    expect(p.sampleRecipient.email).toBe('desk@example.test');
    expect(p.sampleRecipient.consentLine).toMatch(/^You’re getting this because you subscribed at .+ on .+ and confirmed on .+\.$/);
    expect(p.text).toContain('With a deck');
    expect(p.text).toContain(`Read: ${base}/p/with-deck`);
    expect(p.text).toContain(`TLDR: ${base}/p/real-deck/tldr`);
    expect(p.text).toContain(p.sampleRecipient.consentLine);
    expect(p.text).not.toMatch(/<[a-z/][^>]*>/i);
  });

  it('a draft preview re-snapshots from the current published revision (persisted); a sent issue keeps its frozen body', async () => {
    const article = await publishNew('Original title');
    const issue = data((await createIssue({ title: 'Snap', articleIds: [article.id] })).env).issue;
    const edited = data(
      (await call<UpdateArticleResponse>(patchArticleRoute, 'PATCH', `/api/admin/articles/${article.id}`, { id: article.id, body: { baseRevisionId: article.currentRevision.id, title: 'Retitled for readers' } })).env,
    ).article;
    // saved but not published yet: the preview still shows the published title
    expect(data((await preview(issue.id)).env).html).toContain('Original title');
    await publish(article.id, edited.currentRevision.id);
    expect(data((await preview(issue.id)).env).html).toContain('Retitled for readers');
    expect(data((await getIssue(issue.id)).env).issue.posts[0].title).toBe('Retitled for readers');

    await addSubscriber('frozen@example.test', 'confirmed');
    await send(issue.id);
    const edited2 = data(
      (await call<UpdateArticleResponse>(patchArticleRoute, 'PATCH', `/api/admin/articles/${article.id}`, { id: article.id, body: { baseRevisionId: edited.currentRevision.id, title: 'Third title' } })).env,
    ).article;
    await publish(article.id, edited2.currentRevision.id);
    const frozen = data((await preview(issue.id)).env);
    expect(frozen.html).toContain('Retitled for readers');
    expect(frozen.html).not.toContain('Third title');
  });

  it('send test: one test_issue message to the admin with subject [Test] …; the issue stays draft; event test_sent', async () => {
    const article = await publishNew('Test me');
    const issue = data((await createIssue({ title: 'Tested issue', articleIds: [article.id] })).env).issue;

    const { status, env } = await sendTest(issue.id);
    const res = data(env);
    const msgs = await issueMessages(issue.id, 'test_issue');
    const after = data((await getIssue(issue.id)).env).issue;

    expect(status).toBe(200);
    expect(res).toMatchObject({ sentTo: 'desk@example.test', transport: 'stub' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ toEmail: 'desk@example.test', subject: '[Test] Tested issue', transport: 'stub', status: 'stubbed', subscriberId: null });
    expect(msgs[0].html).toContain('Test me');
    expect(msgs[0].html).not.toContain('%%BLOG0_');
    expect(after.status).toBe('draft');
    expect(after.events.map((e) => e.kind)).toEqual(['created', 'test_sent']);
    expect(after.events[1].details).toMatchObject({ toEmail: 'desk@example.test', transport: 'stub' });
    expect(await getDb().select().from(newsletterMessage).where(eq(newsletterMessage.kind, 'issue'))).toHaveLength(0);

    // deleting a tested draft keeps the test message (unlinked)
    expect((await deleteIssue(issue.id)).status).toBe(200);
    const kept = await getDb().select().from(newsletterMessage).where(eq(newsletterMessage.kind, 'test_issue'));
    expect(kept).toHaveLength(1);
    expect(kept[0].issueId).toBeNull();
  });

  it('preview / test of an unknown or malformed id → 404', async () => {
    expect((await preview('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await sendTest('not-a-uuid')).status).toBe(404);
  });
});

// --- send ---------------------------------------------------------------------------------------

describe('send through the stub sender', () => {
  it('sends to exactly the confirmed subscribers, each with their own unsubscribe link; events in order; second send 409; stats', async () => {
    const confirmed = [await addSubscriber('c1@example.test', 'confirmed'), await addSubscriber('c2@example.test', 'confirmed'), await addSubscriber('c3@example.test', 'confirmed')];
    await addSubscriber('pending@example.test', 'pending');
    await addSubscriber('legacy@example.test', 'legacy_unconfirmed');
    await addSubscriber('gone@example.test', 'unsubscribed');
    const article = await publishNew('Big news');
    const issue = data((await createIssue({ title: 'Issue one', articleIds: [article.id] })).env).issue;
    expect(data((await listIssues()).env).confirmedCount).toBe(3);

    const noConfirm = await send(issue.id, {});
    expect(noConfirm.status).toBe(400);

    const { status, env } = await send(issue.id);
    const sent = data(env).issue;
    const msgs = await issueMessages(issue.id);
    const [row] = await getDb().select().from(newsletterIssue).where(eq(newsletterIssue.id, issue.id));

    expect(status).toBe(200);
    expect(sent).toMatchObject({ status: 'sent', recipientCount: 3, sentBy: 'Desk Admin', providerCampaignId: `stub-${issue.id}`, editable: false, lastError: null });
    expect(sent.sentAt).not.toBeNull();
    expect(sent.events.map((e) => e.kind)).toEqual(['created', 'send_requested', 'provider_created', 'provider_started', 'sent']);
    expect(sent.events[1].details).toMatchObject({ recipientCount: 3 });
    expect(msgs.map((m) => m.toEmail)).toEqual(['c1@example.test', 'c2@example.test', 'c3@example.test']);
    for (const m of msgs) {
      const sub = confirmed.find((s) => s.email === m.toEmail)!;
      expect(m).toMatchObject({ kind: 'issue', transport: 'stub_sender', status: 'stubbed', subject: 'Issue one', subscriberId: sub.id });
      expect(m.html).toContain(`href="${unsubscribeUrl(sub.id)}"`);
      expect(m.text).toContain(`Unsubscribe: ${unsubscribeUrl(sub.id)}`);
      expect(m.html).toContain('You’re getting this because you subscribed at');
      const token = new URL(unsubscribeUrl(sub.id)).searchParams.get('t') as string;
      expect(verifyUnsubscribeToken(token, getConfig().sessionSecret.reveal())).toBe(sub.id);
    }
    expect(row.renderedHtml).toContain('%%BLOG0_UNSUBSCRIBE_URL%%');
    expect(row.renderedText).toContain('Big news');
    expect(logs.find('newsletter.issue')).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'send', outcome: 'sent', recipient_count: 3, issue_id: issue.id })]));

    const again = await send(issue.id);
    expect(again.status).toBe(409);
    expect(err(again.env).code).toBe('ISSUE_NOT_DRAFT');
    expect(await issueMessages(issue.id)).toHaveLength(3);

    const withStats = data((await stats(issue.id)).env).issue;
    expect(withStats.stats).toMatchObject({ recipients: 3, sent: 3, delivered: null, opens: null });
    expect(withStats.status).toBe('sent');
    expect(withStats.events.at(-1)?.kind).toBe('stats_fetched');
  });

  it('0 confirmed subscribers → 409 NO_RECIPIENTS and the issue stays draft; stats on a draft → 409', async () => {
    await addSubscriber('pending@example.test', 'pending');
    const article = await publishNew('Nobody yet');
    const issue = data((await createIssue({ title: 'Lonely', articleIds: [article.id] })).env).issue;

    const res = await send(issue.id);
    const st = await stats(issue.id);
    const after = data((await getIssue(issue.id)).env).issue;

    expect(res.status).toBe(409);
    expect(err(res.env).code).toBe('NO_RECIPIENTS');
    expect(st.status).toBe(409);
    expect(err(st.env).code).toBe('ISSUE_NOT_DRAFT');
    expect(after.status).toBe('draft');
    expect(after.events.map((e) => e.kind)).toEqual(['created']);
  });

  it('a failing createIssue → failed + last_error + 502 SENDER_FAILED; Try again with a working adapter → sent', async () => {
    await addSubscriber('r@example.test', 'confirmed');
    const article = await publishNew('Flaky');
    const issue = data((await createIssue({ title: 'Flaky issue', articleIds: [article.id] })).env).issue;
    const flaky = new FlakySender();
    flaky.failCreate = true;
    resetNewsletterSenderForTests(flaky);

    const failed = await send(issue.id);
    expect(failed.status).toBe(502);
    const e = err(failed.env);
    expect(e.code).toBe('SENDER_FAILED');
    const failedIssue = (e.details as { issue: IssueDetailDto }).issue;
    expect(failedIssue).toMatchObject({ status: 'failed', lastError: 'provider said 500 on create', providerCampaignId: null });
    expect(failedIssue.events.map((ev) => ev.kind)).toEqual(['created', 'send_requested', 'failed']);
    expect(failedIssue.events[2].details).toMatchObject({ error: 'provider said 500 on create', step: 'create' });

    flaky.failCreate = false;
    const retried = data((await send(issue.id)).env).issue;
    expect(retried.status).toBe('sent');
    expect(retried.lastError).toBeNull();
    expect(retried.events.map((ev) => ev.kind)).toEqual(['created', 'send_requested', 'failed', 'send_requested', 'provider_created', 'provider_started', 'sent']);
    expect(await issueMessages(issue.id)).toHaveLength(1);
  });

  it('a campaign created before the failure is reused on retry (no second createIssue call)', async () => {
    await addSubscriber('r@example.test', 'confirmed');
    const article = await publishNew('Half way');
    const issue = data((await createIssue({ title: 'Half way', articleIds: [article.id] })).env).issue;
    const flaky = new FlakySender();
    flaky.failStart = true;
    resetNewsletterSenderForTests(flaky);

    const failed = err((await send(issue.id)).env);
    const failedIssue = (failed.details as { issue: IssueDetailDto }).issue;
    expect(failedIssue).toMatchObject({ status: 'failed', providerCampaignId: `stub-${issue.id}` });
    expect(flaky.createCalls).toBe(1);

    flaky.failStart = false;
    const retried = data((await send(issue.id)).env).issue;
    expect(retried.status).toBe('sent');
    expect(flaky.createCalls).toBe(1);
    expect(retried.events.filter((ev) => ev.kind === 'provider_created')).toHaveLength(1);
  });

  it('R1: an issue stuck in `sending` (no progress for 10 min) can be retried — fresh `sending` → 409; stale → Try again reuses the campaign → sent', async () => {
    await addSubscriber('r@example.test', 'confirmed');
    const article = await publishNew('Stuck');
    const issue = data((await createIssue({ title: 'Stuck', articleIds: [article.id] })).env).issue;
    const flaky = new FlakySender();
    flaky.failStart = true;
    resetNewsletterSenderForTests(flaky);
    await send(issue.id); // campaign created, bodies frozen, then failed at start
    flaky.failStart = false;
    // what a crashed process leaves behind: `sending`, never settled
    const setSending = (agoMs: number) =>
      getDb().update(newsletterIssue).set({ status: 'sending', lastError: null, updatedAt: new Date(Date.now() - agoMs) }).where(eq(newsletterIssue.id, issue.id));

    await setSending(9 * 60_000);
    const fresh = data((await getIssue(issue.id)).env).issue;
    expect(fresh).toMatchObject({ status: 'sending', stuckSending: false });
    const refused = await send(issue.id);
    expect(refused.status).toBe(409);
    expect(err(refused.env).code).toBe('ISSUE_NOT_DRAFT');

    await setSending(11 * 60_000);
    expect(data((await getIssue(issue.id)).env).issue).toMatchObject({ status: 'sending', stuckSending: true });
    const retried = data((await send(issue.id)).env).issue;
    expect(retried).toMatchObject({ status: 'sent', stuckSending: false, lastError: null });
    expect(flaky.createCalls).toBe(1); // the campaign created before the crash is reused
    const requested = retried.events.filter((ev) => ev.kind === 'send_requested');
    expect(requested.at(-1)!.details).toMatchObject({ retry: true, stuckSince: expect.any(String) });
    expect(await issueMessages(issue.id)).toHaveLength(1);
    // a sent issue is never "stuck"
    expect((await send(issue.id)).status).toBe(409);
  });

  it('an unhealthy listmonk sender → 503 SENDER_UNAVAILABLE naming the host only; the issue is untouched', async () => {
    await addSubscriber('r@example.test', 'confirmed');
    const article = await publishNew('Down');
    const issue = data((await createIssue({ title: 'Down', articleIds: [article.id] })).env).issue;
    const down = new FlakySender();
    down.kind = 'listmonk';
    down.healthy = false;
    resetNewsletterSenderForTests(down);

    const res = await send(issue.id);
    expect(res.status).toBe(503);
    expect(err(res.env).code).toBe('SENDER_UNAVAILABLE');
    expect(err(res.env).message).not.toMatch(/token/i);
    expect(data((await getIssue(issue.id)).env).issue.status).toBe('draft');
    expect(down.createCalls).toBe(0);
  });
});

describe('auto-send', () => {
  it('per_post + autoSend true: a first publish creates AND sends (stub rows written)', async () => {
    await addSubscriber('a1@example.test', 'confirmed');
    await addSubscriber('a2@example.test', 'confirmed');
    await settings({ mode: 'per_post', autoSend: true });

    await publishNew('Auto news');
    const [issue] = await issueRows();
    const detail = data((await getIssue(issue.id)).env).issue;

    expect(detail).toMatchObject({ status: 'sent', recipientCount: 2, sentBy: null, origin: 'per_post' });
    expect(detail.events.map((e) => e.kind)).toEqual(['created', 'send_requested', 'provider_created', 'provider_started', 'sent']);
    expect(await issueMessages(issue.id)).toHaveLength(2);
  });

  it('per_post + autoSend false: the publish leaves a draft and writes no message', async () => {
    await addSubscriber('a1@example.test', 'confirmed');
    await settings({ mode: 'per_post', autoSend: false });
    await publishNew('Waiting news');
    const [issue] = await issueRows();
    expect(issue.status).toBe('draft');
    expect(await getDb().select().from(newsletterMessage)).toHaveLength(0);
  });

  it('a failing auto-send never fails the publish; the issue shows the error', async () => {
    await addSubscriber('a1@example.test', 'confirmed');
    await settings({ mode: 'per_post', autoSend: true });
    const flaky = new FlakySender();
    flaky.failCreate = true;
    resetNewsletterSenderForTests(flaky);

    const article = await publishNew('Publish anyway');
    const [issue] = await issueRows();
    expect(article.status).toBe('published');
    expect(issue).toMatchObject({ status: 'failed', lastError: 'provider said 500 on create' });

    // 0 confirmed with auto-send: the draft simply waits
    await getDb().delete(newsletterMessage);
    await getDb().update(newsletterSubscriber).set({ status: 'unsubscribed' });
    resetNewsletterSenderForTests();
    await publishNew('No readers yet');
    const rows = await issueRows();
    expect(rows[1]).toMatchObject({ status: 'draft', title: 'No readers yet' });
    expect(logs.find('newsletter.issue')).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'send', outcome: 'skipped', err_code: 'NO_RECIPIENTS' })]));
  });
});

// --- settings, sync button, restart -----------------------------------------------------------------

describe('settings and status', () => {
  it('GET shows the stub sender + counts; PATCH stamps modeSetAt on a mode change, bumps the consent version, never sends', async () => {
    await addSubscriber('c@example.test', 'confirmed');
    await addSubscriber('p@example.test', 'pending');
    const before = data((await call<NewsletterSettingsResponse>(settingsGetRoute, 'GET', '/api/admin/newsletter/settings')).env);
    expect(before.settings).toMatchObject({ mode: 'manual', autoSend: false, digestDays: 7, digestPosts: 3, consentVersion: 'v1', modeSetAt: null });
    expect(before.status.sender).toMatchObject({ kind: 'stub', configured: true, healthy: null, listId: null, lastSyncAt: null });
    expect(before.status.mail.transport).toBe('stub');
    expect(before.status.counts).toMatchObject({ confirmed: 1, pending: 1, all: 2 });
    expect(before.status.digest).toBeNull();

    const after = data((await settings({ mode: 'digest', autoSend: true, consentText: 'A new promise.' })).env);
    expect(after.settings).toMatchObject({ mode: 'digest', autoSend: true, consentText: 'A new promise.', consentVersion: 'v2' });
    expect(after.settings.modeSetAt).not.toBeNull();
    expect(after.status.digest).toEqual({ lastIssueAt: null, newPostsSince: 0, dueAt: null });
    expect(await issueRows()).toHaveLength(0);

    const bad = await settings({ digestDays: 0 } as NewsletterSettingsPatch);
    const serverSet = await call(settingsPatchRoute, 'PATCH', '/api/admin/newsletter/settings', { body: { modeSetAt: new Date().toISOString() } });
    expect(bad.status).toBe(400);
    expect(serverSet.status).toBe(400);
  });

  it('POST …/sync with the stub sender skips every row and changes nothing; without confirm → 400', async () => {
    await addSubscriber('c@example.test', 'confirmed');
    await addSubscriber('u@example.test', 'unsubscribed');
    const ok = await call<NewsletterSyncResponse>(syncRoute, 'POST', '/api/admin/newsletter/sync', { body: { confirm: true } });
    const no = await call(syncRoute, 'POST', '/api/admin/newsletter/sync', { body: {} });
    expect(data(ok.env)).toEqual({ synced: 0, blocklisted: 0, skipped: 2, suppressedFromProvider: 0, changed: 0, errors: [] });
    expect(no.status).toBe(400);
    expect((await getDb().select().from(newsletterSubscriber)).every((s) => s.providerSyncedAt === null)).toBe(true);
  });
});

describe('state survives a restart', () => {
  it('a sent issue, its send log and stats read back the same after the DB handle, site cache and sender are rebuilt', async () => {
    await addSubscriber('r1@example.test', 'confirmed');
    await addSubscriber('r2@example.test', 'confirmed');
    const article = await publishNew('Durable');
    const issue = data((await createIssue({ title: 'Durable', articleIds: [article.id] })).env).issue;
    await sendTest(issue.id);
    const sent = data((await send(issue.id)).env).issue;

    await closeDb();
    resetCurrentSiteForTests();
    resetNewsletterSenderForTests(); // the stub's memory is gone; its DB rows are not
    resetMailTransportForTests();

    const reread = data((await getIssue(issue.id)).env).issue;
    const refreshed = data((await stats(issue.id)).env).issue;
    const events = await getDb().select().from(newsletterIssueEvent).where(eq(newsletterIssueEvent.issueId, issue.id));

    expect(reread).toEqual(sent);
    expect(refreshed.stats).toMatchObject({ recipients: 2, sent: 2 });
    expect(events.map((e) => e.kind).sort()).toEqual(['created', 'provider_created', 'provider_started', 'send_requested', 'sent', 'stats_fetched', 'test_sent'].sort());
    expect(data((await listIssues('?status=sent')).env).total).toBe(1);
    expect(data((await listIssues('?status=draft')).env).total).toBe(0);
    expect((await listIssues('?status=weekly')).status).toBe(400);
  });
});

