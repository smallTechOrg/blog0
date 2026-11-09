// pnpm newsletter:sync [-- --create-list]
// blog0 → provider, one direction (spec/architecture.md §13.3 "Sync"): every `confirmed` subscriber of
// the site BLOG0_SITE_SLUG is upserted at the sender with its consent attributes; every
// `unsubscribed` / `bounced` one is blocklisted; pending / legacy rows are skipped. Never creates,
// enables or deletes anything in blog0. Idempotent — a second run prints "… 0 changed".
// Prints "synced N, blocklisted N, skipped N, N changed" (+ "; N suppressed from provider …" when a
// newer provider-side opt-out was recorded in blog0 instead of re-adding); exits 1 on any error (each one listed, email masked).
// --create-list: create (or find) the Listmonk list named `blog0` from BLOG0_LISTMONK_URL / _API_USER /
// _API_TOKEN and print its id for BLOG0_LISTMONK_LIST_ID (nothing is synced).
import { runCli } from './lib/cli';

import { getConfig } from '../src/server/config';
import { closeDb, initDb } from '../src/server/db/client';
import { maskEmail } from '../src/server/log';
import { requireHealthySender } from '../src/server/newsletter/issues/send';
import { getNewsletterSender } from '../src/server/newsletter/sender';
import { syncAll } from '../src/server/newsletter/sender/sync';
import { getCurrentSite } from '../src/server/site/current';

const USAGE = 'Usage: pnpm newsletter:sync [-- --create-list]';
const LIST_NAME = 'blog0';

function env(name: string): string {
  const v = (process.env[name] ?? '').replace(/\s+#.*$/, '').trim();
  if (v === '') throw new Error(`${name} is required for --create-list (see .env.example)`);
  return v;
}

async function createList(): Promise<void> {
  const base = env('BLOG0_LISTMONK_URL').replace(/\/+$/, '');
  const headers = { authorization: `token ${env('BLOG0_LISTMONK_API_USER')}:${env('BLOG0_LISTMONK_API_TOKEN')}`, 'content-type': 'application/json' };
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Listmonk ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    return (JSON.parse(text) as { data: T }).data;
  };
  const lists = await call<{ results: Array<{ id: number; name: string }> }>('GET', '/api/lists?per_page=all');
  const existing = lists.results.find((l) => l.name === LIST_NAME);
  if (existing) {
    console.log(`list ${LIST_NAME} exists: id ${existing.id} — set BLOG0_LISTMONK_LIST_ID=${existing.id}`);
    return;
  }
  const created = await call<{ id: number }>('POST', '/api/lists', { name: LIST_NAME, type: 'private', optin: 'single', tags: ['blog0'] });
  console.log(`list ${LIST_NAME} created: id ${created.id} — set BLOG0_LISTMONK_LIST_ID=${created.id}`);
}

runCli('newsletter:sync', async () => {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const unknown = args.filter((a) => a !== '--create-list');
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(' ')}\n${USAGE}`);
  if (args.includes('--create-list')) {
    await createList();
    return;
  }

  const config = getConfig();
  await initDb();
  try {
    const site = await getCurrentSite();
    const sender = getNewsletterSender();
    await requireHealthySender(sender);
    const r = await syncAll('script', { sender, siteId: site.id });
    console.log(`sender ${sender.kind}${sender.kind === 'listmonk' ? ` (list ${config.newsletter.listmonk?.listId})` : ' — nothing is mirrored'}, site ${config.siteSlug}`);
    console.log(`synced ${r.synced}, blocklisted ${r.blocklisted}, skipped ${r.skipped}, ${r.changed} changed${r.suppressedFromProvider > 0 ? `; ${r.suppressedFromProvider} suppressed from provider (opted out there, not re-added)` : ''}`);
    if (r.errors.length > 0) {
      for (const e of r.errors) console.error(`error: ${maskEmail(e.email)}: ${e.message}`);
      throw new Error(`${r.errors.length} subscriber(s) failed to sync`);
    }
  } finally {
    await closeDb();
  }
});
