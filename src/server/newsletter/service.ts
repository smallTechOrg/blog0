import 'server-only';

import type { SubscriberCounts, SubscriberDetailDto, SubscriberDto, SubscriberListResponse } from '@/lib/api/dto';

import { inArray } from 'drizzle-orm';

import { getConfig } from '../config';
import { getDb, type Executor } from '../db/client';
import { appUser, newsletterSubscriber, type NewsletterSubscriberRow, type SiteRow } from '../db/schema';
import { ApiError } from '../http/api';
import { log, maskEmail } from '../log';
import { getCurrentSite } from '../site/current';

import { CONFIRM_TOKEN_TTL_MS, CONFIRMATION_CAP_WINDOW_MS, CONFIRMATION_SENDS_PER_DAY, USER_AGENT_MAX } from './constants';
import { MailError, sendConfirmationMail } from './mail';
import { isKnownClientIp } from './rate-limit';
import * as repo from './repo';
import type { SubscribeInput } from './schemas';
import { afterConfirm, afterSuppress } from './sender-hook';
import { hashConfirmToken, isWellFormedConfirmToken, newConfirmToken, verifyUnsubscribeToken } from './tokens';

// The owned list (capability newsletter-list.md; HOW spec/architecture.md §13.1). blog0 is the
// source of truth: every status change commits here first, then the sender hook gets a copy.
// Every write path appends its event in the same transaction as the row change; the confirmation
// email goes out AFTER the signup commits (a failed send never loses a signup).

export type NewsletterStatus = NewsletterSubscriberRow['status'];
export const SUPPRESSED_STATUSES: readonly NewsletterStatus[] = ['unsubscribed', 'bounced'];

/** Who / where a reader action came from (spec §6 client-IP derivation: IP only when real). */
export interface RequestContext {
  /** From clientIpFromRequest(); `direct`/`unknown` → stored as null. */
  ip: string;
  userAgent: string | null;
  requestId?: string;
  now?: Date;
}

export function requestContextFrom(request: Request, ip: string, now?: Date): RequestContext {
  return { ip, userAgent: request.headers.get('user-agent'), requestId: request.headers.get('x-request-id') ?? undefined, now };
}

function storedIp(ip: string): string | null {
  return isKnownClientIp(ip) ? ip : null;
}

function storedUa(ua: string | null): string | null {
  const v = (ua ?? '').trim();
  return v ? v.slice(0, USER_AGENT_MAX) : null;
}

export type SignupOutcome = 'pending_created' | 'pending_renewed' | 'noop_confirmed' | 'noop_capped' | 'resignup';

export interface SignupResult {
  outcome: SignupOutcome;
  subscriber: NewsletterSubscriberRow;
  /** Set when a confirmation email was attempted. */
  mail?: { outcome: 'sent' | 'stubbed' | 'failed'; transport: 'smtp' | 'stub' };
}

/**
 * Footer signup. One transaction decides the outcome and writes the row + `signup` event; the
 * confirmation email is sent after commit and recorded as a `confirmation_sent` event with its outcome.
 */
