import 'server-only';

import { eq } from 'drizzle-orm';

import type {
  IssueDetailDto,
  IssueListItemDto,
  IssueListResponse,
  IssueOrigin,
  IssuePost,
  IssuePreviewDto,
  IssueStatsDto,
  IssueStatus,
  IssueTestResponse,
} from '@/lib/api/dto';
import { NEWSLETTER_SETTINGS_LIMITS } from '@/lib/api/dto';
import { yearInZone } from '@/lib/format-date';

import { getConfig } from '../../config';
import { getDb, type Executor } from '../../db/client';
import { site, type NewsletterIssueRow, type SiteRow } from '../../db/schema';
import { ApiError } from '../../http/api';
import { log, maskEmail } from '../../log';
import { SENDING_STALE_MS } from '../constants';
import { consentLine, unsubscribeUrl, UNSUBSCRIBE_PATH } from '../links';
import { getMailTransport, MailError } from '../mail';
import * as listRepo from '../repo';

import { renderIntro } from './intro';
import { fillPlaceholders, renderIssueHtml, renderIssueText } from './render';
import * as repo from './repo';
import { postsInvalid, postsOf, snapshotPosts } from './snapshot';

// Issues service (spec/architecture.md §13.5 service.ts; capability newsletter-issues.md): create /
// edit / delete drafts, preview (re-snapshot a draft from the published revisions), test message to
// the signed-in admin. Sending lives in send.ts, automatic creation in triggers.ts. Every write
// appends its send-log event in the same transaction as the row change.

const L = NEWSLETTER_SETTINGS_LIMITS;

export interface IssueActor {
  /** null = the system (publish hook / tick). */
  userId: string | null;
  requestId?: string;
}

export function issueNotFound(): ApiError {
  return new ApiError('NOT_FOUND', 404, 'That issue isn’t here.');
}

/** `sending` with no progress for SENDING_STALE_MS: Try again is allowed (it resumes from the frozen bodies
 *  and reuses a campaign that already exists; starting a running campaign is a no-op at the provider). */
export function isStuckSending(row: Pick<NewsletterIssueRow, 'status' | 'updatedAt'>, now = new Date()): boolean {
  return row.status === 'sending' && row.updatedAt.getTime() < now.getTime() - SENDING_STALE_MS;
}

export function issueNotDraft(status: IssueStatus, action: string): ApiError {
  return new ApiError('ISSUE_NOT_DRAFT', 409, `This issue is ${status} — only a draft can be ${action}.`, { status });
}

export async function siteRowById(db: Executor, siteId: string, lock = false): Promise<SiteRow> {
  const q = db.select().from(site).where(eq(site.id, siteId)).limit(1);
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw new ApiError('NOT_FOUND', 404, 'This site no longer exists — run: pnpm db:seed');
  return row;
}

// ---------------------------------------------------------------------------------------------
// DTOs

function statsOf(raw: unknown): IssueStatsDto | null {
  return raw && typeof raw === 'object' ? (raw as IssueStatsDto) : null;
}

export function issueListItem(row: NewsletterIssueRow): IssueListItemDto {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    origin: row.origin,
    title: row.title,
    postCount: row.articleIds.length,
    recipientCount: row.recipientCount,
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    lastError: row.lastError,
  };
}

export async function issueDetail(db: Executor, row: NewsletterIssueRow): Promise<IssueDetailDto> {
  const events = await repo.issueEvents(db, row.id);
  const names = await repo.userNames(db, [row.createdBy, row.sentBy, ...events.map((e) => e.actorUserId)]);
  const name = (id: string | null) => (id ? (names.get(id) ?? null) : null);
  return {
    ...issueListItem(row),
    introMd: row.introMd,
    posts: postsOf(row.posts),
    providerCampaignId: row.providerCampaignId,
    stats: statsOf(row.stats),
    createdBy: name(row.createdBy),
    sentBy: name(row.sentBy),
    events: events.map((e) => ({ id: e.id, kind: e.kind, actor: name(e.actorUserId), details: e.details, createdAt: e.createdAt.toISOString() })),
    editable: row.status === 'draft',
    stuckSending: isStuckSending(row),
  };
}

export async function getIssue(siteId: string, id: string): Promise<IssueDetailDto> {
  const db = getDb();
  const row = await repo.findIssue(db, siteId, id);
  if (!row) throw issueNotFound();
  return issueDetail(db, row);
}

export async function listIssues(siteId: string, status?: IssueStatus): Promise<IssueListResponse> {
  const db = getDb();
  const rows = await repo.listIssueRows(db, siteId, status);
  const counts = await listRepo.countsOf(db, siteId);
  return { issues: rows.map(issueListItem), total: rows.length, confirmedCount: counts.confirmed };
}

// ---------------------------------------------------------------------------------------------
// Create / update / delete

export interface NewIssueInput {
  origin: IssueOrigin;
  title: string;
  introMd: string;
  articleIds: string[];
  createdBy: string | null;
  now?: Date;
  /** For the `created` event's details (e.g. `{ trigger: 'publish' }`). */
  details?: Record<string, unknown>;
}

