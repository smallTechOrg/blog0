import 'server-only';

import { and, asc, eq, gte, inArray } from 'drizzle-orm';

import { getDb, type Executor } from '../../db/client';
import { article, articleRevision, type NewsletterIssueRow, type SiteRow } from '../../db/schema';
import { ApiError } from '../../http/api';
import { log } from '../../log';
import { publishedWhere } from '../../public/articles';
import type { NewsletterSender } from '../sender/types';

import { digestTitle, dueDigest, type DigestDue } from './digest';
import * as repo from './repo';
import { sendIssue } from './send';
import { insertIssueLocked, siteRowById } from './service';

// Automatic issues (spec/architecture.md §13.5 triggers.ts; capability newsletter-issues.md "Modes").
// `onArticleFirstPublished` runs AFTER publishArticle's transaction committed, only on a first
// publish, and never throws into the publish. `manual` creates nothing; `per_post` one draft per
// first publish; `digest` one draft when the posts threshold is reached (the days threshold is
// applied by `pnpm newsletter:tick` — runDigestTick). An article goes in at most one automatic
// issue. Only `newsletter_auto_send = true` sends without a click.

const MAX_POSTS = 10;

export interface FirstPublishEvent {
  siteId: string;
  articleId: string;
  now?: Date;
  requestId?: string;
}

export interface TriggerOptions {
  sender?: NewsletterSender;
}

export interface DigestCandidates {
  anchorAt: Date | null;
  lastIssueAt: Date | null;
  articleIds: string[];
}

/** First-published articles since the digest anchor (last digest issue, else when the mode was set) that are in no automatic issue yet, oldest first. */
export async function digestCandidates(db: Executor, siteRow: SiteRow): Promise<DigestCandidates> {
  const lastIssueAt = await repo.lastDigestIssueAt(db, siteRow.id);
  const anchorAt = lastIssueAt ?? siteRow.newsletterModeSetAt ?? null;
  const where = [publishedWhere(siteRow.id)];
  if (anchorAt) where.push(gte(article.firstPublishedAt, anchorAt));
  const rows = await db
    .select({ id: article.id })
    .from(article)
    .where(and(...where))
    .orderBy(asc(article.firstPublishedAt), asc(article.id));
  const taken = await repo.automaticArticleIds(db, siteRow.id);
  return { anchorAt, lastIssueAt, articleIds: rows.map((r) => r.id).filter((id) => !taken.has(id)) };
}

/** Settings status card (digest mode): `{ lastIssueAt, newPostsSince, dueAt }`. */
export async function digestStatus(siteRow: SiteRow, now = new Date()): Promise<{ lastIssueAt: string | null; newPostsSince: number; dueAt: string | null }> {
  const c = await digestCandidates(getDb(), siteRow);
  const due = dueDigest({ digestDays: siteRow.newsletterDigestDays, digestPosts: siteRow.newsletterDigestPosts }, c.anchorAt, c.articleIds.length, now);
  return { lastIssueAt: c.lastIssueAt ? c.lastIssueAt.toISOString() : null, newPostsSince: c.articleIds.length, dueAt: due.dueAt ? due.dueAt.toISOString() : null };
}

type DigestTrigger = 'publish' | 'tick';

/** Under the site lock: creates the digest draft when due (`publish` honours the posts rule only; `tick` both). */
async function createDigestIfDue(siteId: string, now: Date, trigger: DigestTrigger): Promise<{ issue: NewsletterIssueRow | null; due: DigestDue }> {
  return getDb().transaction(async (tx) => {
    const siteRow = await siteRowById(tx, siteId, true);
    if (siteRow.newsletterMode !== 'digest') return { issue: null, due: { due: false, reason: null, dueAt: null } };
    const c = await digestCandidates(tx, siteRow);
    const due = dueDigest({ digestDays: siteRow.newsletterDigestDays, digestPosts: siteRow.newsletterDigestPosts }, c.anchorAt, c.articleIds.length, now);
    const fire = due.due && (trigger === 'tick' || due.reason === 'posts');
    if (!fire) return { issue: null, due };
    const articleIds = c.articleIds.slice(0, MAX_POSTS);
    const issue = await insertIssueLocked(tx, siteRow, {
      origin: 'digest',
      title: digestTitle(siteRow.brandName, articleIds.length),
      introMd: '',
      articleIds,
      createdBy: null,
      now,
      details: { trigger, reason: due.reason },
    });
    return { issue, due };
  });
}

