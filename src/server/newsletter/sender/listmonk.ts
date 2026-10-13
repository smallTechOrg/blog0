import 'server-only';

import type { ListmonkConfig } from '@/server/config';
import { log, maskEmail } from '@/server/log';

import {
  CONSENT_PLACEHOLDER,
  SenderError,
  UNSUBSCRIBE_PLACEHOLDER,
  type NewsletterSender,
  type SenderHealth,
  type SenderIssue,
  type SenderStats,
  type SenderSubscriber,
  type SenderSuppression,
  type SenderSyncResult,
} from './types';
import { providerOptOutWins } from './opt-out';

// Listmonk adapter (spec/architecture.md §13.3; Listmonk v5.1.0, API-user token auth).
// Plain `fetch`, 15 s timeout per call, one retry on network error / 5xx after 500 ms; every call
// logs `newsletter.provider` (method, path, status, ms — never the token, never a full email).
// Verified against v5.1.0: duplicate POST /api/subscribers → 409; an unknown campaign/list → 400;
// starting a running campaign → 400 ("Only paused campaigns and drafts can be started"), hence
// the status read in `sendIssue`; re-enabling a blocklisted subscriber leaves its list
// subscription `unsubscribed`, hence the membership re-add in `syncSubscriber`. An unsubscribe on
// Listmonk's side (List-Unsubscribe header / its unsubscribe page) only sets the list subscription
// `unsubscribed` (subscriber stays `enabled`, `subscription_updated_at` = the opt-out time); that is
// an opt-out too: `fetchSuppressions` reports it and `syncSubscriber` never re-adds over it unless
// blog0's consent / confirmation is newer (sender/opt-out.ts).

export const BLOG0_TEMPLATE_NAME = 'blog0-issue';
export const BLOG0_TEMPLATE_BODY = '{{ template "content" . }}';
export const UNSUBSCRIBE_EXPRESSION = '{{ .Subscriber.Attribs.blog0_unsubscribe_url }}';
export const CONSENT_EXPRESSION = '{{ .Subscriber.Attribs.blog0_consent_line }}';
/** Attribute blog0 stamps on every blocklist IT makes (mirror of a blog0 suppression). Such a
 *  blocklist is blog0's own state, not a provider opt-out: it never overrides a later blog0
 *  confirmation and is never pulled back by `fetchSuppressions` — no cross-clock comparison needed.
 *  A re-enable writes the blog0 attribs, which drops it. */
export const BLOG0_BLOCKLIST_MARKER = 'blog0_blocklisted_at';

const TIMEOUT_MS = 15_000;
const RETRY_BACKOFF_MS = 500;

/**
 * Listmonk runs subject, body and altbody through Go's text/template: a literal `{{` / `}}` in blog0's
 * rendered text (a post title such as "Templating with {{ x }}") would be parsed as an action. One
 * regex pass turns each delimiter into an action that prints it (`{{ "{{" }}`, `{{ "}}" }}`); the
 * inserted text is never re-scanned.
 */
export function escapeGoTemplate(text: string): string {
  return text.replace(/\{\{|\}\}/g, (m) => (m === '{{' ? '{{ "{{" }}' : '{{ "}}" }}'));
}

/** blog0 placeholders (§13.4) → Listmonk template expressions over the subscriber attributes, after
 *  escaping every literal template delimiter already in the body. */
export function toListmonkExpressions(body: string): string {
  return escapeGoTemplate(body).split(UNSUBSCRIBE_PLACEHOLDER).join(UNSUBSCRIBE_EXPRESSION).split(CONSENT_PLACEHOLDER).join(CONSENT_EXPRESSION);
}

