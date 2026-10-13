import 'server-only';

import type { IssueDetailDto, IssueStatsDto } from '@/lib/api/dto';

import { getConfig } from '../../config';
import { getDb } from '../../db/client';
import type { NewsletterIssueRow } from '../../db/schema';
import { ApiError } from '../../http/api';
import { log } from '../../log';
import * as listRepo from '../repo';
import { getNewsletterSender } from '../sender';
import { syncAll } from '../sender/sync';
import type { NewsletterSender } from '../sender/types';

import * as repo from './repo';
import { postsOf, snapshotPosts } from './snapshot';
import { issueDetail, issueNotDraft, issueNotFound, renderIssue, siteRowById, type IssueActor } from './service';

// Sending (spec/architecture.md §13.5 send.ts; capability newsletter-issues.md "Send"): one
// transaction freezes the bodies and moves the issue `draft|failed → sending` (event
// `send_requested`); then, outside it: (listmonk) blog0 → provider sync → campaign created once and
// persisted at once (`provider_created`) → started (`provider_started`) → `sent`. Any failure →
// `failed` + `last_error` + event `failed`, answered as 502 SENDER_FAILED; **Try again** repeats
// from the failed step and reuses a campaign that already exists.

const HEALTH_TIMEOUT_MS = 3_000;

export interface SendOptions {
  sender?: NewsletterSender;
  now?: Date;
}

/** `healthcheck()` bounded to 3 s (a hung provider must not hang the settings page or a send). */
export async function healthWithTimeout(sender: NewsletterSender, ms = HEALTH_TIMEOUT_MS): Promise<{ ok: boolean; message: string; listName?: string }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ ok: boolean; message: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, message: `no answer within ${ms / 1000} s` }), ms);
  });
  try {
    return await Promise.race([sender.healthcheck().catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e) })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function senderHost(): string {
  const url = getConfig().newsletter.listmonk?.url;
  if (!url) return 'Listmonk';
  try {
    return new URL(url).host;
  } catch {
    return 'Listmonk';
  }
}

export function senderUnavailable(detail?: string): ApiError {
  return new ApiError(
    'SENDER_UNAVAILABLE',
    503,
    `The newsletter sender at ${senderHost()} isn’t reachable — check that Listmonk is running and BLOG0_LISTMONK_* in .env.`,
    detail ? { reason: detail.slice(0, 200) } : undefined,
  );
}

