import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as GET_LIVE } from '@/app/api/health/live/route';
import { GET as GET_READY } from '@/app/api/health/ready/route';
import type { Envelope } from '@/lib/api/envelope';
import type { HealthLiveDto, HealthReadyDto, NotReadyDetails } from '@/lib/api/dto';
import { APP_VERSION, resetConfigForTests } from '@/server/config';
import { getDb, resetDbForTests, rowsOf } from '@/server/db/client';
import { readJournal } from '@/server/db/migrate';
import { installShutdownHandlers, resetShutdownForTests, type ShutdownProcess } from '@/server/ops/lifecycle';

import { captureLogs, type CapturedLogs } from '../helpers/logs';

// Liveness / readiness probes (spec/api.md → health; spec/architecture.md §12.2), against the real
// test Postgres.

const ctx = { params: Promise.resolve({}) };
const liveRequest = () => new Request('http://localhost:3410/api/health/live');
const readyRequest = () => new Request('http://localhost:3410/api/health/ready');

/** Puts the process into the shutting-down state through the real signal handler (fake process object). */
function enterShutdown(): void {
  const listeners: Array<(s: NodeJS.Signals) => void> = [];
  const proc: ShutdownProcess = {
    on: (_signal, listener) => {
      listeners.push(listener);
      return proc;
    },
    exit: vi.fn() as unknown as ShutdownProcess['exit'],
  };
  installShutdownHandlers({ timeoutMs: 60_000, closeDb: async () => {}, proc });
  listeners[0]?.('SIGTERM');
}