/** Address-shaped runs, plain or percent-encoded (`a%40b.c`). */
const EMAIL_LIKE = /[^\s'"<>()=&?@]+(?:@|%40)[^\s'"<>()&?@]+/gi;

/** The request path without its query string — the query can carry a subscriber's address. */
export function safePath(path: string): string {
  return path.replace(/\?.*$/, '');
}

/** Drops anything address-shaped from provider text (an error message may echo the query). */
export function redactEmails(text: string): string {
  return text.replace(EMAIL_LIKE, '[email]');
}

/** Single-quoted SQL literal for Listmonk's `query=` filter (it is passed to Postgres as-is). */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface ListmonkListRef {
  id: number;
  name?: string;
  subscription_status?: string;
  subscription_updated_at?: string;
}

interface ListmonkSubscriber {
  id: number;
  email: string;
  name: string;
  status: 'enabled' | 'disabled' | 'blocklisted';
  attribs: Record<string, unknown>;
  lists: ListmonkListRef[];
  updated_at: string;
}

interface ListmonkCampaign {
  id: number;
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'cancelled' | 'finished';
  to_send: number;
  sent: number;
  views: number;
  clicks: number;
  bounces: number;
  body: string;
}

interface ListmonkBounce {
  id: number;
  email: string;
  type: 'hard' | 'soft' | 'complaint';
  source: string;
  created_at: string;
  campaign?: { id?: number; name?: string } | null;
  meta?: unknown;
}

interface ListmonkTemplate {
  id: number;
  name: string;
  type: string;
}

interface Paged<T> {
  results: T[];
  total: number;
}

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

interface CallOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: Json;
  /** Statuses returned to the caller as `{ status, data: null }` instead of throwing. */
  tolerate?: number[];
}

interface CallResult<T> {
  status: number;
  data: T;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function parseDate(value: string | undefined): Date | null {
  if (value === undefined || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A blocklist blog0 made itself (it carries BLOG0_BLOCKLIST_MARKER). */
export function isBlog0Blocklist(row: { attribs?: Record<string, unknown> | null }): boolean {
  const v = row.attribs?.[BLOG0_BLOCKLIST_MARKER];
  return typeof v === 'string' && v !== '';
}

/**
 * The opt-out a Listmonk subscriber carries for `listId`, or null (a blocklist blog0 made itself is
 * not a provider opt-out — blog0 already holds that suppression): `blocklisted` (at = the later of
 * the subscriber's `updated_at` and the list subscription's `subscription_updated_at`), else a
 * list-level `unsubscribed` subscription (at = `subscription_updated_at`).
 */
export function listmonkOptOut(
  row: Pick<ListmonkSubscriber, 'status' | 'updated_at' | 'lists'> & { attribs?: Record<string, unknown> | null },
  listId: number,
): { kind: 'blocklisted' | 'list_unsubscribed'; at: Date } | null {
  if (row.status === 'blocklisted' && isBlog0Blocklist(row)) return null;
  const membership = row.lists.find((l) => l.id === listId);
  const subscriptionAt = membership?.subscription_status === 'unsubscribed' ? parseDate(membership.subscription_updated_at) : null;
  if (row.status === 'blocklisted') {
    const updatedAt = parseDate(row.updated_at);
    const times = [updatedAt, subscriptionAt].filter((d): d is Date => d !== null).map((d) => d.getTime());
    // No usable timestamp → an invalid Date, which providerOptOutWins treats as "the opt-out wins" (fail safe).
    return { kind: 'blocklisted', at: times.length > 0 ? new Date(Math.max(...times)) : new Date(Number.NaN) };
  }
  if (membership?.subscription_status === 'unsubscribed') {
    return { kind: 'list_unsubscribed', at: subscriptionAt ?? new Date(Number.NaN) };
  }
  return null;
}

export class ListmonkSender implements NewsletterSender {
  readonly kind = 'listmonk' as const;
  readonly #baseUrl: string;
  readonly #auth: string;
  readonly #listId: number;
  #templateId: number | null = null;

  constructor(config: ListmonkConfig) {
    this.#baseUrl = config.url.replace(/\/+$/, '');
    this.#auth = `token ${config.apiUser}:${config.apiToken.reveal()}`;
    this.#listId = config.listId;
  }

  get listId(): number {
    return this.#listId;
  }

  // --- HTTP --------------------------------------------------------------------------------------

  async #call<T>(options: CallOptions): Promise<CallResult<T>> {
    const { method, path, body, tolerate = [] } = options;
    const url = `${this.#baseUrl}${path}`;
    // Every message / log line below names the path WITHOUT its query (B1: `?query=subscribers.email=…`
    // carries an address; SenderError messages reach logs, `last_error` and stderr).
    const shown = safePath(path);
    const started = Date.now();
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            authorization: this.#auth,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: 'no-store',
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        if (attempt === 1) {
          this.#logCall(method, path, null, started, attempt, 'retry', error);
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
          continue;
        }
        this.#logCall(method, path, null, started, attempt, 'failed', error);
        throw new SenderError(
          timedOut ? 'TIMEOUT' : 'UNAVAILABLE',
          timedOut
            ? `Listmonk did not answer ${method} ${shown} within ${TIMEOUT_MS / 1000} s`
            : `Listmonk unreachable at ${this.#baseUrl}: ${redactEmails(error instanceof Error ? error.message : String(error))}`,
        );
      }

      if (response.status >= 500 && attempt === 1) {
        this.#logCall(method, path, response.status, started, attempt, 'retry');
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        continue;
      }

      const text = await response.text();
      let parsed: unknown = null;
      if (text !== '') {
        try {
          parsed = JSON.parse(text);
        } catch {
          this.#logCall(method, path, response.status, started, attempt, 'invalid');
          throw new SenderError('INVALID', `Listmonk answered ${method} ${shown} with non-JSON (${response.status})`, response.status);
        }
      }

      if (response.ok) {
        this.#logCall(method, path, response.status, started, attempt, 'ok');
        return { status: response.status, data: (isJsonObject(parsed) ? parsed.data : parsed) as T };
      }
      if (tolerate.includes(response.status)) {
        this.#logCall(method, path, response.status, started, attempt, 'ok');
        return { status: response.status, data: null as T };
      }
      const message = isJsonObject(parsed) && typeof parsed.message === 'string' ? parsed.message : response.statusText;
      this.#logCall(method, path, response.status, started, attempt, 'failed');
      throw new SenderError('HTTP', `Listmonk ${method} ${shown} → ${response.status}: ${redactEmails(message)}`, response.status);
    }
  }

