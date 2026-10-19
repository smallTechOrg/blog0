import 'server-only';

import { and, count, eq } from 'drizzle-orm';

import { getDb } from '@/server/db/client';
import { newsletterIssue, newsletterMessage, newsletterSubscriber, site } from '@/server/db/schema';
import { log, maskEmail } from '@/server/log';

import { fillPlaceholders } from '../issues/render';
import { consentLine, unsubscribeUrl } from '../links';

import {
  SenderError,
  type NewsletterSender,
  type ProviderDeleteOutcome,
  type ProviderDeleteTarget,
  type SenderHealth,
  type SenderIssue,
  type SenderStats,
  type SenderSubscriber,
  type SenderSuppression,
} from './types';

// Recording stub sender (spec/architecture.md §13.3): the default sender; what designer mode,
// integration tests and the E2E suite use. In-memory half (wave 1): subscribers in a Map
// (`providerId = 'stub-' + subscriberId`), campaigns keyed `'stub-' + issueId`, `sendIssue`
// records the enabled subscribers as recipients. With `recordToDb` (what getNewsletterSender()
// builds — slice S7.3) `sendIssue` instead writes one `newsletter_message` row per subscriber who
// is `confirmed` in blog0 at that moment (`kind 'issue'`, `transport 'stub_sender'`, `status
// 'stubbed'`, placeholders filled with that subscriber's own unsubscribe link + consent line) and
// `fetchStats` counts those rows. Both modes are idempotent per campaign.

export interface StubSenderOptions {
  /** Deliver into `newsletter_message` (blog0's confirmed subscribers) instead of the in-memory list. */
  recordToDb?: boolean;
}

const CAMPAIGN_PREFIX = 'stub-';

export interface StubCampaign {
  issue: SenderIssue;
  status: 'draft' | 'sent';
  recipients: string[]; // emails, frozen at send
  sentAt: Date | null;
}

export class StubNewsletterSender implements NewsletterSender {
  readonly kind = 'stub' as const;
  readonly subscribers = new Map<string, SenderSubscriber>(); // by providerId
  readonly campaigns = new Map<string, StubCampaign>(); // by campaignId
  readonly #recordToDb: boolean;

  constructor(options: StubSenderOptions = {}) {
    this.#recordToDb = options.recordToDb ?? false;
  }

  reset(): void {
    this.subscribers.clear();
    this.campaigns.clear();
  }

  async healthcheck(): Promise<SenderHealth> {
    return { ok: true, message: 'stub sender (nothing is delivered)', listName: 'stub' };
  }

  async syncSubscriber(s: SenderSubscriber): Promise<{ providerId: string; changed: boolean }> {
    const providerId = `stub-${s.subscriberId}`;
    const before = this.subscribers.get(providerId);
    const changed = before === undefined || JSON.stringify(before) !== JSON.stringify(s);
    this.subscribers.set(providerId, structuredClone(s));
    return { providerId, changed };
  }

  async removeSubscriber(email: string): Promise<{ changed: boolean }> {
    const key = email.toLowerCase();
    for (const [providerId, s] of this.subscribers) {
      if (s.email.toLowerCase() !== key) continue;
      if (s.status === 'blocklisted') return { changed: false };
      this.subscribers.set(providerId, { ...s, status: 'blocklisted' });
      return { changed: true };
    }
    return { changed: false };
  }

  async findSubscriberId(email: string): Promise<string | null> {
    const key = email.toLowerCase();
    for (const [providerId, s] of this.subscribers) if (s.email.toLowerCase() === key) return providerId;
    return null;
  }

  async deleteSubscriber(target: ProviderDeleteTarget): Promise<{ outcome: ProviderDeleteOutcome; providerId: string | null }> {
    let providerId: string | null = null;
    if (target.providerId !== null && this.subscribers.has(target.providerId)) {
      const s = this.subscribers.get(target.providerId)!;
      if (target.email === null || s.email.toLowerCase() === target.email.toLowerCase()) providerId = target.providerId;
    }
    if (providerId === null && target.email !== null) providerId = await this.findSubscriberId(target.email);
    if (providerId === null) return { outcome: 'not_found', providerId: target.providerId };
    const owner = this.subscribers.get(providerId)!.attribs.blog0_subscriber_id;
    if (target.keep !== undefined && (await target.keep(owner))) return { outcome: 'kept', providerId };
    this.subscribers.delete(providerId);
    return { outcome: 'deleted', providerId };
  }

  async createIssue(i: SenderIssue): Promise<{ campaignId: string }> {
    const campaignId = `stub-${i.issueId}`;
    const existing = this.campaigns.get(campaignId);
    if (existing === undefined) this.campaigns.set(campaignId, { issue: structuredClone(i), status: 'draft', recipients: [], sentAt: null });
    return { campaignId };
  }