function checkPostCount(articleIds: string[]): void {
  if (articleIds.length < L.issuePosts[0] || articleIds.length > L.issuePosts[1]) {
    throw postsInvalid(articleIds, `An issue holds ${L.issuePosts[0]}–${L.issuePosts[1]} articles.`);
  }
}

/** Inside a transaction that already holds the site row lock (number = max + 1). */
export async function insertIssueLocked(tx: Executor, siteRow: SiteRow, input: NewIssueInput): Promise<NewsletterIssueRow> {
  checkPostCount(input.articleIds);
  const now = input.now ?? new Date();
  const posts = await snapshotPosts(tx, siteRow.id, input.articleIds, siteRow.timezone);
  const number = await repo.nextIssueNumber(tx, siteRow.id);
  const row = await repo.insertIssue(tx, {
    siteId: siteRow.id,
    number,
    status: 'draft',
    origin: input.origin,
    title: input.title.slice(0, L.issueTitle),
    introMd: input.introMd.slice(0, L.issueIntroMd),
    posts,
    articleIds: input.articleIds,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  });
  await repo.appendIssueEvent(tx, {
    siteId: siteRow.id,
    issueId: row.id,
    kind: 'created',
    actorUserId: input.createdBy,
    details: { origin: input.origin, postCount: posts.length, ...(input.details ?? {}) },
    createdAt: now,
  });
  return row;
}

function logIssue(row: NewsletterIssueRow, action: string, outcome: string, extra: Record<string, unknown> = {}): void {
  log.info('newsletter.issue', { issue_id: row.id, number: row.number, origin: row.origin, action, outcome, ...extra });
}

/** POST /api/admin/newsletter/issues — a manual draft. */
export async function createIssue(siteId: string, input: NewIssueInput, actor: IssueActor): Promise<IssueDetailDto> {
  const db = getDb();
  const row = await db.transaction(async (tx) => {
    const siteRow = await siteRowById(tx, siteId, true);
    return insertIssueLocked(tx, siteRow, input);
  });
  logIssue(row, 'created', 'ok', { user_id: actor.userId ?? undefined, request_id: actor.requestId });
  return issueDetail(db, row);
}

export interface IssuePatch {
  title?: string;
  introMd?: string;
  articleIds?: string[];
}

/** PATCH …/issues/:id — draft only; `articleIds` = the new order / subset (re-snapshotted). */
export async function updateIssue(siteId: string, id: string, patch: IssuePatch, actor: IssueActor): Promise<IssueDetailDto> {
  const db = getDb();
  const row = await db.transaction(async (tx) => {
    const current = await repo.findIssue(tx, siteId, id, true);
    if (!current) throw issueNotFound();
    if (current.status !== 'draft') throw issueNotDraft(current.status, 'edited');
    const set: Partial<NewsletterIssueRow> = {};
    const fields: string[] = [];
    if (patch.title !== undefined && patch.title !== current.title) {
      set.title = patch.title;
      fields.push('title');
    }
    if (patch.introMd !== undefined && patch.introMd !== current.introMd) {
      set.introMd = patch.introMd;
      fields.push('introMd');
    }
    if (patch.articleIds !== undefined) {
      checkPostCount(patch.articleIds);
      const siteRow = await siteRowById(tx, siteId);
      set.posts = await snapshotPosts(tx, siteId, patch.articleIds, siteRow.timezone);
      if (patch.articleIds.join(',') !== current.articleIds.join(',')) fields.push('articleIds');
      set.articleIds = patch.articleIds;
    }
    if (Object.keys(set).length === 0) return current;
    const updated = await repo.updateIssueRow(tx, current.id, set);
    if (fields.length > 0) {
      await repo.appendIssueEvent(tx, { siteId, issueId: current.id, kind: 'updated', actorUserId: actor.userId, details: { fields } });
    }
    return updated;
  });
  logIssue(row, 'updated', 'ok', { user_id: actor.userId ?? undefined, request_id: actor.requestId });
  return issueDetail(db, row);
}

/** DELETE …/issues/:id — draft only (its events cascade; test messages keep their row, unlinked). */
export async function deleteIssue(siteId: string, id: string, actor: IssueActor): Promise<void> {
  const row = await getDb().transaction(async (tx) => {
    const current = await repo.findIssue(tx, siteId, id, true);
    if (!current) throw issueNotFound();
    if (current.status !== 'draft') throw issueNotDraft(current.status, 'deleted');
    await repo.deleteIssueRow(tx, current.id);
    return current;
  });
  logIssue(row, 'deleted', 'ok', { user_id: actor.userId ?? undefined, request_id: actor.requestId });
}

// ---------------------------------------------------------------------------------------------
// Rendering, preview, test

export interface RenderedIssue {
  subject: string;
  html: string;
  text: string;
}

