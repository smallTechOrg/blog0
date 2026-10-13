// The E2E server's structured log file. Locally Playwright starts `pnpm start` with
// BLOG0_LOG_FILE=test-results/e2e-server.log; against an external server (BLOG0_E2E_BASE_URL, e.g.
// the container of `pnpm test:container`) BLOG0_E2E_LOG_FILE names the host path the server writes
// (the container appends through a bind mount). Appended across runs, so callers filter by ids
// unique to their run (article id, request id) or take the latest boot line.
import { existsSync, readFileSync } from 'node:fs';

const DEFAULT_LOG_FILE = 'test-results/e2e-server.log';

/** Host path of the server log: BLOG0_E2E_LOG_FILE when set, else test-results/e2e-server.log. */
export function e2eLogFile(): string {
  return (process.env.BLOG0_E2E_LOG_FILE ?? '').trim() || DEFAULT_LOG_FILE;
}

/** True when Playwright talks to a server it did not start (BLOG0_E2E_BASE_URL). */
export function isExternalServer(): boolean {
  return (process.env.BLOG0_E2E_BASE_URL ?? '').trim() !== '';
}

export const LOG_NOT_WIRED_REASON = 'log file not wired for the external server (set BLOG0_E2E_LOG_FILE)';

/**
 * Whether the log-asserting tests must skip: only for an external server with no
 * BLOG0_E2E_LOG_FILE. When the file is wired (locally always), the tests run and a missing or
 * empty log is a failure, never a skip.
 */
export function logFileNotWired(): boolean {
  return isExternalServer() && (process.env.BLOG0_E2E_LOG_FILE ?? '').trim() === '';
}

export type ServerLogLine = Record<string, unknown> & { event?: string; request_id?: string };

export function readServerLog(file: string = e2eLogFile()): ServerLogLine[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => {
      try {
        return JSON.parse(l) as ServerLogLine;
      } catch {
        return {};
      }
    });
}

export function apiRequests(lines: ServerLogLine[], method: string, path: string): ServerLogLine[] {
  return lines.filter((l) => l.event === 'api.request' && l.method === method && l.path === path);
}
