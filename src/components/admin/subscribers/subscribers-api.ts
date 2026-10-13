// Admin → Subscribers helpers (pure, isomorphic): admin API paths for the list / exports, the
// status pill, the empty lines, the per-event labels of the audit timeline and the proof-of-consent
// lines (spec/ui.md §4 "Subscribers", "Subscriber"; spec/api.md GET /api/admin/subscribers).

import type { SubscriberDetailDto, SubscriberDto, SubscriberEventDto, SubscriberStatus } from '@/lib/api/dto';
import { fmtDate } from '@/lib/format-date';

export type StatusFilterValue = 'all' | SubscriberStatus;

/** Filter pills in display order (spec/ui.md §4: All · Confirmed · Pending · Legacy · Unsubscribed · Bounced). */
export const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilterValue; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'pending', label: 'Pending' },
  { value: 'legacy_unconfirmed', label: 'Legacy' },
  { value: 'unsubscribed', label: 'Unsubscribed' },
  { value: 'bounced', label: 'Bounced' },
];

export const STATUS_LABELS: Record<SubscriberStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  unsubscribed: 'Unsubscribed',
  bounced: 'Bounced',
  legacy_unconfirmed: 'Legacy',
};

const LIST_API = '/api/admin/subscribers';
export const LIST_PAGE = '/admin/subscribers';
/** Always everything — the proof of consent (filters are ignored by the server). */
export const AUDIT_HREF = LIST_API + '?format=audit';

export function parseStatusFilter(value: string | null | undefined): StatusFilterValue {
  return STATUS_FILTERS.some((f) => f.value === value) ? (value as StatusFilterValue) : 'all';
}

function withQuery(base: string, params: Array<[string, string]>): string {
  const qs = new URLSearchParams(params.filter(([, v]) => v !== '')).toString();
  return qs ? base + '?' + qs : base;
}

/** `GET /api/admin/subscribers?status=&q=` for the filter + search. */
export function listPath(filter: StatusFilterValue, q: string): string {
  return withQuery(LIST_API, [
    ['status', filter === 'all' ? '' : filter],
    ['q', q.trim()],
  ]);
}

/** The admin page URL that keeps the filter (and search) across reloads. */
export function adminListHref(filter: StatusFilterValue, q: string): string {
  return withQuery(LIST_PAGE, [
    ['status', filter === 'all' ? '' : filter],
    ['q', q.trim()],
  ]);
}

/** CSV export of the active filter (the search is a view aid, not an export filter). */
export function csvHref(filter: StatusFilterValue): string {
  return withQuery(LIST_API, [
    ['format', 'csv'],
    ['status', filter === 'all' ? '' : filter],
  ]);
}

export function subscriberHref(id: string): string {
  return LIST_PAGE + '/' + encodeURIComponent(id);
}

export function subscriberApi(id: string, sub?: string): string {
  return LIST_API + '/' + encodeURIComponent(id) + (sub ? '/' + sub : '');
}

export function statusPillLabel(s: Pick<SubscriberDto, 'status' | 'pendingExpired'>): string {
  const label = STATUS_LABELS[s.status];
  return s.status === 'pending' && s.pendingExpired ? label + ' · expired' : label;
}

export function statusTagClass(status: SubscriberStatus): string {
  return 'tag tag--' + (status === 'legacy_unconfirmed' ? 'legacy' : status);
}

export function emptyMessage(filter: StatusFilterValue, q: string): string {
  if (q.trim()) return 'No address matches.';
  if (filter !== 'all') return 'Nothing with that status.';
  return 'No subscribers yet. Signups from the footer form on every public page land here.';
}

/** The legacy banner / Site card sentence. */
export function legacySentence(n: number): string {
  return n === 1
    ? '1 subscriber from before double opt-in has not confirmed. They never receive issues until they do.'
    : `${n} subscribers from before double opt-in have not confirmed. They never receive issues until they do.`;
}

export function sourceCells(s: Pick<SubscriberDto, 'source' | 'sourceUrl'>): { main: string; faint: string | null } {
  return { main: s.source, faint: s.sourceUrl };
}

function str(details: Record<string, unknown>, key: string): string | null {
  const v = details[key];
  return typeof v === 'string' && v ? v : null;
}