/** Subject + bodies (with the two provider placeholders) from an issue's model. */
export function renderIssue(row: Pick<NewsletterIssueRow, 'title' | 'introMd' | 'number'>, posts: IssuePost[], siteRow: SiteRow, now: Date = new Date()): RenderedIssue {
  const intro = renderIntro(row.introMd);
  const input = {
    brand: siteRow.brandName,
    publisherName: siteRow.publisherName,
    publicBaseUrl: getConfig().publicBaseUrl,
    title: row.title,
    introHtml: intro.html,
    introText: intro.text,
    posts,
    number: row.number,
    year: yearInZone(now, siteRow.timezone),
  };
  return { subject: row.title, html: renderIssueHtml(input), text: renderIssueText(input) };
}

/**
 * A draft re-snapshots its posts from the current published revisions (persisted when something
 * changed); other statuses keep their snapshot. Returns the row as it now stands.
 */
export async function refreshDraftSnapshot(siteId: string, row: NewsletterIssueRow, siteRow: SiteRow): Promise<{ row: NewsletterIssueRow; changed: boolean }> {
  if (row.status !== 'draft') return { row, changed: false };
  const posts = await snapshotPosts(getDb(), siteId, row.articleIds, siteRow.timezone);
  if (JSON.stringify(posts) === JSON.stringify(postsOf(row.posts))) return { row, changed: false };
  const updated = await repo.updateIssueRow(getDb(), row.id, { posts });
  return { row: updated, changed: true };
}

/** The bodies the issue is (or will be) sent with: frozen ones once sending started, else rendered now. */
export function bodiesOf(row: NewsletterIssueRow, siteRow: SiteRow, now = new Date()): RenderedIssue {
  if (row.status !== 'draft' && row.renderedHtml !== null && row.renderedText !== null) {
    return { subject: row.title, html: row.renderedHtml, text: row.renderedText };
  }
  return renderIssue(row, postsOf(row.posts), siteRow, now);
}

/** Sample values for the admin: their own subscriber row's link + line when they are subscribed, else placeholders that read like the real thing. */
export async function sampleRecipient(siteRow: SiteRow, email: string, now = new Date()): Promise<{ email: string; unsubscribeUrl: string; consentLine: string }> {
  const sub = await listRepo.findByEmail(getDb(), siteRow.id, email.toLowerCase());
  if (sub && sub.status === 'confirmed') return { email, unsubscribeUrl: unsubscribeUrl(sub.id), consentLine: consentLine(sub, siteRow) };
  const base = getConfig().publicBaseUrl.replace(/\/+$/, '');
  return {
    email,
    unsubscribeUrl: `${base}${UNSUBSCRIBE_PATH}?t=sample`,
    consentLine: consentLine({ consentedAt: now, confirmedAt: now, createdAt: now, source: 'footer' }, siteRow),
  };
}

async function loadForRender(siteId: string, id: string): Promise<{ row: NewsletterIssueRow; siteRow: SiteRow }> {
  const db = getDb();
  const found = await repo.findIssue(db, siteId, id);
  if (!found) throw issueNotFound();
  const siteRow = await siteRowById(db, siteId);
  const { row } = await refreshDraftSnapshot(siteId, found, siteRow);
  return { row, siteRow };
}

/** GET …/issues/:id/preview — the HTML + text exactly as sent, with sample values for the admin. */
export async function previewIssue(siteId: string, id: string, admin: { email: string }, now = new Date()): Promise<IssuePreviewDto> {
  const { row, siteRow } = await loadForRender(siteId, id);
  const bodies = bodiesOf(row, siteRow, now);
  const sample = await sampleRecipient(siteRow, admin.email, now);
  return {
    subject: bodies.subject,
    html: fillPlaceholders(bodies.html, sample, 'html'),
    text: fillPlaceholders(bodies.text, sample, 'text'),
    sampleRecipient: { email: sample.email, consentLine: sample.consentLine },
  };
}

/** POST …/issues/:id/test — `[Test] <title>` to the signed-in admin through the transactional transport. Status unchanged. */
export async function sendTest(siteId: string, id: string, admin: { id: string; email: string }, requestId?: string): Promise<IssueTestResponse> {
  const { row, siteRow } = await loadForRender(siteId, id);
  const bodies = bodiesOf(row, siteRow);
  const sample = await sampleRecipient(siteRow, admin.email);
  const transport = getMailTransport();
  let result;
  try {
    result = await transport.send({
      to: admin.email,
      subject: `[Test] ${bodies.subject}`,
      html: fillPlaceholders(bodies.html, sample, 'html'),
      text: fillPlaceholders(bodies.text, sample, 'text'),
      kind: 'test_issue',
      issueId: row.id,
      requestId,
    });
  } catch (err) {
    logIssue(row, 'test_sent', 'failed', { user_id: admin.id, request_id: requestId, err_code: 'MAIL_FAILED' });
    if (err instanceof MailError) throw new ApiError('MAIL_FAILED', 502, err.message);
    throw err;
  }
  await repo.appendIssueEvent(getDb(), {
    siteId,
    issueId: row.id,
    kind: 'test_sent',
    actorUserId: admin.id,
    details: { toEmail: admin.email, transport: result.transport, messageId: result.messageId },
  });
  logIssue(row, 'test_sent', 'ok', { user_id: admin.id, request_id: requestId, to_masked: maskEmail(admin.email) });
  return { sentTo: admin.email, transport: result.transport, messageId: result.messageId };
}