export async function subscribe(ctx: RequestContext, input: SubscribeInput, site?: SiteRow): Promise<SignupResult> {
  const current = site ?? (await getCurrentSite());
  const now = ctx.now ?? new Date();
  const ip = storedIp(ctx.ip);
  const ua = storedUa(ctx.userAgent);
  const db = getDb();

  const decided = await db.transaction(async (tx) => {
    const existing = await repo.findByEmail(tx, current.id, input.email, true);
    const consent = {
      consentText: current.newsletterConsentText,
      consentVersion: current.newsletterConsentVersion,
      consentedAt: now,
      signupSourceUrl: input.sourceUrl,
      signupIp: ip,
      signupUserAgent: ua,
    };

    if (!existing) {
      const { token, hash } = newConfirmToken();
      const [row] = await tx
        .insert(newsletterSubscriber)
        .values({
          siteId: current.id,
          email: input.email,
          name: input.name,
          status: 'pending',
          source: 'footer',
          ...consent,
          confirmTokenHash: hash,
          confirmTokenExpiresAt: new Date(now.getTime() + CONFIRM_TOKEN_TTL_MS),
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await repo.appendEvent(tx, {
        siteId: current.id,
        subscriberId: row.id,
        email: row.email,
        kind: 'signup',
        source: 'footer',
        actorUserId: null,
        ip,
        userAgent: ua,
        details: { sourceUrl: input.sourceUrl, consentVersion: current.newsletterConsentVersion },
        createdAt: now,
      });
      return { outcome: 'pending_created' as const, row, token: token as string | null };
    }

    if (existing.status === 'confirmed') {
      return { outcome: 'noop_confirmed' as const, row: existing, token: null };
    }

    const resignup = existing.status !== 'pending';
    const sends = await repo.confirmationSendsSince(tx, existing.id, new Date(now.getTime() - CONFIRMATION_CAP_WINDOW_MS));
    const capped = sends.n >= CONFIRMATION_SENDS_PER_DAY;
    // A capped renewal keeps the token already in the reader's inbox; everything else issues a fresh one.
    const fresh = resignup || !capped ? newConfirmToken() : null;
    const row = await repo.updateSubscriber(tx, existing.id, {
      status: 'pending',
      source: 'footer',
      name: input.name ?? existing.name,
      ...consent,
      ...(fresh
        ? { confirmTokenHash: fresh.hash, confirmTokenExpiresAt: new Date(now.getTime() + CONFIRM_TOKEN_TTL_MS) }
        : {}),
      updatedAt: now,
    });
    await repo.appendEvent(tx, {
      siteId: current.id,
      subscriberId: row.id,
      email: row.email,
      kind: 'signup',
      source: 'footer',
      actorUserId: null,
      ip,
      userAgent: ua,
      details: {
        sourceUrl: input.sourceUrl,
        consentVersion: current.newsletterConsentVersion,
        ...(resignup ? { resignup: true, previousStatus: existing.status } : {}),
        ...(capped && !resignup ? { capped: true } : {}),
      },
      createdAt: now,
    });
    const outcome = resignup ? ('resignup' as const) : capped ? ('noop_capped' as const) : ('pending_renewed' as const);
    return { outcome, row, token: fresh && (resignup || !capped) ? fresh.token : null };
  });

  log.info('newsletter.signup', {
    msg: `Newsletter signup: ${decided.outcome}`,
    request_id: ctx.requestId,
    email_masked: maskEmail(input.email),
    outcome: decided.outcome,
    source_url: input.sourceUrl,
    consent_version: current.newsletterConsentVersion,
  });

  if (!decided.token) return { outcome: decided.outcome, subscriber: decided.row };
  const mail = await deliverConfirmation(decided.row, decided.token, current, { kind: 'confirmation_sent', source: 'footer', ip, ua, now, requestId: ctx.requestId });
  return { outcome: decided.outcome, subscriber: mail.subscriber, mail: mail.result };
}

interface DeliveryEvent {
  kind: 'confirmation_sent' | 'legacy_confirmation_sent';
  source: 'footer' | 'admin';
  ip: string | null;
  ua: string | null;
  now: Date;
  requestId?: string;
  actorUserId?: string | null;
}

/** Sends the confirmation (after commit) and records the attempt — a failed send never throws here. */
async function deliverConfirmation(
  row: NewsletterSubscriberRow,
  token: string,
  site: SiteRow,
  ev: DeliveryEvent,
): Promise<{ subscriber: NewsletterSubscriberRow; result: NonNullable<SignupResult['mail']> }> {
  let result: NonNullable<SignupResult['mail']>;
  let error: string | undefined;
  try {
    const sent = await sendConfirmationMail(row, token, site, ev.requestId);
    result = { outcome: sent.outcome, transport: sent.transport };
  } catch (err) {
    const transport = err instanceof MailError ? err.transport : 'smtp';
    result = { outcome: 'failed', transport };
    error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  }
  // Strictly after the signup event it follows (same injected clock, +1 ms), so the timeline order holds.
  const at = new Date(ev.now.getTime() + 1);
  const subscriber = await getDb().transaction(async (tx) => {
    const updated = await repo.updateSubscriber(tx, row.id, {
      confirmationSentCount: row.confirmationSentCount + (result.outcome === 'failed' ? 0 : 1),
      updatedAt: at,
    });
    await repo.appendEvent(tx, {
      siteId: row.siteId,
      subscriberId: row.id,
      email: row.email,
      kind: ev.kind,
      source: ev.source,
      actorUserId: ev.actorUserId ?? null,
      ip: ev.ip,
      userAgent: ev.ua,
      details: { outcome: result.outcome, transport: result.transport, ...(error ? { error } : {}) },
      createdAt: at,
    });
    return updated;
  });
  return { subscriber, result };
}

// ---------------------------------------------------------------------------------------------
// Confirm

export interface ConfirmResult {
  alreadyConfirmed: boolean;
  subscriber: NewsletterSubscriberRow;
}

function tokenInvalid(): ApiError {
  return new ApiError('TOKEN_INVALID', 404, 'That link isn’t valid.');
}

function tokenExpired(): ApiError {
  return new ApiError('TOKEN_EXPIRED', 410, 'This link has expired or was already used — sign up again from the footer.');
}

/** The emailed confirm link. 404 TOKEN_INVALID for an unknown token, 410 TOKEN_EXPIRED past 72 h or after use. */
export async function confirmByToken(token: string, ctx: RequestContext, site?: SiteRow): Promise<ConfirmResult> {
  if (!isWellFormedConfirmToken(token)) throw tokenInvalid();
  const current = site ?? (await getCurrentSite());
  const now = ctx.now ?? new Date();
  const hash = hashConfirmToken(token);
  const db = getDb();
  const found = await repo.findByTokenHash(db, current.id, hash);
  if (!found) {
    if (await repo.wasTokenUsed(db, current.id, hash)) throw tokenExpired();
    throw tokenInvalid();
  }
  if (!found.confirmTokenExpiresAt || found.confirmTokenExpiresAt.getTime() < now.getTime()) throw tokenExpired();

  const ip = storedIp(ctx.ip);
  const ua = storedUa(ctx.userAgent);
  const confirmed = await db.transaction(async (tx) => {
    const row = await repo.findById(tx, current.id, found.id, true);
    if (!row || row.confirmTokenHash !== hash) return null;
    const resubscribed = await repo.hasSuppression(tx, row.id);
    const updated = await repo.updateSubscriber(tx, row.id, {
      status: 'confirmed',
      confirmedAt: now,
      confirmedIp: ip,
      confirmedUserAgent: ua,
      confirmTokenHash: null,
      confirmTokenExpiresAt: null,
      updatedAt: now,
    });
    await repo.appendEvent(tx, {
      siteId: current.id,
      subscriberId: row.id,
      email: row.email,
      kind: resubscribed ? 'resubscribed' : 'confirmed',
      source: 'email_link',
      actorUserId: null,
      ip,
      userAgent: ua,
      details: { tokenHash: hash, consentVersion: row.consentVersion, previousStatus: row.status },
      createdAt: now,
    });
    return updated;
  });
  if (!confirmed) throw tokenExpired(); // raced: the token was spent between the lookup and the lock

  await runHook(() => afterConfirm(confirmed), 'confirm', confirmed.id);
  return { alreadyConfirmed: false, subscriber: confirmed };
}

// ---------------------------------------------------------------------------------------------
// Suppress / unsubscribe

export interface SuppressInput {
  reason: 'unsubscribed' | 'bounced' | 'complaint' | 'admin';
  source: 'email_link' | 'one_click' | 'admin' | 'provider' | 'webhook' | 'system';
  details?: Record<string, unknown>;
  actorUserId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  now?: Date;
}

/** One transaction: status (`bounced` for reason `bounced`, else `unsubscribed`), suppression row, event. Then the sender hook. */
export async function suppress(row: NewsletterSubscriberRow, input: SuppressInput): Promise<NewsletterSubscriberRow> {
  const now = input.now ?? new Date();
  const status = input.reason === 'bounced' ? 'bounced' : 'unsubscribed';
  const updated = await getDb().transaction(async (tx) => {
    const locked = await repo.findById(tx, row.siteId, row.id, true);
    if (!locked) throw new ApiError('NOT_FOUND', 404, 'That subscriber no longer exists.');
    const next = await repo.updateSubscriber(tx, locked.id, {
      status,
      unsubscribedAt: now,
      confirmTokenHash: null,
      confirmTokenExpiresAt: null,
      updatedAt: now,
    });
    await repo.appendSuppression(tx, {
      siteId: locked.siteId,
      subscriberId: locked.id,
      email: locked.email,
      reason: input.reason,
      source: input.source,
      details: input.details ?? {},
      createdAt: now,
    });
    await repo.appendEvent(tx, {
      siteId: locked.siteId,
      subscriberId: locked.id,
      email: locked.email,
      kind: status,
      source: input.source,
      actorUserId: input.actorUserId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      details: { reason: input.reason, previousStatus: locked.status, ...(input.details ?? {}) },
      createdAt: now,
    });
    return next;
  });
  await runHook(() => afterSuppress(updated), 'unsubscribe', updated.id);
  return updated;
}

export interface UnsubscribeResult {
  alreadyUnsubscribed: boolean;
  subscriber: NewsletterSubscriberRow;
}

/** The signed unsubscribe link / one-click POST. Idempotent: an already-suppressed row writes nothing. */
export async function unsubscribeByToken(
  token: string,
  source: 'email_link' | 'one_click',
  ctx: RequestContext,
  site?: SiteRow,
): Promise<UnsubscribeResult> {
  const id = verifyUnsubscribeToken(token, getConfig().sessionSecret.reveal());
  if (!id) throw tokenInvalid();
  const current = site ?? (await getCurrentSite());
  const row = await repo.findById(getDb(), current.id, id);
  if (!row) throw tokenInvalid();
  if (SUPPRESSED_STATUSES.includes(row.status)) return { alreadyUnsubscribed: true, subscriber: row };
  const subscriber = await suppress(row, {
    reason: 'unsubscribed',
    source,
    ip: storedIp(ctx.ip),
    userAgent: storedUa(ctx.userAgent),
    now: ctx.now,
  });
  return { alreadyUnsubscribed: false, subscriber };
}

/** Admin → Unsubscribe: suppression `reason: 'admin'`, `source: 'admin'`; already suppressed → 409. */
export async function adminUnsubscribe(siteId: string, id: string, actor: { userId: string }, note?: string): Promise<NewsletterSubscriberRow> {
  const row = await repo.findById(getDb(), siteId, id);
  if (!row) throw new ApiError('NOT_FOUND', 404, 'That subscriber isn’t here.');
  if (SUPPRESSED_STATUSES.includes(row.status)) {
    throw new ApiError('SUBSCRIBER_NOT_ELIGIBLE', 409, 'This address is already unsubscribed.');
  }
  return suppress(row, { reason: 'admin', source: 'admin', actorUserId: actor.userId, details: note ? { note } : {} });
}

/** A provider-side suppression (poll or webhook): known email → status + suppression + event; idempotent. */
export async function suppressByEmail(
  siteId: string,
  email: string,
  input: { reason: 'unsubscribed' | 'bounced' | 'complaint'; source: 'provider' | 'webhook'; details?: Record<string, unknown>; now?: Date },
): Promise<{ accepted: boolean; subscriber: NewsletterSubscriberRow | null }> {
  const row = await repo.findByEmail(getDb(), siteId, email);
  if (!row) return { accepted: false, subscriber: null };
  if (SUPPRESSED_STATUSES.includes(row.status)) return { accepted: true, subscriber: row };
  const subscriber = await suppress(row, input);
  return { accepted: true, subscriber };
}

async function runHook(fn: () => Promise<void>, trigger: 'confirm' | 'unsubscribe', subscriberId: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.warn('newsletter.sync', {
      msg: 'Sender hook failed; blog0 is already committed',
      trigger,
      subscriber_id: subscriberId,
      errors: 1,
      err_message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Admin resend (pending rows) — the legacy one-time rule lives in legacy.ts

export interface ResendResult {
  subscriber: NewsletterSubscriberRow;
  sentTo: string;
  transport: 'smtp' | 'stub';
}

/** New token + email for a `pending` row, under the 3-per-24 h cap; MAIL_FAILED leaves the row untouched. */
export async function resendConfirmation(siteId: string, row: NewsletterSubscriberRow, actor: { userId: string }, now = new Date()): Promise<ResendResult> {
  const site = await getCurrentSite();
  const sends = await repo.confirmationSendsSince(getDb(), row.id, new Date(now.getTime() - CONFIRMATION_CAP_WINDOW_MS));
  if (sends.n >= CONFIRMATION_SENDS_PER_DAY) {
    const retryAt = new Date((sends.oldest?.getTime() ?? now.getTime()) + CONFIRMATION_CAP_WINDOW_MS);
    throw new ApiError('CONFIRMATION_ALREADY_SENT', 409, `This address already got ${CONFIRMATION_SENDS_PER_DAY} confirmation emails in 24 hours.`, {
      retryAt: retryAt.toISOString(),
    });
  }
  const { token, hash } = newConfirmToken();
  let sent;
  try {
    sent = await sendConfirmationMail(row, token, site);
  } catch (err) {
    throw new ApiError('MAIL_FAILED', 502, err instanceof Error ? err.message : 'The mail server rejected the message.');
  }
  const subscriber = await getDb().transaction(async (tx) => {
    const updated = await repo.updateSubscriber(tx, row.id, {
      confirmTokenHash: hash,
      confirmTokenExpiresAt: new Date(now.getTime() + CONFIRM_TOKEN_TTL_MS),
      confirmationSentCount: row.confirmationSentCount + 1,
      updatedAt: now,
    });
    await repo.appendEvent(tx, {
      siteId,
      subscriberId: row.id,
      email: row.email,
      kind: 'confirmation_sent',
      source: 'admin',
      actorUserId: actor.userId,
      ip: null,
      userAgent: null,
      details: { outcome: sent.outcome, transport: sent.transport, resend: true },
      createdAt: now,
    });
    return updated;
  });
  return { subscriber, sentTo: row.email, transport: sent.transport };
}

// ---------------------------------------------------------------------------------------------
// DTOs

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

export function pendingExpired(row: NewsletterSubscriberRow, now: Date): boolean {
  return row.status === 'pending' && row.confirmTokenExpiresAt !== null && row.confirmTokenExpiresAt.getTime() < now.getTime();
}

async function canSendConfirmation(db: Executor, row: NewsletterSubscriberRow, now: Date): Promise<boolean> {
  if (row.status === 'legacy_unconfirmed') return row.legacyConfirmationSentAt === null;
  if (row.status !== 'pending') return false;
  const sends = await repo.confirmationSendsSince(db, row.id, new Date(now.getTime() - CONFIRMATION_CAP_WINDOW_MS));
  return sends.n < CONFIRMATION_SENDS_PER_DAY;
}

export async function subscriberDtoFrom(db: Executor, row: NewsletterSubscriberRow, now: Date): Promise<SubscriberDto> {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    consentedAt: iso(row.consentedAt),
    confirmedAt: iso(row.confirmedAt),
    unsubscribedAt: iso(row.unsubscribedAt),
    pendingExpired: pendingExpired(row, now),
    consentVersion: row.consentVersion,
    sourceUrl: row.signupSourceUrl,
    providerSyncedAt: iso(row.providerSyncedAt),
    canSendConfirmation: await canSendConfirmation(db, row, now),
  };
}

export async function subscriberDetailFrom(db: Executor, row: NewsletterSubscriberRow, now: Date): Promise<SubscriberDetailDto> {
  const base = await subscriberDtoFrom(db, row, now);
  const [events, suppressions, messages] = await Promise.all([repo.eventsOf(db, row.id), repo.suppressionsOf(db, row.siteId, row.email), repo.messagesOf(db, row.id)]);
  const actorIds = [...new Set(events.map((e) => e.actorUserId).filter((v): v is string => v !== null))];
  const actors = actorIds.length
    ? await db.select({ id: appUser.id, displayName: appUser.displayName }).from(appUser).where(inArray(appUser.id, actorIds))
    : [];
  const actorName = new Map(actors.map((a) => [a.id, a.displayName]));
  return {
    ...base,
    signupIp: row.signupIp,
    signupUserAgent: row.signupUserAgent,
    consentText: row.consentText,
    confirmedIp: row.confirmedIp,
    confirmedUserAgent: row.confirmedUserAgent,
    confirmTokenExpiresAt: iso(row.confirmTokenExpiresAt),
    confirmationSentCount: row.confirmationSentCount,
    legacyConfirmationSentAt: iso(row.legacyConfirmationSentAt),
    providerId: row.providerId,
    ipPrunedAt: iso(row.ipPrunedAt),
    events: events.map((e) => ({
      id: e.id,
      kind: e.kind,
      source: e.source,
      actor: e.actorUserId ? (actorName.get(e.actorUserId) ?? null) : null,
      ip: e.ip,
      userAgent: e.userAgent,
      details: e.details,
      createdAt: e.createdAt.toISOString(),
    })),
    suppressions: suppressions.map((s) => ({ id: s.id, reason: s.reason, source: s.source, details: s.details, createdAt: s.createdAt.toISOString() })),
    messages: messages
      .filter((m) => m.kind !== 'test_issue')
      .map((m) => ({ id: m.id, kind: m.kind as 'confirmation' | 'issue', subject: m.subject, transport: m.transport, status: m.status, createdAt: m.createdAt.toISOString() })),
  };
}

export async function getSubscriberDetail(siteId: string, id: string, now = new Date()): Promise<SubscriberDetailDto> {
  const db = getDb();
  const row = await repo.findById(db, siteId, id);
  if (!row) throw new ApiError('NOT_FOUND', 404, 'That subscriber isn’t here.');
  return subscriberDetailFrom(db, row, now);
}

export async function listSubscribers(siteId: string, filter: repo.ListFilter = {}, now = new Date()): Promise<SubscriberListResponse> {
  const db = getDb();
  const rows = await repo.listRows(db, siteId, filter);
  const subscribers: SubscriberDto[] = [];
  for (const row of rows) subscribers.push(await subscriberDtoFrom(db, row, now));
  const counts = await repo.countsOf(db, siteId);
  return { subscribers, total: subscribers.length, counts, now: now.toISOString() };
}

export async function subscriberCounts(siteId: string): Promise<SubscriberCounts> {
  return repo.countsOf(getDb(), siteId);
}

/** Every `confirmed` subscriber of the site (the only rows that ever receive an issue). */
export async function confirmedSubscribers(siteId: string): Promise<NewsletterSubscriberRow[]> {
  return repo.listRows(getDb(), siteId, { status: 'confirmed' });
}

export async function findSubscriberById(siteId: string, id: string): Promise<NewsletterSubscriberRow | null> {
  return repo.findById(getDb(), siteId, id);
}

export async function findSubscriberByEmail(siteId: string, email: string): Promise<NewsletterSubscriberRow | null> {
  return repo.findByEmail(getDb(), siteId, email);
}

/** Provider bookkeeping for slice S7.3's sync: records the provider id / sync time and the matching event. */
export async function markProviderSynced(
  row: NewsletterSubscriberRow,
  input: { providerId: string | null; kind: 'provider_synced' | 'provider_removed'; source: 'system' | 'admin' | 'provider'; details?: Record<string, unknown>; now?: Date },
): Promise<NewsletterSubscriberRow> {
  const now = input.now ?? new Date();
  return getDb().transaction(async (tx) => {
    const updated = await repo.updateSubscriber(tx, row.id, { providerId: input.providerId ?? row.providerId, providerSyncedAt: now, updatedAt: now });
    await repo.appendEvent(tx, {
      siteId: row.siteId,
      subscriberId: row.id,
      email: row.email,
      kind: input.kind,
      source: input.source,
      actorUserId: null,
      ip: null,
      userAgent: null,
      details: { providerId: input.providerId, ...(input.details ?? {}) },
      createdAt: now,
    });
    return updated;
  });
}
