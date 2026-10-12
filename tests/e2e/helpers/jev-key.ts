// PENDING KEY rule (spec/architecture.md → Conventions): the real Generate step runs only with a
// real (non-placeholder) BLOG0_OPENROUTER_API_KEY; locally it SKIPS visibly, under CI it FAILS.
// The key is presence-checked only — never printed.
import '../../../scripts/lib/allow-server-only';

import { openRouterKeyStatus } from '@/server/llm/key';

export const PENDING_KEY_TITLE = 'PENDING KEY: BLOG0_OPENROUTER_API_KEY unset';

export type JevKeyPlan = 'real' | 'pending-skip' | 'ci-fail';

export function jevKeyPlan(env: Record<string, string | undefined> = process.env): JevKeyPlan {
  if (openRouterKeyStatus(env.BLOG0_OPENROUTER_API_KEY) === 'real') return 'real';
  return env.CI === 'true' ? 'ci-fail' : 'pending-skip';
}