async function createPerPost(siteId: string, articleId: string, now: Date): Promise<NewsletterIssueRow | null> {
  return getDb().transaction(async (tx) => {
    const siteRow = await siteRowById(tx, siteId, true);
    if (siteRow.newsletterMode !== 'per_post') return null;
    const taken = await repo.automaticArticleIds(tx, siteId);
    if (taken.has(articleId)) return null;
    const [post] = await tx
      .select({ title: articleRevision.title, dek: articleRevision.dek })
      .from(article)
      .innerJoin(articleRevision, eq(articleRevision.id, article.publishedRevisionId))
      .where(and(publishedWhere(siteId), inArray(article.id, [articleId])))
      .limit(1);
    if (!post) return null;
    return insertIssueLocked(tx, siteRow, { origin: 'per_post', title: post.title, introMd: post.dek, articleIds: [articleId], createdBy: null, now, details: { trigger: 'publish' } });
  });
}

/** Auto-send (only when the site says so). NO_RECIPIENTS leaves the draft waiting; other failures are already recorded on the issue. */
async function autoSend(siteId: string, issue: NewsletterIssueRow, requestId: string | undefined, options: TriggerOptions): Promise<void> {
  try {
    await sendIssue(siteId, issue.id, { userId: null, requestId }, { sender: options.sender });
  } catch (err) {
    const code = err instanceof ApiError ? err.code : 'INTERNAL';
    log.warn('newsletter.issue', {
      issue_id: issue.id,
      number: issue.number,
      origin: issue.origin,
      action: 'send',
      outcome: code === 'NO_RECIPIENTS' ? 'skipped' : 'failed',
      err_code: code,
      request_id: requestId,
      msg: code === 'NO_RECIPIENTS' ? 'Auto-send skipped: no confirmed subscribers; the issue stays a draft' : 'Auto-send failed; the issue shows the error',
    });
  }
}

function logCreated(issue: NewsletterIssueRow, requestId?: string): void {
  log.info('newsletter.issue', { issue_id: issue.id, number: issue.number, origin: issue.origin, action: 'created', outcome: 'ok', request_id: requestId });
}

/** The publish hook. Never throws: the article is already published when this runs. */
export async function onArticleFirstPublished(event: FirstPublishEvent, options: TriggerOptions = {}): Promise<NewsletterIssueRow | null> {
  const now = event.now ?? new Date();
  try {
    const siteRow = await siteRowById(getDb(), event.siteId);
    let issue: NewsletterIssueRow | null = null;
    if (siteRow.newsletterMode === 'per_post') issue = await createPerPost(event.siteId, event.articleId, now);
    else if (siteRow.newsletterMode === 'digest') issue = (await createDigestIfDue(event.siteId, now, 'publish')).issue;
    if (!issue) return null;
    logCreated(issue, event.requestId);
    if (siteRow.newsletterAutoSend) {
      await autoSend(event.siteId, issue, event.requestId, options);
      return (await repo.findIssue(getDb(), event.siteId, issue.id)) ?? issue;
    }
    return issue;
  } catch (err) {
    log.warn('newsletter.issue', {
      action: 'created',
      outcome: 'failed',
      article_id: event.articleId,
      request_id: event.requestId,
      err_code: err instanceof ApiError ? err.code : 'INTERNAL',
      err_message: err instanceof Error ? err.message : String(err),
      msg: 'Publish hook failed; the article is published, no issue was created',
    });
    return null;
  }
}

/** `pnpm newsletter:tick`: the digest days rule without waiting for a publish (+ auto-send when on). */
export async function runDigestTick(siteId: string, now: Date, options: TriggerOptions = {}): Promise<NewsletterIssueRow | null> {
  const { issue } = await createDigestIfDue(siteId, now, 'tick');
  if (!issue) return null;
  logCreated(issue);
  const siteRow = await siteRowById(getDb(), siteId);
  if (siteRow.newsletterAutoSend) {
    await autoSend(siteId, issue, undefined, options);
    return (await repo.findIssue(getDb(), siteId, issue.id)) ?? issue;
  }
  return issue;
}
