import 'server-only';

import { log, maskEmail } from '@/server/log';

import {
  SenderError,
  type NewsletterSender,
  type SenderHealth,
  type SenderIssue,
  type SenderStats,
  type SenderSubscriber,
  type SenderSuppression,
} from './types';

// Recording stub sender (spec/architecture.md §13.3): the default sender; what designer mode,
// integration tests and the E2E suite use. In-memory half (wave 1): subscribers in a Map
// (`providerId = 'stub-' + subscriberId`), campaigns keyed `'stub-' + issueId`, `sendIssue`
// records the enabled subscribers as recipients. Wave 2 (S7.3) adds the `newsletter_message`
// rows per confirmed subscriber; `fetchStats` then counts those rows.

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
    const c = this.#campaign(campaignId);
    const n = c.status === 'sent' ? c.recipients.length : 0;
    return { recipients: n, sent: n, delivered: null, opens: null, clicks: null, bounces: null, unsubscribes: null };
  }

  async fetchSuppressions(_since: Date): Promise<SenderSuppression[]> {
    return [];
  }
}
