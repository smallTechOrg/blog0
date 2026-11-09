import 'server-only';

import { HEARTBEAT_ENV, heartbeatSetting } from '../config';
import { log } from '../log';

export { heartbeatSetting } from '../config';

// Stage A heartbeats (spec/architecture.md §12.3; backup-restore.md, newsletter-issues.md): after a
// scheduled job's outcome is known, GET <url> (success) or GET <url>/fail (failure — the
// healthchecks.io convention; services without it see a harmless 404, logged `http_error`), with a
// 5 s timeout. One `ops.heartbeat` log line (info on 2xx, warn otherwise) that never contains the URL
// (it embeds the check's secret uuid). Never throws, never changes the job's exit code.

export type HeartbeatJob = 'backup' | 'newsletter_tick';
export type HeartbeatSignal = 'success' | 'fail';
type Outcome = 'ok' | 'http_error' | 'timeout' | 'network_error' | 'invalid_url';

export const HEARTBEAT_TIMEOUT_MS = 5000;

type Env = Record<string, string | undefined>;

/** The variable's URL when it is an absolute http(s) URL, else null (unset and invalid alike). */
export function heartbeatUrlFromEnv(env: Env, name: string): string | null {
  const setting = heartbeatSetting(env, name);
  return setting.kind === 'url' ? setting.url : null;
}

/**
 * Removes invalid heartbeat values from `env` (returns their names) so a script that also loads the
 * full config (`newsletter:tick`) is not failed by a bad monitoring URL — the job runs and the bad
 * value is reported once as `invalid_url` instead. Call before the first `getConfig()`.
 */
export function dropInvalidHeartbeatEnv(env: Env): string[] {
  const dropped: string[] = [];
  for (const name of Object.values(HEARTBEAT_ENV)) {
    if (heartbeatSetting(env, name).kind === 'invalid') {
      delete env[name];
      dropped.push(name);
    }
  }
  return dropped;
}

function emit(job: HeartbeatJob, signal: HeartbeatSignal, outcome: Outcome, ms: number, status?: number): void {
  const fields = { msg: `heartbeat ${signal}: ${outcome}`, job, signal, outcome, status, ms };
  if (outcome === 'ok') log.info('ops.heartbeat', fields);
  else log.warn('ops.heartbeat', fields);
}

export interface PingOptions {
  job: HeartbeatJob;
  url: string;
  signal: HeartbeatSignal;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export async function pingHeartbeat({ job, url, signal, fetch: fetchImpl = fetch, timeoutMs = HEARTBEAT_TIMEOUT_MS }: PingOptions): Promise<void> {
  const target = signal === 'success' ? url : `${url.replace(/\/+$/, '')}/fail`;
  const started = Date.now();
  try {
    const response = await fetchImpl(target, { method: 'GET', signal: AbortSignal.timeout(timeoutMs), cache: 'no-store', redirect: 'follow' });
    // Drain so the socket is released; the body is irrelevant.
    await response.arrayBuffer().catch(() => undefined);
    emit(job, signal, response.ok ? 'ok' : 'http_error', Date.now() - started, response.status);
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    emit(job, signal, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error', Date.now() - started);
  }
}

/** The scripts' entry: unset → nothing at all; invalid → one warn `invalid_url`; else ping. Never throws. */
export async function pingHeartbeatFromEnv(options: Omit<PingOptions, 'url'> & { env: Env; name: string }): Promise<void> {
  const { env, name, ...rest } = options;
  try {
    const setting = heartbeatSetting(env, name);
    if (setting.kind === 'unset') return;
    if (setting.kind === 'invalid') {
      emit(rest.job, rest.signal, 'invalid_url', 0);
      return;
    }
    await pingHeartbeat({ ...rest, url: setting.url });
  } catch {
    // never let monitoring change the job's outcome
  }
}
