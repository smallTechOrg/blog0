// The site's AI provider for the real-key E2E steps (SMA-44). The API key is sealed here, in the test
// process (same BLOG0_SESSION_SECRET as the server it starts), and written straight to blog0_test, so
// the real key is never typed into the browser — a Playwright trace of a failed run (uploaded as a CI
// artifact) records every typed value and request body.
import '../../../scripts/lib/allow-server-only';

import { seal } from '@/server/ai/secret-box';
import { Secret } from '@/server/config';

import { withTestDb } from './db';

export async function saveProviderOutOfBand(p: { baseUrl: string; model: string; apiKey: string }, siteSlug = 'blog0'): Promise<void> {
  const secret = (process.env.BLOG0_SESSION_SECRET ?? '').trim();
  if (!secret) throw new Error('BLOG0_SESSION_SECRET is not set for the E2E run');
  const sealed = seal(p.apiKey, new Secret(secret));
  await withTestDb(async (sql) => {
    const [site] = await sql<{ id: string }[]>`select id from site where slug = ${siteSlug}`;
    await sql`
      insert into ai_provider (site_id, base_url, model, api_key_sealed, api_key_hint)
      values (${site.id}, ${p.baseUrl}, ${p.model}, ${sealed}, ${p.apiKey.slice(-4)})
      on conflict (site_id) do update set base_url = excluded.base_url, model = excluded.model,
        api_key_sealed = excluded.api_key_sealed, api_key_hint = excluded.api_key_hint,
        last_ok_at = null, last_error_at = null, last_error_code = null, last_error_message = null, updated_at = now()`;
  });
}

export async function clearProvider(): Promise<void> {
  await withTestDb((sql) => sql`delete from ai_provider`);
}
