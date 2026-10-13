// Listmonk test helper (spec/roadmap.md Phase 7, S7.2): reads var/listmonk-dev.env written by
// `pnpm listmonk:up`, probes the Docker daemon, and offers a raw admin-API client for assertions
// and cleanup that must not go through the adapter under test.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const LISTMONK_ENV_FILE = path.join(process.cwd(), 'var', 'listmonk-dev.env');
export const PENDING_DOCKER_REASON = 'PENDING DOCKER: start it with colima start, then pnpm listmonk:up';

export interface ListmonkDevEnv {
  url: string;
  apiUser: string;
  apiToken: string;
  listId: number;
}

/** `docker info` succeeds ⇒ a daemon is reachable (DOCKER_HOST honoured). */
export function dockerReachable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/** The env file from `pnpm listmonk:up`; null when it is missing or incomplete. Values are never logged. */
export function readListmonkDevEnv(): ListmonkDevEnv | null {
  if (!existsSync(LISTMONK_ENV_FILE)) return null;
  const vars = new Map<string, string>();
  for (const line of readFileSync(LISTMONK_ENV_FILE, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) vars.set(m[1] as string, m[2] as string);
  }
  const url = vars.get('BLOG0_LISTMONK_URL') ?? '';
  const apiUser = vars.get('BLOG0_LISTMONK_API_USER') ?? '';
  const apiToken = vars.get('BLOG0_LISTMONK_API_TOKEN') ?? '';
  const listId = Number(vars.get('BLOG0_LISTMONK_LIST_ID') ?? '');
  if (url === '' || apiUser === '' || apiToken === '' || !Number.isInteger(listId) || listId <= 0) return null;
  return { url: url.replace(/\/+$/, ''), apiUser, apiToken, listId };
}

export interface ListmonkRawSubscriber {
  id: number;
  email: string;
  name: string;
  status: string;
  attribs: Record<string, unknown>;
  lists: Array<{ id: number; subscription_status: string }>;
}

/** Raw Listmonk API client (API-user token auth) for test assertions + cleanup. */
export function listmonkRaw(env: ListmonkDevEnv) {
  const headers = { authorization: `token ${env.apiUser}:${env.apiToken}`, 'content-type': 'application/json' };
  async function call<T>(method: string, p: string, body?: unknown): Promise<T> {
    const res = await fetch(`${env.url}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`listmonk raw ${method} ${p} → ${res.status}: ${text}`);
    return (JSON.parse(text) as { data: T }).data;
  }
  return {
    call,
    async subscriberByEmail(email: string): Promise<ListmonkRawSubscriber | null> {
      const q = encodeURIComponent(`subscribers.email='${email.replace(/'/g, "''")}'`);
      const page = await call<{ results: ListmonkRawSubscriber[] }>('GET', `/api/subscribers?query=${q}&per_page=1`);
      return page.results[0] ?? null;
    },
    async deleteSubscriberByEmail(email: string): Promise<void> {
      const row = await this.subscriberByEmail(email);
      if (row) await call('DELETE', `/api/subscribers/${row.id}`);
    },
    async campaign(id: string): Promise<{ id: number; status: string; body: string; altbody: string; name: string; subject: string; tags: string[]; template_id: number }> {
      return call('GET', `/api/campaigns/${id}`);
    },
    async deleteCampaign(id: string): Promise<void> {
      try {
        await call('DELETE', `/api/campaigns/${id}`);
      } catch {
        // a running campaign cannot be deleted until it finishes; cancel first, then delete
        await call('PUT', `/api/campaigns/${id}/status`, { status: 'cancelled' }).catch(() => undefined);
        await call('DELETE', `/api/campaigns/${id}`).catch(() => undefined);
      }
    },
  };
}
