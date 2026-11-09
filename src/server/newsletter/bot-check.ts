// Stage A signup bot drop (spec/api.md POST /api/newsletter; spec/architecture.md §6;
// newsletter-list.md). Pure. Runs after body validation and before any rate-limit bucket is counted:
// a non-empty (trimmed) hidden `website` field, or a submission under 2 s after the form mounted
// (or without the fill time at all), is dropped silently — same success-shaped response, nothing
// written, one `newsletter.signup_dropped` log line with the reason.
// > Assumed (newsletter-list.md): 2 s minimum; API callers must send `fillMs` (the footer form does).

export const MIN_FILL_MS = 2000;

export type BotDropReason = 'honeypot' | 'too_fast';

export function botDropReason(body: { website?: string; fillMs?: number }): BotDropReason | null {
  if ((body.website ?? '').trim() !== '') return 'honeypot';
  if (body.fillMs === undefined || body.fillMs < MIN_FILL_MS) return 'too_fast';
  return null;
}
