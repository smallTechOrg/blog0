import 'server-only';

// Presence check for the OpenRouter key (never prints it). Real-key tests and `pnpm eval:jev`
// use this to report "PENDING KEY" instead of running against an absent or placeholder key;
// `realKeyRequired` decides whether that is a visible skip or a failure.

export const PENDING_KEY_REASON = 'PENDING KEY: BLOG0_OPENROUTER_API_KEY not set';

const PLACEHOLDER_RE = /^(replace|pending|placeholder|changeme|change-me|your|xxx|todo|<)|placeholder|replace-with/i;

/** 'real' when a plausible key is set; 'missing' when empty; 'placeholder' for .env.example-style values. */
export function openRouterKeyStatus(raw: string | undefined): 'real' | 'missing' | 'placeholder' {
  const value = (raw ?? '').trim();
  if (value === '') return 'missing';
  if (PLACEHOLDER_RE.test(value)) return 'placeholder';
  return 'real';
}

/**
 * Whether a missing/placeholder OpenRouter key must FAIL the real-key tests and `pnpm eval:jev`
 * (true) or SKIP them as `PENDING KEY` (false). `BLOG0_REQUIRE_REAL_KEY === '1'` → true;
 * `=== '0'` → false; unset/other → `CI === 'true'`. The only place that reads `CI` for this rule
 * (spec/architecture.md → Conventions → Real-key tests). CI sets the flag from the secret's presence.
 */
export function realKeyRequired(env: Record<string, string | undefined> = process.env): boolean {
  const flag = (env.BLOG0_REQUIRE_REAL_KEY ?? '').trim();
  if (flag === '1') return true;
  if (flag === '0') return false;
  return env.CI === 'true';
}