  #campaign(campaignId: string): StubCampaign {
    const c = this.campaigns.get(campaignId);
    if (c === undefined) throw new SenderError('INVALID', `stub sender: unknown campaign ${campaignId}`);
    return c;
  }

  async sendIssue(campaignId: string): Promise<void> {
    if (this.#recordToDb) return this.#deliverToDb(campaignId);
    const c = this.#campaign(campaignId);
    if (c.status === 'sent') return;
    c.recipients = [...this.subscribers.values()].filter((s) => s.status === 'enabled').map((s) => s.email);
    c.status = 'sent';
    c.sentAt = new Date();
    log.info('newsletter.issue', {
      sender: 'stub',
      action: 'send',
      issueId: c.issue.issueId,
      campaignId,
      recipients: c.recipients.length,
      sample: c.recipients.slice(0, 3).map(maskEmail),
      outcome: 'stubbed',
    });
  }

  async fetchStats(campaignId: string): Promise<SenderStats> {
    if (this.#recordToDb) {
      const issue = await this.#issueRow(campaignId);
      const [row] = await getDb()
        .select({ n: count() })
        .from(newsletterMessage)
        .where(and(eq(newsletterMessage.issueId, issue.id), eq(newsletterMessage.kind, 'issue')));
      // Deliveries deleted by an erasure (0005) still count: the issue keeps their number.
      const n = Number(row?.n ?? 0) + issue.erasedMessageCount;
      return { recipients: n, sent: n, delivered: null, opens: null, clicks: null, bounces: null, unsubscribes: null };
    }
    const c = this.#campaign(campaignId);
    const n = c.status === 'sent' ? c.recipients.length : 0;
    return { recipients: n, sent: n, delivered: null, opens: null, clicks: null, bounces: null, unsubscribes: null };
  }

  async #issueRow(campaignId: string) {
    const issueId = campaignId.startsWith(CAMPAIGN_PREFIX) ? campaignId.slice(CAMPAIGN_PREFIX.length) : '';
    if (!/^[0-9a-f-]{36}$/i.test(issueId)) throw new SenderError('INVALID', `stub sender: unknown campaign ${campaignId}`);
    const [issue] = await getDb().select().from(newsletterIssue).where(eq(newsletterIssue.id, issueId)).limit(1);
    if (!issue) throw new SenderError('INVALID', `stub sender: unknown campaign ${campaignId}`);
    return issue;
  }

  /** One `newsletter_message` per currently confirmed subscriber; a campaign that already has rows is left alone. */
  async #deliverToDb(campaignId: string): Promise<void> {
    const issue = await this.#issueRow(campaignId);
    const memory = this.campaigns.get(campaignId);
    const html = memory?.issue.html ?? issue.renderedHtml;
    const text = memory?.issue.text ?? issue.renderedText;
    const subject = memory?.issue.subject ?? issue.title;
    if (html === null || text === null) throw new SenderError('INVALID', `stub sender: campaign ${campaignId} has no frozen body`);

    const recipients = await getDb().transaction(async (tx) => {
      // Serialise concurrent starts of the same campaign on the issue row.
      const [locked] = await tx.select({ erased: newsletterIssue.erasedMessageCount }).from(newsletterIssue).where(eq(newsletterIssue.id, issue.id)).for('update');
      const [already] = await tx
        .select({ n: count() })
        .from(newsletterMessage)
        .where(and(eq(newsletterMessage.issueId, issue.id), eq(newsletterMessage.kind, 'issue')));
      // Delivered already (rows, or rows an erasure has since deleted) → never a second delivery.
      if (Number(already?.n ?? 0) + (locked?.erased ?? 0) > 0) return null;
      const [siteRow] = await tx.select().from(site).where(eq(site.id, issue.siteId)).limit(1);
      const confirmed = await tx
        .select()
        .from(newsletterSubscriber)
        .where(and(eq(newsletterSubscriber.siteId, issue.siteId), eq(newsletterSubscriber.status, 'confirmed')))
        .orderBy(newsletterSubscriber.createdAt);
      if (confirmed.length > 0) {
        await tx.insert(newsletterMessage).values(
          confirmed.map((sub) => {
            const values = { unsubscribeUrl: unsubscribeUrl(sub.id), consentLine: consentLine(sub, siteRow) };
            return {
              siteId: issue.siteId,
              kind: 'issue' as const,
              subscriberId: sub.id,
              issueId: issue.id,
              toEmail: sub.email,
              subject,
              html: fillPlaceholders(html, values, 'html'),
              text: fillPlaceholders(text, values, 'text'),
              transport: 'stub_sender',
              status: 'stubbed' as const,
            };
          }),
        );
      }
      return confirmed.map((sub) => sub.email);
    });
    if (recipients === null) return;

    if (memory) {
      memory.status = 'sent';
      memory.recipients = recipients;
      memory.sentAt = new Date();
    }
    log.info('newsletter.issue', {
      sender: 'stub',
      action: 'send',
      issueId: issue.id,
      campaignId,
      recipients: recipients.length,
      sample: recipients.slice(0, 3).map(maskEmail),
      outcome: 'stubbed',
    });
  }

  async fetchSuppressions(_since: Date): Promise<SenderSuppression[]> {
    return [];
  }
}
