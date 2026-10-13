// Admin → Site → Newsletter card helpers (pure, isomorphic): saved settings ⇄ form draft, the
// minimal PATCH (spec/api.md PATCH /api/admin/newsletter/settings — any subset), client checks
// against NEWSLETTER_SETTINGS_LIMITS, and the status-strip / confirmation copy (spec/ui.md §4 "Site").

import {
  NEWSLETTER_SETTINGS_LIMITS as L,
  type NewsletterMode,
  type NewsletterSettingsDto,
  type NewsletterSettingsPatch,
  type NewsletterStatusDto,
  type SubscriberCounts,
} from '@/lib/api/dto';
import { fmtDate } from '@/lib/format-date';

export interface NewsletterDraft {
  mode: NewsletterMode;
  autoSend: boolean;
  /** number inputs are strings until saved */
  digestDays: string;
  digestPosts: string;
  consentText: string;
  consentVersion: string;
}

export type NewsletterField = 'digestDays' | 'digestPosts' | 'consentText' | 'consentVersion';
export type NewsletterErrors = Partial<Record<NewsletterField, string>>;

export const MODES: readonly NewsletterMode[] = ['manual', 'per_post', 'digest'];
export const MODE_LABEL: Record<NewsletterMode, string> = { manual: 'Manual', per_post: 'Per post', digest: 'Digest' };
export const MODE_HELP = {
  manual: 'Issues are created only by hand.',
  per_post: 'Every first publish creates an issue.',
  digest: (days: number | string, posts: number | string) => `One issue every ${days} days or ${posts} posts, whichever first.`,
} as const;

export const AUTO_SEND_WARNING = 'Send automatic issues without review. Off: every issue waits as a draft until you click Send.';
export const SYNC_CONFIRM = 'Push every confirmed subscriber to Listmonk and blocklist the unsubscribed ones?';
export const CONSENT_VERSION_HINT = 'Bumped automatically when the text changes — leave as is.';
export const STUB_SENDER_HINT = 'Set BLOG0_NEWSLETTER_SENDER=listmonk and the BLOG0_LISTMONK_* values to send for real.';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function autoSendConfirm(confirmed: number): string {
  return `Issues will go out to ${plural(confirmed, 'confirmed subscriber', 'confirmed subscribers')} with no review. Turn auto-send on?`;
}

export function legacyConfirm(n: number): string {
  return `Send one confirmation email to ${plural(n, 'address', 'addresses')}? Each address gets it once.`;
}

export function draftFrom(saved: NewsletterSettingsDto): NewsletterDraft {
  return {
    mode: saved.mode,
    autoSend: saved.autoSend,
    digestDays: String(saved.digestDays),
    digestPosts: String(saved.digestPosts),
    consentText: saved.consentText,
    consentVersion: saved.consentVersion,
  };
}

function intOf(value: string): number | null {
  const v = value.trim();
  return /^\d+$/.test(v) ? Number(v) : null;
}

/** Only the changed fields, as the server would store them (numbers parsed, texts trimmed). */
export function patchFrom(saved: NewsletterSettingsDto, draft: NewsletterDraft): NewsletterSettingsPatch {
  const patch: NewsletterSettingsPatch = {};
  if (draft.mode !== saved.mode) patch.mode = draft.mode;
  if (draft.autoSend !== saved.autoSend) patch.autoSend = draft.autoSend;
  const days = intOf(draft.digestDays);
  if (days !== null && days !== saved.digestDays) patch.digestDays = days;
  const posts = intOf(draft.digestPosts);
  if (posts !== null && posts !== saved.digestPosts) patch.digestPosts = posts;
  const text = draft.consentText.trim();
  if (text !== saved.consentText) patch.consentText = text;
  const version = draft.consentVersion.trim();
  if (version !== saved.consentVersion) patch.consentVersion = version;
  return patch;
}

export function isDirty(saved: NewsletterSettingsDto, draft: NewsletterDraft): boolean {
  return Object.keys(patchFrom(saved, draft)).length > 0 || draft.digestDays.trim() !== String(saved.digestDays) || draft.digestPosts.trim() !== String(saved.digestPosts);
}

function inRange(value: string, [min, max]: readonly [number, number]): boolean {
  const n = intOf(value);
  return n !== null && n >= min && n <= max;
}

