// Stage A heartbeats (spec/roadmap.md → Launch polish item 13; spec/architecture.md §12.3;
// backup-restore.md + newsletter-issues.md success criteria): the real `pnpm backup` and
// `pnpm newsletter:tick` scripts (tsx child processes) ping a local HTTP listener — GET <url> on
// success, GET <url>/fail on failure; a listener that never answers delays the exit by ≤ 6 s and
// never changes the exit code; the URL never appears in output; unset → no request. Needs the
// PostgreSQL 18 client tools for the successful backup (as tests/integration/backup-restore.test.ts).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { findPgTool } from '@/server/ops/pg-tools';

import { resetDb } from '../helpers/db';

const ROOT = process.cwd();
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WORK = path.join(ROOT, 'var', 'heartbeat-test');
const SECRET = 'hb-0b7f2a64-secret-check-uuid';

interface Listener {
  url: string;
  hits: string[];
  close(): Promise<void>;
}

/** `hang` → accepts the request and never answers. */
async function listen(mode: 'ok' | 'hang' = 'ok'): Promise<Listener> {
  const hits: string[] = [];
  const open = new Set<ServerResponse>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    hits.push(`${req.method} ${req.url}`);
    if (mode === 'hang') {
      open.add(res);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('OK');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/${SECRET}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of open) res.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Async (the listener lives in this process's event loop). */
function runScript(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX, `scripts/${script}.ts`, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('close', (status) => resolve({ status, stdout, stderr, ms: Date.now() - started }));
  });
}

let storage: string;
let emptyPath: string;

/** The backup child: blank heartbeat values stop @next/env from filling them in from the developer's .env. */
function backupEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    HOME: process.env.HOME ?? '',
    PATH: process.env.PATH ?? '',
    BLOG0_DATABASE_URL: process.env.BLOG0_DATABASE_URL,
    BLOG0_STORAGE_DIR: storage,
    BLOG0_LOG_LEVEL: 'info',
    BLOG0_LOG_FILE: '',
    BLOG0_HEARTBEAT_BACKUP_URL: '',
    BLOG0_HEARTBEAT_TICK_URL: '',
    ...extra,
  };
}

/** The tick child: this worker's env (blog0_test, stub sender, stub transport, .env secrets) + overrides. */
function tickEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, BLOG0_LOG_LEVEL: 'info', BLOG0_LOG_FILE: '', BLOG0_HEARTBEAT_BACKUP_URL: '', BLOG0_HEARTBEAT_TICK_URL: '', ...extra };
}

beforeAll(async () => {
  await findPgTool('pg_dump'); // fails (not skips) without the client tools — with the install hint
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  storage = mkdtempSync(path.join(WORK, 'storage-'));
  emptyPath = mkdtempSync(path.join(WORK, 'empty-path-'));
});

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDb();
});