/** Timeline label per event kind (spec/ui.md §4 "Subscriber" → Timeline). */
export function eventLabel(ev: SubscriberEventDto): string {
  const d = ev.details ?? {};
  switch (ev.kind) {
    case 'signup': {
      const from = str(d, 'sourceUrl');
      return from ? `Signed up from ${from}` : 'Signed up';
    }
    case 'confirmation_sent':
    case 'legacy_confirmation_sent': {
      const base = ev.kind === 'confirmation_sent' ? 'Confirmation email sent' : 'One-time legacy confirmation sent';
      const transport = str(d, 'transport');
      const failed = str(d, 'outcome') === 'failed';
      return base + (transport ? ` (${transport})` : '') + (failed ? ' — failed' : '');
    }
    case 'confirmed':
      return 'Confirmed';
    case 'resubscribed':
      return 'Re-subscribed';
    case 'unsubscribed':
      switch (ev.source) {
        case 'email_link':
          return 'Unsubscribed via email link';
        case 'one_click':
          return 'Unsubscribed via one-click';
        case 'admin':
          return 'Unsubscribed by an admin';
        case 'migration':
          return 'Unsubscribed (before double opt-in)';
        default:
          return `Unsubscribed (${ev.source})`;
      }
    case 'bounced':
      return `Bounced (${ev.source})`;
    case 'provider_synced':
      return 'Synced to Listmonk';
    case 'provider_removed':
      return 'Removed from Listmonk';
    case 'ip_pruned':
      return 'IP pruned';
    case 'erased':
      return 'Personal data erased';
    default:
      return String(ev.kind);
  }
}

export function safeDate(iso: string, timeZone: string): string {
  try {
    return fmtDate(iso, timeZone);
  } catch {
    try {
      return fmtDate(iso, 'UTC');
    } catch {
      return iso;
    }
  }
}

/** "12 Oct 2026, 10:00" in the site timezone (audit times). */
export function dateTimeLabel(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  let hm = '';
  try {
    hm = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  } catch {
    hm = d.toISOString().slice(11, 16) + ' UTC';
  }
  return `${safeDate(iso, timeZone)}, ${hm}`;
}

/** "203.0.113.9" / "pruned 12 Oct 2027" / "not recorded — no trusted proxy". */
export function ipLine(s: SubscriberDetailDto, which: 'signup' | 'confirmed', timeZone: string): string {
  const ip = which === 'signup' ? s.signupIp : s.confirmedIp;
  if (ip) return ip;
  if (s.ipPrunedAt) return `pruned ${safeDate(s.ipPrunedAt, timeZone)}`;
  return 'not recorded — no trusted proxy';
}

export interface ConfirmationAction {
  label: string;
  disabled: boolean;
  title: string | undefined;
}

export const PENDING_CAP_TITLE = 'Limit reached — try again later (3 confirmation emails per 24 hours).';

/** The Send confirmation button: legacy (one-time) and pending (3 per 24 h) rows only. */
export function confirmationAction(s: SubscriberDetailDto, timeZone: string): ConfirmationAction | null {
  if (s.status === 'legacy_unconfirmed') {
    const disabled = !s.canSendConfirmation;
    const title = disabled ? (s.legacyConfirmationSentAt ? `Already sent ${safeDate(s.legacyConfirmationSentAt, timeZone)}` : 'Already sent') : undefined;
    return { label: 'Send the one-time confirmation', disabled, title };
  }
  if (s.status === 'pending') {
    const disabled = !s.canSendConfirmation;
    return { label: 'Resend confirmation', disabled, title: disabled ? PENDING_CAP_TITLE : undefined };
  }
  return null;
}

/** `error.details.retryAt` of a 409 CONFIRMATION_ALREADY_SENT → "Limit reached — try after …". */
export function retryAtMessage(details: unknown, timeZone: string): string | null {
  if (!details || typeof details !== 'object') return null;
  const at = (details as { retryAt?: unknown }).retryAt;
  if (typeof at !== 'string') return null;
  if (Number.isNaN(new Date(at).getTime())) return null;
  return `Limit reached — try after ${dateTimeLabel(at, timeZone)}.`;
}

export function canUnsubscribe(status: SubscriberStatus): boolean {
  return status !== 'unsubscribed' && status !== 'bounced';
}

// ---- Erase personal data (fix pass; spec/ui.md §4 "Subscriber") ----

export const ERASE_CONFIRM = (email: string): string =>
  `Erase ${email}? This permanently redacts the address, IP, user agent and source page in the subscriber, event and message records and removes the address from Listmonk. A tombstone and an erased entry remain. This cannot be undone.`;

/** The Erase button is enabled only when the typed text equals the address (case-insensitive). */
export function eraseConfirmMatches(typed: string, email: string): boolean {
  const t = typed.trim().toLowerCase();
  return t !== '' && t === email.trim().toLowerCase();
}

export function eraseNotice(providerRemoved: boolean): string {
  return providerRemoved ? 'Erased. Listmonk copy removed.' : 'Erased. Listmonk removal failed — see the log.';
}

/** The tombstone address an erased subscriber carries (`erased+<hash>@erased.invalid`). */
export function isErasedEmail(email: string): boolean {
  return /^erased\+[^@]+@erased\.invalid$/i.test(email);
}

export function canErase(email: string): boolean {
  return !isErasedEmail(email);
}
