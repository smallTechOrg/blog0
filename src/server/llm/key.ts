import 'server-only';

// Presence check for the OpenRouter key (never prints it). Real-key tests and `pnpm eval:jev`
// use this to report "PENDING KEY" instead of running against an absent or placeholder key.

export const PENDING_KEY_REASON = 'PENDING KEY: BLOG0_OPENROUTER_API_KEY not set';

const PLACEHOLDER_RE = /^(replace|pending|placeholder|changeme|change-me|your|xxx|todo|<)|placeholder|replace-with/i;

/** 'real' when a plausible key is set; 'missing' when empty; 'placeholder' for .env.example-style values. */
export function openRouterKeyStatus(raw: string | undefined): 'real' | 'missing' | 'placeholder' {
  const value = (raw ?? '').trim();
  if (value === '') return 'missing';
  if (PLACEHOLDER_RE.test(value)) return 'placeholder';
  return 'real';
}