/** Listmonk only: refuse before touching the issue when the provider is down. */
export async function requireHealthySender(sender: NewsletterSender): Promise<void> {
  if (sender.kind === 'stub') return;
  const health = await healthWithTimeout(sender);
  if (!health.ok) throw senderUnavailable(health.message);
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/** POST …/issues/:id/send (and auto-send with `actor.userId = null`). */
export async function sendIssue(siteId: string, id: string, actor: IssueActor, options: SendOptions = {}): Promise<IssueDetailDto> {
  const sender = options.sender ?? getNewsletterSender();
  const db = getDb();
  await requireHealthySender(sender);

  // 1. Freeze + `sending` in one transaction.
  const frozen = await db.transaction(async (tx) => {
    const row = await repo.findIssue(tx, siteId, id, true);
    if (!row) throw issueNotFound();
    if (row.status !== 'draft' && row.status !== 'failed') throw issueNotDraft(row.status, 'sent');
    const counts = await listRepo.countsOf(tx, siteId);
    if (counts.confirmed === 0) throw new ApiError('NO_RECIPIENTS', 409, 'There are no confirmed subscribers to send to yet.');
    const siteRow = await siteRowById(tx, siteId);
    const now = options.now ?? new Date();
    let posts = postsOf(row.posts);
    let html = row.renderedHtml;
    let text = row.renderedText;
    if (row.status === 'draft' || html === null || text === null) {
      if (row.status === 'draft') posts = await snapshotPosts(tx, siteId, row.articleIds, siteRow.timezone);
      const bodies = renderIssue(row, posts, siteRow, now);
      html = bodies.html;
      text = bodies.text;
    }
    const updated = await repo.updateIssueRow(tx, row.id, {
      status: 'sending',
      posts,
      renderedHtml: html,
      renderedText: text,
      recipientCount: counts.confirmed,
      lastError: null,
      updatedAt: now,
    });
    await repo.appendIssueEvent(tx, {
      siteId,
      issueId: row.id,
      kind: 'send_requested',
      actorUserId: actor.userId,
      details: { recipientCount: counts.confirmed, sender: sender.kind, retry: row.status === 'failed' },
    });
    return updated;
  });

  // 2. Provider steps, outside the transaction.
  let row: NewsletterIssueRow = frozen;
  let step: 'sync' | 'create' | 'start' | 'finish' = 'sync';
  try {
    if (sender.kind === 'listmonk') {
      const sync = await syncAll('send', { sender, siteId });
      if (sync.errors.length > 0) log.warn('newsletter.issue', { issue_id: row.id, number: row.number, origin: row.origin, action: 'send', outcome: 'ok', msg: `pre-send sync had ${sync.errors.length} error(s); sending to the provider's list as it stands` });
    }
    step = 'create';
    let campaignId = row.providerCampaignId;
    if (campaignId === null) {
      campaignId = (await sender.createIssue({ issueId: row.id, number: row.number, subject: row.title, html: row.renderedHtml as string, text: row.renderedText as string })).campaignId;
      row = await db.transaction(async (tx) => {
        const updated = await repo.updateIssueRow(tx, row.id, { providerCampaignId: campaignId });
        await repo.appendIssueEvent(tx, { siteId, issueId: row.id, kind: 'provider_created', actorUserId: actor.userId, details: { campaignId, sender: sender.kind } });
        return updated;
      });
    }
    step = 'start';
    await sender.sendIssue(campaignId);
    await repo.appendIssueEvent(db, { siteId, issueId: row.id, kind: 'provider_started', actorUserId: actor.userId, details: { campaignId } });
    step = 'finish';
    const sentAt = new Date();
    row = await db.transaction(async (tx) => {
      const updated = await repo.updateIssueRow(tx, row.id, { status: 'sent', sentAt, sentBy: actor.userId, lastError: null, updatedAt: sentAt });
      await repo.appendIssueEvent(tx, { siteId, issueId: row.id, kind: 'sent', actorUserId: actor.userId, details: { recipientCount: row.recipientCount, campaignId } });
      return updated;
    });
    log.info('newsletter.issue', {
      issue_id: row.id,
      number: row.number,
      origin: row.origin,
      action: 'send',
      outcome: 'sent',
      recipient_count: row.recipientCount,
      campaign_id: campaignId,
      user_id: actor.userId ?? undefined,
      request_id: actor.requestId,
    });
    return issueDetail(db, row);
  } catch (err) {
    const message = errorText(err);
    const failed = await db.transaction(async (tx) => {
      const updated = await repo.updateIssueRow(tx, row.id, { status: 'failed', lastError: message });
      await repo.appendIssueEvent(tx, { siteId, issueId: row.id, kind: 'failed', actorUserId: actor.userId, details: { error: message, step } });
      return updated;
    });
    log.warn('newsletter.issue', {
      issue_id: row.id,
      number: row.number,
      origin: row.origin,
      action: 'send',
      outcome: 'failed',
      step,
      campaign_id: failed.providerCampaignId ?? undefined,
      user_id: actor.userId ?? undefined,
      request_id: actor.requestId,
      err_code: 'SENDER_FAILED',
      err_message: message,
    });
    throw new ApiError('SENDER_FAILED', 502, `Couldn’t send: ${message}`, { issue: await issueDetail(db, failed) });
  }
}

/** POST …/issues/:id/stats — fresh numbers from the provider (never changes the status). */
export async function refreshStats(siteId: string, id: string, actor: IssueActor, options: SendOptions = {}): Promise<IssueDetailDto> {
  const sender = options.sender ?? getNewsletterSender();
  const db = getDb();
  const row = await repo.findIssue(db, siteId, id);
  if (!row) throw issueNotFound();
  if (row.status === 'draft') throw new ApiError('ISSUE_NOT_DRAFT', 409, 'This issue hasn’t been sent yet — there are no stats.', { status: row.status });
  if (row.providerCampaignId === null) throw new ApiError('ISSUE_NOT_DRAFT', 409, 'This issue never reached the sender — there are no stats.', { status: row.status });
  let stats: IssueStatsDto;
  try {
    const fetched = await sender.fetchStats(row.providerCampaignId);
    stats = { ...fetched, fetchedAt: (options.now ?? new Date()).toISOString() };
  } catch (err) {
    log.warn('newsletter.issue', { issue_id: row.id, number: row.number, origin: row.origin, action: 'stats', outcome: 'failed', err_code: 'SENDER_FAILED', err_message: errorText(err) });
    throw new ApiError('SENDER_FAILED', 502, `Couldn’t fetch stats: ${errorText(err)}`);
  }
  const updated = await db.transaction(async (tx) => {
    const next = await repo.updateIssueRow(tx, row.id, { stats });
    await repo.appendIssueEvent(tx, { siteId, issueId: row.id, kind: 'stats_fetched', actorUserId: actor.userId, details: { stats } });
    return next;
  });
  log.info('newsletter.issue', { issue_id: row.id, number: row.number, origin: row.origin, action: 'stats', outcome: 'ok', campaign_id: row.providerCampaignId, user_id: actor.userId ?? undefined });
  return issueDetail(db, updated);
}
