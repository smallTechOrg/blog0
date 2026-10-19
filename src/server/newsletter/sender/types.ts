// Sender adapter contract (spec/architecture.md §13.3): blog0 owns the list and the issues; the
// provider (Listmonk in production, the recording stub elsewhere) only delivers. blog0 → provider
// is a one-way mirror; provider → blog0 is suppressions only (`fetchSuppressions`, the webhook).

/** Placeholders the issue renderer (§13.4, S7.3) leaves in `html`/`text`; the stub fills them per
 *  recipient, the Listmonk adapter rewrites them to template expressions over the attribs. */
export const UNSUBSCRIBE_PLACEHOLDER = '%%BLOG0_UNSUBSCRIBE_URL%%';
export const CONSENT_PLACEHOLDER = '%%BLOG0_CONSENT_LINE%%';

export interface SenderSubscriber {
  subscriberId: string;
  email: string;
  name: string | null;
  status: 'enabled' | 'blocklisted';
  /** Consent metadata mirrored as provider attributes; the two `blog0_*_url/line` values feed the
   *  template expressions of §13.4 so every unsubscribe lands in blog0 first. */
  attribs: {
    blog0_subscriber_id: string;
    blog0_unsubscribe_url: string;
    blog0_consent_line: string;
    consent_version: string | null;
    consented_at: string | null;
    confirmed_at: string | null;
    signup_source_url: string | null;
  };
}

/** `html`/`text` still contain the blog0 placeholders of §13.4; each adapter fills or translates them. */
export interface SenderIssue {
  issueId: string;
  number: number;
  subject: string;
  html: string;
  text: string;
}

/** Fields a provider does not report are `null` (newsletter-issues.md). */
export interface SenderStats {
  recipients: number;
  sent: number;
  delivered: number | null;
  opens: number | null;
  clicks: number | null;
  bounces: number | null;
  unsubscribes: number | null;
}

export interface SenderSuppression {
  email: string;
  reason: 'unsubscribed' | 'bounced' | 'complaint';
  at: Date;
  details: Record<string, unknown>;
}

export interface SenderSyncResult {
  providerId: string;
  changed: boolean;
  /** Set only when a provider-side opt-out won: the caller records it in blog0 (`suppressByEmail`, source `provider`). */
  optOut?: SenderSuppression;
}

export interface SenderHealth {
  ok: boolean;
  message: string;
  listName?: string;
}

/** What a provider-side delete did: `kept` = the record now belongs to a live blog0 subscriber (a retry after a re-signup). */
export type ProviderDeleteOutcome = 'deleted' | 'not_found' | 'kept';

export interface ProviderDeleteTarget {
  /** The provider's own subscriber id when known (blog0's `provider_id`, or the erasure log's `provider_ref` on a retry). */
  providerId: string | null;
  /** The address — known only during the erase request itself (blog0 has deleted it afterwards); null on a retry. */
  email: string | null;
  /** Retry guard: called with the record's `blog0_subscriber_id` attribute; true ⇒ keep the record (it is someone live). */
  keep?: (blog0SubscriberId: string) => Promise<boolean>;
}

export interface NewsletterSender {
  readonly kind: 'listmonk' | 'stub';
  healthcheck(): Promise<SenderHealth>;
  /** Upsert, idempotent: `changed` is false when nothing differed at the provider. For an `enabled`
   *  input whose provider copy carries an opt-out (blocklist / list-level unsubscribe) newer than the
   *  attribs' consent / confirmation, nothing is written and `optOut` reports it (sender/opt-out.ts). */
  syncSubscriber(s: SenderSubscriber): Promise<SenderSyncResult>;
  /** Blocklist — never delete; an address unknown to the provider → `changed: false`. */
  removeSubscriber(email: string): Promise<{ changed: boolean }>;
  /** The provider's id for an address, or null when it holds none (read-only; used before an erasure). */
  findSubscriberId(email: string): Promise<string | null>;
  /** Erasure (0005): DELETE the provider's record — by id when known, else by address. Unknown → `not_found` (done). */
  deleteSubscriber(target: ProviderDeleteTarget): Promise<{ outcome: ProviderDeleteOutcome; providerId: string | null }>;
  createIssue(i: SenderIssue): Promise<{ campaignId: string }>;
  /** Start; idempotent for a campaign that is already running/finished. */
  sendIssue(campaignId: string): Promise<void>;
  fetchStats(campaignId: string): Promise<SenderStats>;
  fetchSuppressions(since: Date): Promise<SenderSuppression[]>;
}

export type SenderErrorCode = 'UNAVAILABLE' | 'HTTP' | 'TIMEOUT' | 'INVALID';

export class SenderError extends Error {
  readonly code: SenderErrorCode;
  readonly httpStatus: number | undefined;

  constructor(code: SenderErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = 'SenderError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
