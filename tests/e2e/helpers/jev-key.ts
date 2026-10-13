// PENDING KEY rule (spec/architecture.md → Conventions): the real Generate step runs only with a
// real (non-placeholder) BLOG0_OPENROUTER_API_KEY. Without one it FAILS when `realKeyRequired`
// (BLOG0_REQUIRE_REAL_KEY=1, or CI=true when that is unset) and otherwise SKIPS visibly.
// The key is presence-checked only — never printed.
import '../../../scripts/lib/allow-server-only';

import { openRouterKeyStatus, realKeyRequired } from '@/server/llm/key';

export const PENDING_KEY_TITLE = 'PENDING KEY: BLOG0_OPENROUTER_API_KEY unset';

/** 'ci-fail' = a real key is required but absent (name kept for tldr.spec.ts; not only CI). */
export type JevKeyPlan = 'real' | 'pending-skip' | 'ci-fail';

export function jevKeyPlan(env: Record<string, string | undefined> = process.env): JevKeyPlan {
  if (openRouterKeyStatus(env.BLOG0_OPENROUTER_API_KEY) === 'real') return 'real';
  return realKeyRequired(env) ? 'ci-fail' : 'pending-skip';
}