  #logCall(method: string, path: string, status: number | null, started: number, attempt: number, outcome: string, error?: unknown): void {
    log.info('newsletter.provider', {
      provider: 'listmonk',
      method,
      path: safePath(path),
      status,
      attempt,
      outcome,
      ms: Date.now() - started,
      error: error instanceof Error ? redactEmails(error.message) : undefined,
    });
  }

  // --- subscribers -------------------------------------------------------------------------------

  async #findByEmail(email: string): Promise<ListmonkSubscriber | null> {
    const query = encodeURIComponent(`subscribers.email=${sqlLiteral(email.toLowerCase())}`);
    const { data } = await this.#call<Paged<ListmonkSubscriber>>({ method: 'GET', path: `/api/subscribers?query=${query}&per_page=1` });
    const row = data?.results?.[0];
    if (!row) return null;
    return row.email.toLowerCase() === email.toLowerCase() ? row : null;
  }

  #membershipConfirmed(row: ListmonkSubscriber): boolean {
    return row.lists.some((l) => l.id === this.#listId && l.subscription_status === 'confirmed');
  }

  /** Blocklist (one PUT: status + the blog0 marker; existing memberships are passed through untouched —
   *  Listmonk itself marks them `unsubscribed` on a blocklist). */
  async #blocklist(existing: ListmonkSubscriber): Promise<void> {
    await this.#call({
      method: 'PUT',
      path: `/api/subscribers/${existing.id}`,
      body: {
        email: existing.email,
        name: existing.name,
        status: 'blocklisted',
        lists: existing.lists.map((l) => l.id),
        attribs: { ...existing.attribs, [BLOG0_BLOCKLIST_MARKER]: new Date().toISOString() },
      },
    });
  }

  async #ensureMembership(id: number): Promise<void> {
    await this.#call({
      method: 'PUT',
      path: '/api/subscribers/lists',
      body: { ids: [id], action: 'add', target_list_ids: [this.#listId], status: 'confirmed' },
    });
  }

  async syncSubscriber(s: SenderSubscriber): Promise<SenderSyncResult> {
    const existing = await this.#findByEmail(s.email);

    if (s.status === 'blocklisted') {
      // A suppressed blog0 row: blocklist only — never create or touch a list membership.
      if (existing === null) {
        const { data } = await this.#call<ListmonkSubscriber>({
          method: 'POST',
          path: '/api/subscribers',
          body: { email: s.email, name: s.name ?? '', status: 'blocklisted', lists: [], attribs: { ...s.attribs, [BLOG0_BLOCKLIST_MARKER]: new Date().toISOString() } },
        });
        return { providerId: String(data.id), changed: true };
      }
      if (existing.status === 'blocklisted') return { providerId: String(existing.id), changed: false };
      await this.#blocklist(existing);
      return { providerId: String(existing.id), changed: true };
    }

    const body = {
      email: s.email,
      name: s.name ?? '',
      status: 'enabled',
      lists: [this.#listId],
      attribs: s.attribs,
      preconfirm_subscriptions: true,
    };

    if (existing === null) {
      const { data } = await this.#call<ListmonkSubscriber>({ method: 'POST', path: '/api/subscribers', body });
      return { providerId: String(data.id), changed: true };
    }

    // An opt-out at Listmonk newer than blog0's latest consent / confirmation wins: write nothing
    // (no re-enable, no membership re-add) and hand it back for blog0 to record.
    const optOut = listmonkOptOut(existing, this.#listId);
    if (optOut !== null && providerOptOutWins(optOut.at, { consentedAt: s.attribs.consented_at, confirmedAt: s.attribs.confirmed_at })) {
      log.info('newsletter.provider', { provider: 'listmonk', action: 'sync', email: maskEmail(s.email), providerId: String(existing.id), outcome: 'provider_opt_out', optOut: optOut.kind });
      return {
        providerId: String(existing.id),
        changed: false,
        optOut: {
          email: existing.email,
          reason: 'unsubscribed',
          at: optOut.at,
          details: { providerId: String(existing.id), providerStatus: existing.status, optOut: optOut.kind, listId: this.#listId },
        },
      };
    }

    // No blog0 name: Listmonk derived one from the address on create — keep it, never compare it
    // (comparing against '' made every re-sync report `changed`; S7.3 regression).
    if (s.name === null) body.name = existing.name;
    const same =
      existing.status === 'enabled' &&
      existing.name === body.name &&
      stableJson(existing.attribs) === stableJson(s.attribs) &&
      this.#membershipConfirmed(existing);
    if (same) return { providerId: String(existing.id), changed: false };

    const { data } = await this.#call<ListmonkSubscriber>({ method: 'PUT', path: `/api/subscribers/${existing.id}`, body });
    if (!this.#membershipConfirmed(data)) await this.#ensureMembership(existing.id);
    log.info('newsletter.provider', { provider: 'listmonk', action: 'sync', email: maskEmail(s.email), providerId: String(existing.id), outcome: 'updated' });
    return { providerId: String(existing.id), changed: true };
  }

  async removeSubscriber(email: string): Promise<{ changed: boolean }> {
    const existing = await this.#findByEmail(email);
    if (existing === null || existing.status === 'blocklisted') return { changed: false };
    await this.#blocklist(existing);
    log.info('newsletter.provider', { provider: 'listmonk', action: 'blocklist', email: maskEmail(email), providerId: String(existing.id), outcome: 'blocklisted' });
    return { changed: true };
  }

  // --- campaigns ---------------------------------------------------------------------------------

  async #ensureTemplate(): Promise<number> {
    if (this.#templateId !== null) return this.#templateId;
    const { data } = await this.#call<ListmonkTemplate[]>({ method: 'GET', path: '/api/templates' });
    const found = (data ?? []).find((t) => t.name === BLOG0_TEMPLATE_NAME && t.type === 'campaign');
    if (found) {
      this.#templateId = found.id;
      return found.id;
    }
    const created = await this.#call<ListmonkTemplate>({
      method: 'POST',
      path: '/api/templates',
      body: { name: BLOG0_TEMPLATE_NAME, type: 'campaign', body: BLOG0_TEMPLATE_BODY },
    });
    this.#templateId = created.data.id;
    return created.data.id;
  }

  async createIssue(i: SenderIssue): Promise<{ campaignId: string }> {
    const templateId = await this.#ensureTemplate();
    const { data } = await this.#call<ListmonkCampaign>({
      method: 'POST',
      path: '/api/campaigns',
      body: {
        name: `blog0 #${i.number} — ${i.subject}`,
        subject: escapeGoTemplate(i.subject),
        lists: [this.#listId],
        type: 'regular',
        content_type: 'html',
        body: toListmonkExpressions(i.html),
        altbody: toListmonkExpressions(i.text),
        template_id: templateId,
        tags: ['blog0', `issue:${i.issueId}`],
      },
    });
    return { campaignId: String(data.id) };
  }

  async #campaign(campaignId: string): Promise<ListmonkCampaign> {
    if (!/^\d+$/.test(campaignId)) throw new SenderError('INVALID', `not a Listmonk campaign id: ${campaignId}`);
    const { data } = await this.#call<ListmonkCampaign>({ method: 'GET', path: `/api/campaigns/${campaignId}` });
    return data;
  }

  async sendIssue(campaignId: string): Promise<void> {
    const campaign = await this.#campaign(campaignId);
    if (campaign.status === 'running' || campaign.status === 'finished') return;
    if (campaign.status === 'cancelled') throw new SenderError('INVALID', `Listmonk campaign ${campaignId} is cancelled`);
    await this.#call({ method: 'PUT', path: `/api/campaigns/${campaignId}/status`, body: { status: 'running' } });
  }

  async fetchStats(campaignId: string): Promise<SenderStats> {
    const c = await this.#campaign(campaignId);
    return { recipients: c.to_send, sent: c.sent, delivered: null, opens: c.views, clicks: c.clicks, bounces: c.bounces, unsubscribes: null };
  }

  // --- provider → blog0 --------------------------------------------------------------------------

  async fetchSuppressions(since: Date): Promise<SenderSuppression[]> {
    const out: SenderSuppression[] = [];
    const query = encodeURIComponent(`subscribers.status='blocklisted' AND subscribers.updated_at > ${sqlLiteral(since.toISOString())}`);
    const blocklisted = await this.#call<Paged<ListmonkSubscriber>>({ method: 'GET', path: `/api/subscribers?query=${query}&per_page=all` });
    for (const row of blocklisted.data?.results ?? []) {
      if (isBlog0Blocklist(row)) continue; // blog0's own suppression mirrored — not a provider event
      out.push({ email: row.email, reason: 'unsubscribed', at: new Date(row.updated_at), details: { providerId: String(row.id), providerStatus: row.status, optOut: 'blocklisted' } });
    }
    // List-level unsubscribes (List-Unsubscribe header / Listmonk's unsubscribe page): the subscriber
    // stays `enabled`, only its subscription to the blog0 list turns `unsubscribed` (verified v5.1.0:
    // GET /api/subscribers?list_id=…&subscription_status=unsubscribed; the subscriber's own
    // `updated_at` does not move, `subscription_updated_at` does). Blocklisted rows are reported above.
    const unsubscribed = await this.#call<Paged<ListmonkSubscriber>>({
      method: 'GET',
      path: `/api/subscribers?list_id=${this.#listId}&subscription_status=unsubscribed&per_page=all`,
    });
    for (const row of unsubscribed.data?.results ?? []) {
      if (row.status === 'blocklisted') continue;
      const optOut = listmonkOptOut(row, this.#listId);
      if (optOut === null || optOut.kind !== 'list_unsubscribed') continue;
      // An unparseable timestamp is still reported (fail safe), dated `since` + 1 ms.
      const at = Number.isNaN(optOut.at.getTime()) ? new Date(since.getTime() + 1) : optOut.at;
      if (!(at > since)) continue;
      out.push({
        email: row.email,
        reason: 'unsubscribed',
        at,
        details: { providerId: String(row.id), providerStatus: row.status, optOut: 'list_unsubscribed', listId: this.#listId },
      });
    }
    const bounces = await this.#call<Paged<ListmonkBounce>>({ method: 'GET', path: '/api/bounces?per_page=all' });
    for (const b of bounces.data?.results ?? []) {
      const at = new Date(b.created_at);
      if (!(at > since)) continue;
      if (b.type === 'soft') continue;
      out.push({
        email: b.email,
        reason: b.type === 'complaint' ? 'complaint' : 'bounced',
        at,
        details: { providerRef: String(b.id), bounceType: b.type, source: b.source, campaign: b.campaign?.name ?? null },
      });
    }
    return out;
  }

  // --- health ------------------------------------------------------------------------------------

  async healthcheck(): Promise<SenderHealth> {
    try {
      await this.#call({ method: 'GET', path: '/api/health' });
      const { status, data } = await this.#call<{ id: number; name: string } | null>({
        method: 'GET',
        path: `/api/lists/${this.#listId}`,
        tolerate: [400, 404],
      });
      if (data === null || status !== 200) return { ok: false, message: `list ${this.#listId} not found` };
      return { ok: true, message: `Listmonk ok · list ${data.name}`, listName: data.name };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
}