describe('health probes', () => {
  let logs: CapturedLogs;

  beforeEach(() => {
    resetShutdownForTests();
    logs = captureLogs();
  });

  afterEach(() => {
    logs.stop();
    resetShutdownForTests();
  });

  describe('GET /api/health/live', () => {
    it('answers 200 live with version, uptime and shuttingDown=false, no-store, logged at debug', async () => {
      const response = await GET_LIVE(liveRequest(), ctx);
      const body = (await response.json()) as Envelope<HealthLiveDto>;

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(body).toEqual({
        ok: true,
        data: { status: 'live', version: APP_VERSION, uptimeSec: expect.any(Number), shuttingDown: false },
      });
      if (body.ok) expect(Number.isInteger(body.data.uptimeSec)).toBe(true);
      expect(logs.find('api.request')).toEqual([
        expect.objectContaining({ level: 'debug', path: '/api/health/live', status: 200 }),
      ]);
    });

    it('stays 200 during the shutdown drain and reports shuttingDown=true', async () => {
      enterShutdown();

      const response = await GET_LIVE(liveRequest(), ctx);
      const body = (await response.json()) as Envelope<HealthLiveDto>;

      expect(response.status).toBe(200);
      expect(body.ok && body.data.shuttingDown).toBe(true);
    });

    describe('with the database unreachable', () => {
      const realUrl = process.env.BLOG0_DATABASE_URL;
      beforeEach(async () => {
        process.env.BLOG0_DATABASE_URL = 'postgres://sai@127.0.0.1:1/blog0_unreachable';
        resetConfigForTests();
        await resetDbForTests();
      });
      afterEach(async () => {
        process.env.BLOG0_DATABASE_URL = realUrl;
        resetConfigForTests();
        await resetDbForTests();
      });

      it('still answers 200 (liveness never touches the DB)', async () => {
        const response = await GET_LIVE(liveRequest(), ctx);
        expect(response.status).toBe(200);
        expect(logs.find('error')).toHaveLength(0);
      });
    });
  });

  describe('GET /api/health/ready', () => {
    it('answers 200 ready with db latency, engine and migration status matching the journal', async () => {
      const journal = readJournal();

      const response = await GET_READY(readyRequest(), ctx);
      const body = (await response.json()) as Envelope<HealthReadyDto>;

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(body.ok).toBe(true);
      if (!body.ok) return;
      expect(body.data).toEqual({
        status: 'ready',
        db: 'ok',
        dbLatencyMs: expect.any(Number),
        dbEngine: 'postgres',
        migrations: { applied: journal.length, pending: 0, latest: journal[journal.length - 1]?.tag ?? null },
        version: APP_VERSION,
      });
      expect(body.data.dbLatencyMs).toBeGreaterThanOrEqual(0);
      expect(logs.find('api.request')).toEqual([expect.objectContaining({ level: 'debug', status: 200 })]);
    });

    it('answers 503 NOT_READY SHUTTING_DOWN once a shutdown signal arrived, logged at the normal level', async () => {
      enterShutdown();

      const response = await GET_READY(readyRequest(), ctx);
      const body = (await response.json()) as Envelope<HealthReadyDto>;

      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(body.ok).toBe(false);
      if (body.ok) return;
      expect(body.error.code).toBe('NOT_READY');
      expect(body.error.details).toEqual({ reason: 'SHUTTING_DOWN' } satisfies NotReadyDetails);
      expect(logs.find('api.request')).toEqual([
        expect.objectContaining({ level: 'info', status: 503, err_code: 'NOT_READY' }),
      ]);
    });

    it('answers 503 NOT_READY MIGRATIONS_PENDING listing the pending tag when the ledger lacks one', async () => {
      const db = getDb();
      const journal = readJournal();
      const last = journal[journal.length - 1];
      expect(last).toBeDefined();
      if (!last) return;
      const removed = rowsOf<{ id: number; hash: string; created_at: string }>(
        await db.execute(
          sql`delete from drizzle.__drizzle_migrations where created_at = ${last.when} returning id, hash, created_at::text as created_at`,
        ),
      );
      expect(removed).toHaveLength(1);
      try {
        const response = await GET_READY(readyRequest(), ctx);
        const body = (await response.json()) as Envelope<HealthReadyDto>;

        expect(response.status).toBe(503);
        expect(body.ok).toBe(false);
        if (body.ok) return;
        expect(body.error.code).toBe('NOT_READY');
        expect(body.error.details).toEqual({ reason: 'MIGRATIONS_PENDING', pending: [last.tag] });
      } finally {
        for (const row of removed) {
          await db.execute(
            sql`insert into drizzle.__drizzle_migrations (id, hash, created_at) values (${row.id}, ${row.hash}, ${Number(row.created_at)})`,
          );
        }
      }
      // Restored: ready again.
      expect((await GET_READY(readyRequest(), ctx)).status).toBe(200);
    });

    describe('with the database unreachable', () => {
      const realUrl = process.env.BLOG0_DATABASE_URL;
      beforeEach(async () => {
        process.env.BLOG0_DATABASE_URL = 'postgres://sai@127.0.0.1:1/blog0_unreachable';
        resetConfigForTests();
        await resetDbForTests();
      });
      afterEach(async () => {
        process.env.BLOG0_DATABASE_URL = realUrl;
        resetConfigForTests();
        await resetDbForTests();
      });

      it('answers 503 NOT_READY DB_UNAVAILABLE without driver text, and logs the driver error server-side', async () => {
        const response = await GET_READY(readyRequest(), ctx);
        const text = await response.text();
        const body = JSON.parse(text) as Envelope<HealthReadyDto>;

        expect(response.status).toBe(503);
        expect(body.ok).toBe(false);
        if (body.ok) return;
        expect(body.error.code).toBe('NOT_READY');
        expect(body.error.details).toEqual({ reason: 'DB_UNAVAILABLE' });
        expect(text).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|blog0_unreachable|connect |did not answer/i);
        const errors = logs.find('error');
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ err_code: 'DB_UNAVAILABLE', request_id: response.headers.get('x-request-id') });
        expect(String(errors[0]?.err_message).length).toBeGreaterThan(0);
      });
    });
  });
});
