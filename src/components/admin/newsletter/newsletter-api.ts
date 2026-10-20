// Admin → Newsletter helpers (pure, isomorphic): admin API paths for issues, status / origin
// labels, the send-log labels and the one-click send confirmation copy (spec/ui.md §4
// "Newsletter", "Issue"; spec/api.md "Endpoints — newsletter").

import type { IssueEventDto, IssueOrigin, IssueStatus, NewsletterStatusDto } from '@/lib/api/dto';

export const ISSUES_API = '/api/admin/newsletter/issues';
export const ISSUES_PAGE = '/admin/newsletter';
export const SETTINGS_API = '/api/admin/newsletter/settings';
export const SETTINGS_HREF = '/admin/site#newsletter';

export function issueApi(id: string, sub?: 'preview' | 'test' | 'send' | 'stats'): string {
  return ISSUES_API + '/' + encodeURIComponent(id) + (sub ? '/' + sub : '');
}

export function issueHref(id: string): string {
  return ISSUES_PAGE + '/' + encodeURIComponent(id);
}

/** The admin-gated full-page HTML preview (served by S7.3's route handler). */
export function issuePreviewPageHref(id: string): string {
  return issueHref(id) + '/preview';
}

export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = { draft: 'Draft', sending: 'Sending', sent: 'Sent', failed: 'Failed' };
export const ORIGIN_LABEL: Record<IssueOrigin, string> = { per_post: 'Per post', digest: 'Digest', manual: 'Manual' };

export function issueStatusClass(status: IssueStatus): string {
  return 'spill spill--' + status;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function str(d: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = d[k];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}

function num(d: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = d[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/** Send-log label per event kind (spec/ui.md §4 "Issue" → Send log). */
export function issueEventLabel(ev: IssueEventDto): string {
  const d = ev.details ?? {};
  switch (ev.kind) {
    case 'created':
      return 'Created';
    case 'updated':
      return 'Updated';
    case 'test_sent': {
      const to = str(d, 'sentTo', 'toEmail', 'to', 'email');
      return to ? `Test sent to ${to}` : 'Test sent';
    }
    case 'send_requested': {
      const n = num(d, 'recipients', 'recipientCount');
      return n === null ? 'Send requested' : `Send requested (${plural(n, 'recipient', 'recipients')})`;
    }
    case 'provider_created': {
      const id = str(d, 'campaignId', 'providerCampaignId');
      return id ? `Campaign created ${id}` : 'Campaign created';
    }
    case 'provider_started':
      return 'Campaign started';
    case 'sent':
      return 'Sent';
    case 'failed': {
      const e = str(d, 'error', 'message', 'lastError');
      return e ? `Failed: ${e}` : 'Failed';
    }
    case 'stats_fetched':
      return 'Stats fetched';
    case 'deleted':
      return 'Deleted';
    default:
      return String(ev.kind);
  }
}

export function sendConfirmTitle(recipients: number): string {
  return `Send to ${plural(recipients, 'confirmed subscriber', 'confirmed subscribers')}?`;
}

export function senderNote(sender: NewsletterStatusDto['sender']): string {
  if (sender.kind === 'stub') return 'via the stub sender — recorded, not delivered';
  return `via Listmonk · list ${sender.listName ?? sender.listId ?? '?'}`;
}

export function sentLine(recipients: number | null): string {
  return recipients === null ? 'Sent' : `Sent to ${plural(recipients, 'subscriber', 'subscribers')}`;
}

// ---- Postal address warning (fix pass; spec/ui.md §4 "Issue") ----

export const POSTAL_WARNING = 'No postal address is set — issues will go out without one. Add it in Site → Newsletter postal address.';

/** True when an issue's `warnings` (strings or `{ code }` objects) carry `postal_address_missing`. */
export function postalAddressMissing(warnings: unknown): boolean {
  if (!Array.isArray(warnings)) return false;
  return warnings.some((w) => w === 'postal_address_missing' || (typeof w === 'object' && w !== null && (w as { code?: unknown }).code === 'postal_address_missing'));
}
