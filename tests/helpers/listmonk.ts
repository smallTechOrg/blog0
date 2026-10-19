// Listmonk test helper (spec/roadmap.md Phase 7, S7.2): reads var/listmonk-test.env written by
// `pnpm listmonk:test-up` — the TEST stack (listmonk-test on :9001, SMTP → Mailpit), never the dev
// Listmonk on :9000, which may carry the owner's real relay. Offers a raw admin-API client for
// assertions and cleanup that must not go through the adapter under test, the SMTP sink guard every
// Listmonk test runs first, and a Mailpit client to assert what was "delivered".
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const LISTMONK_ENV_FILE = path.join(process.cwd(), 'var', 'listmonk-test.env');
export const LISTMONK_TEST_UP_COMMAND = 'pnpm listmonk:test-up';
export const LISTMONK_TEST_STACK_DOWN_REASON = `LISTMONK TEST STACK DOWN: start it with ${LISTMONK_TEST_UP_COMMAND} (Docker; Listmonk on :9001 → Mailpit)`;

export interface ListmonkTestEnv {
  url: string;
  apiUser: string;
  apiToken: string;
  listId: number;
  /** Mailpit's HTTP API (the sink the test stack's SMTP points at). */
  mailpitUrl: string;
}

/** The env file from `pnpm listmonk:test-up`; null when it is missing or incomplete. Values are never logged. */
export function readListmonkTestEnv(): ListmonkTestEnv | null {
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
  const mailpitUrl = vars.get('BLOG0_MAILPIT_URL') ?? 'http://127.0.0.1:8025';
  if (url === '' || apiUser === '' || apiToken === '' || !Number.isInteger(listId) || listId <= 0) return null;
  return { url: url.replace(/\/+$/, ''), apiUser, apiToken, listId, mailpitUrl: mailpitUrl.replace(/\/+$/, '') };
}

/**
 * Probe for the test stack: the env file exists and its token answers /api/health. `null` ⇒ the
 * stack is not up — the Listmonk test files then SKIP visibly with LISTMONK_TEST_STACK_DOWN_REASON.
 */
export async function probeListmonkTestStack(): Promise<ListmonkTestEnv | null> {
  const env = readListmonkTestEnv();
  if (env === null) return null;
  try {
    const res = await fetch(`${env.url}/api/health`, {
      headers: { authorization: `token ${env.apiUser}:${env.apiToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok ? env : null;
  } catch {
    return null;
  }
}

const SINK_HOSTS = new Set(['mailpit', '127.0.0.1', 'localhost', '::1']);
const SINK_PORT = 1025;

/**
 * Every ENABLED SMTP server in a Listmonk /api/settings payload that is not the Mailpit sink
 * (host mailpit / loopback, port 1025), as `host:port`. Fails closed: no smtp array or no enabled
 * server is a violation too. Empty array ⇒ the instance can only deliver into Mailpit.
 */
export function smtpSinkViolations(settings: unknown): string[] {
  const smtp = (settings as { smtp?: unknown } | null)?.smtp;
  if (!Array.isArray(smtp)) return ['no smtp settings'];
  const enabled = smtp.filter((s): s is { host?: unknown; port?: unknown } => typeof s === 'object' && s !== null && (s as { enabled?: unknown }).enabled === true);
  if (enabled.length === 0) return ['no enabled SMTP server (expected the Mailpit sink)'];
  const out: string[] = [];
  for (const s of enabled) {
    const host = typeof s.host === 'string' ? s.host.trim().toLowerCase() : '';
    const port = Number(s.port);
    if (!SINK_HOSTS.has(host) || port !== SINK_PORT) out.push(`${host === '' ? '(no host)' : host}:${String(s.port)}`);
  }
  return out;
}

/**
 * The guard every Listmonk test runs before touching the instance: throws (fails the suite loudly,
 * never skips) unless every enabled SMTP server is the Mailpit sink. Campaigns started by the tests
 * are real sends — against a real relay they would leave the machine.
 */
export async function assertListmonkSmtpIsSink(env: ListmonkTestEnv): Promise<void> {
  const res = await fetch(`${env.url}/api/settings`, { headers: { authorization: `token ${env.apiUser}:${env.apiToken}` } });
  if (!res.ok) throw new Error(`REFUSING to run Listmonk tests: GET ${env.url}/api/settings → ${res.status} (cannot prove SMTP is the Mailpit sink)`);
  const violations = smtpSinkViolations(((await res.json()) as { data?: unknown }).data);
  if (violations.length > 0) {
    throw new Error(
      `REFUSING to run Listmonk tests: ${env.url} has SMTP that is not the Mailpit sink (${violations.join(', ')}). ` +
        `Tests only run against the test stack (${LISTMONK_TEST_UP_COMMAND}: listmonk-test on :9001 → mailpit:1025); never against a Listmonk with a real relay.`,
    );
  }
}

export interface MailpitMessageSummary {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

/** Mailpit's API (http://127.0.0.1:8025/api/v1): what the test stack "delivered". */
export function mailpit(env: ListmonkTestEnv) {
  return {
    async messagesTo(email: string): Promise<MailpitMessageSummary[]> {
      const res = await fetch(`${env.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
      if (!res.ok) throw new Error(`mailpit search → ${res.status}`);
      return ((await res.json()) as { messages: MailpitMessageSummary[] }).messages;
    },
    /** Polls until at least one message to `email` arrived (or the deadline passes → []). */
    async waitForMessagesTo(email: string, timeoutMs = 30_000): Promise<MailpitMessageSummary[]> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = await this.messagesTo(email);
        if (found.length > 0 || Date.now() >= deadline) return found;
        await new Promise((r) => setTimeout(r, 500));
      }
    },
    async deleteMessages(ids: string[]): Promise<void> {
      if (ids.length === 0) return;
      await fetch(`${env.mailpitUrl}/api/v1/messages`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ IDs: ids }) });
    },
  };
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
export function listmonkRaw(env: ListmonkTestEnv) {
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
    /** GET /api/campaigns/:id/preview — the campaign rendered by Listmonk (HTML, not a JSON envelope). */
    async previewCampaign(id: string): Promise<string> {
      const res = await fetch(`${env.url}/api/campaigns/${id}/preview`, { headers });
      const text = await res.text();
      if (!res.ok) throw new Error(`listmonk raw GET /api/campaigns/${id}/preview → ${res.status}: ${text}`);
      return text;
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