describe('pnpm backup + BLOG0_HEARTBEAT_BACKUP_URL', () => {
  it('a successful backup sends exactly one GET <url>; the backup dir stays the last stdout line; the URL is never printed', async () => {
    const hb = await listen();
    try {
      const out = path.join(WORK, 'out-ok');
      const r = await runScript('backup', ['--', '--out', out], backupEnv({ BLOG0_HEARTBEAT_BACKUP_URL: hb.url }));
      expect(r.status, r.stderr).toBe(0);
      expect(hb.hits).toEqual([`GET /${SECRET}`]);
      const lines = r.stdout.trim().split('\n');
      expect(lines.at(-1)).toMatch(/blog0-\d{8}T\d{6}Z$/);
      expect(r.stdout).toContain('"event":"ops.heartbeat"');
      expect(r.stdout).toContain('"outcome":"ok"');
      expect(r.stdout + r.stderr).not.toContain(SECRET);
    } finally {
      await hb.close();
    }
  });

  it('a failing backup (no pg_dump on PATH) sends GET <url>/fail and still exits 1', async () => {
    const hb = await listen();
    try {
      const r = await runScript('backup', ['--', '--out', path.join(WORK, 'out-fail')], backupEnv({ PATH: emptyPath, BLOG0_HEARTBEAT_BACKUP_URL: `${hb.url}/` }));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('backup failed: pg_dump not found on PATH');
      expect(hb.hits).toEqual([`GET /${SECRET}/fail`]);
      expect(r.stdout + r.stderr).not.toContain(SECRET);
    } finally {
      await hb.close();
    }
  });

  it('a listener that never answers delays the exit by ≤ 6 s and leaves the exit code unchanged', async () => {
    const baseline = await runScript('backup', ['--', '--out', path.join(WORK, 'out-base')], backupEnv({ PATH: emptyPath }));
    const hb = await listen('hang');
    try {
      const r = await runScript('backup', ['--', '--out', path.join(WORK, 'out-hang')], backupEnv({ PATH: emptyPath, BLOG0_HEARTBEAT_BACKUP_URL: hb.url }));
      expect(baseline.status).toBe(1);
      expect(r.status).toBe(1);
      expect(hb.hits).toEqual([`GET /${SECRET}/fail`]);
      expect(r.ms - baseline.ms).toBeLessThanOrEqual(6000);
      expect(r.ms - baseline.ms).toBeGreaterThanOrEqual(4000);
      expect(r.stdout).toContain('"outcome":"timeout"');
    } finally {
      await hb.close();
    }
  });

  it('unset → no request and no ops.heartbeat line; invalid → one warn invalid_url, exit code unaffected; usage error (exit 2) → no ping', async () => {
    const hb = await listen();
    try {
      const unset = await runScript('backup', ['--', '--out', path.join(WORK, 'out-unset')], backupEnv({ PATH: emptyPath }));
      expect(unset.status).toBe(1);
      expect(unset.stdout).not.toContain('ops.heartbeat');

      const invalid = await runScript('backup', ['--', '--out', path.join(WORK, 'out-invalid')], backupEnv({ PATH: emptyPath, BLOG0_HEARTBEAT_BACKUP_URL: `not-a-url-${SECRET}` }));
      expect(invalid.status).toBe(1);
      expect(invalid.stdout).toContain('"outcome":"invalid_url"');
      expect(invalid.stdout + invalid.stderr).not.toContain(SECRET);

      const usage = await runScript('backup', ['--', '--bogus'], backupEnv({ BLOG0_HEARTBEAT_BACKUP_URL: hb.url }));
      expect(usage.status).toBe(2);
      expect(hb.hits).toEqual([]);
    } finally {
      await hb.close();
    }
  });
});

describe('pnpm newsletter:tick + BLOG0_HEARTBEAT_TICK_URL', () => {
  it('a successful tick sends exactly one GET <url>; an invalid backup URL in the same env does not break the tick', async () => {
    const hb = await listen();
    try {
      const r = await runScript('newsletter-tick', [], tickEnv({ BLOG0_HEARTBEAT_TICK_URL: hb.url, BLOG0_HEARTBEAT_BACKUP_URL: 'nope' }));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('digest: not due;');
      expect(hb.hits).toEqual([`GET /${SECRET}`]);
      expect(r.stdout + r.stderr).not.toContain(SECRET);
    } finally {
      await hb.close();
    }
  });

  it('a failing tick (database unreachable) sends GET <url>/fail and exits 1; unset → no request; invalid → invalid_url, exit 0', async () => {
    const hb = await listen();
    try {
      const failed = await runScript('newsletter-tick', [], tickEnv({ BLOG0_HEARTBEAT_TICK_URL: hb.url, BLOG0_DATABASE_URL: 'postgres://sai@127.0.0.1:1/blog0_nowhere' }));
      expect(failed.status).toBe(1);
      expect(hb.hits).toEqual([`GET /${SECRET}/fail`]);

      const unset = await runScript('newsletter-tick', [], tickEnv({}));
      expect(unset.status, unset.stderr).toBe(0);
      expect(unset.stdout).not.toContain('ops.heartbeat');

      const invalid = await runScript('newsletter-tick', [], tickEnv({ BLOG0_HEARTBEAT_TICK_URL: `ftp://x/${SECRET}` }));
      expect(invalid.status, invalid.stderr).toBe(0);
      expect(invalid.stdout).toContain('"outcome":"invalid_url"');
      expect(invalid.stdout + invalid.stderr).not.toContain(SECRET);

      const usage = await runScript('newsletter-tick', ['--bogus'], tickEnv({ BLOG0_HEARTBEAT_TICK_URL: hb.url }));
      expect(usage.status).toBe(2);
      expect(hb.hits).toHaveLength(1);
    } finally {
      await hb.close();
    }
  });
});
