// The E2E server's structured log file (BLOG0_LOG_FILE in playwright.config.ts). Appended across
// runs, so callers filter by ids unique to their run (article id, request id).
import { existsSync, readFileSync } from 'node:fs';

export const E2E_LOG_FILE = 'test-results/e2e-server.log';

export type ServerLogLine = Record<string, unknown> & { event?: string; request_id?: string };

export function readServerLog(file: string = E2E_LOG_FILE): ServerLogLine[] {
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