/** Client-side checks (the server re-checks); {} when the draft can be saved. Thresholds only matter in digest mode. */
export function validateDraft(draft: NewsletterDraft): NewsletterErrors {
  const errors: NewsletterErrors = {};
  if (draft.mode === 'digest') {
    if (!inRange(draft.digestDays, L.digestDays)) errors.digestDays = `Between ${L.digestDays[0]} and ${L.digestDays[1]} days.`;
    if (!inRange(draft.digestPosts, L.digestPosts)) errors.digestPosts = `Between ${L.digestPosts[0]} and ${L.digestPosts[1]} posts.`;
  }
  const text = draft.consentText.trim();
  if (!text) errors.consentText = 'The consent text is required.';
  else if (text.length > L.consentText) errors.consentText = `At most ${L.consentText} characters.`;
  const version = draft.consentVersion.trim();
  if (!version) errors.consentVersion = 'The version is required.';
  else if (version.length > L.consentVersion) errors.consentVersion = `At most ${L.consentVersion} characters.`;
  return errors;
}

/** Outside digest mode the hidden thresholds must not block a save: send them only when valid. */
export function savablePatch(saved: NewsletterSettingsDto, draft: NewsletterDraft): NewsletterSettingsPatch {
  const patch = patchFrom(saved, draft);
  if (draft.mode !== 'digest') {
    if (patch.digestDays !== undefined && !inRange(draft.digestDays, L.digestDays)) delete patch.digestDays;
    if (patch.digestPosts !== undefined && !inRange(draft.digestPosts, L.digestPosts)) delete patch.digestPosts;
  }
  return patch;
}

/** `error.details` of a 400 VALIDATION_FAILED → per-field messages. */
export function fieldErrorsFrom(details: unknown): NewsletterErrors {
  if (!details || typeof details !== 'object') return {};
  const fe = (details as { fieldErrors?: unknown }).fieldErrors;
  if (!fe || typeof fe !== 'object') return {};
  const out: NewsletterErrors = {};
  for (const f of ['digestDays', 'digestPosts', 'consentText', 'consentVersion'] as const) {
    const msgs = (fe as Record<string, unknown>)[f];
    const first = Array.isArray(msgs) ? msgs.find((m) => typeof m === 'string' && m) : typeof msgs === 'string' ? msgs : undefined;
    if (typeof first === 'string' && first) out[f] = first;
  }
  return out;
}

export interface SenderLine {
  kind: 'Listmonk' | 'Stub';
  rest: string;
  stub: boolean;
}

export function senderLine(sender: NewsletterStatusDto['sender']): SenderLine {
  if (sender.kind === 'stub') return { kind: 'Stub', rest: 'issues are recorded, not delivered', stub: true };
  if (!sender.configured) return { kind: 'Listmonk', rest: 'not configured', stub: false };
  const list = `list ${sender.listName ?? sender.listId ?? '?'}`;
  const health =
    sender.healthy === true ? 'healthy' : sender.healthy === false ? (sender.message ? `unreachable — ${sender.message}` : 'unreachable') : 'health unknown';
  return { kind: 'Listmonk', rest: `${list} · ${health}`, stub: false };
}

export function mailLine(mail: NewsletterStatusDto['mail']): string {
  if (mail.transport === 'stub') return 'Stub — confirmation links are written to the server log and the subscriber’s audit view';
  return mail.from ? `SMTP from ${mail.from}` : 'SMTP';
}

export function countsLine(counts: SubscriberCounts): string {
  return `${counts.confirmed} confirmed · ${counts.pending} pending · ${counts.legacy_unconfirmed} legacy`;
}

function day(iso: string, timeZone: string): string {
  try {
    return fmtDate(iso, timeZone);
  } catch {
    return iso.slice(0, 10);
  }
}

/** "Next digest: due 8 Oct 2026 · 2 new posts since 1 Oct 2026" (digest mode only). */
export function digestHint(digest: NewsletterStatusDto['digest'], timeZone: string): string | null {
  if (!digest) return null;
  const due = digest.dueAt ? `due ${day(digest.dueAt, timeZone)}` : 'not scheduled yet';
  const n = digest.newPostsSince;
  const posts = n === 0 ? 'no new posts' : plural(n, 'new post', 'new posts');
  const since = digest.lastIssueAt ? ` since ${day(digest.lastIssueAt, timeZone)}` : '';
  return `Next digest: ${due} · ${posts}${since}`;
}

export function syncResultLine(r: { synced: number; blocklisted: number; skipped: number; changed: number }): string {
  return `Synced ${r.synced}, blocklisted ${r.blocklisted}, ${r.changed} changed` + (r.skipped ? ` (${r.skipped} skipped)` : '');
}
