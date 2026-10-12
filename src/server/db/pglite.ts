import 'server-only';

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { PGlite as PGliteClass } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';

import type { Db, DbHandle } from './client';
import * as schema from './schema';
import { PGLITE_MEMORY } from './url';

// Embedded PGlite engine (designer mode, spec/architecture.md §11.2; spike: spec/spikes/pglite.md).
// - The package is loaded lazily (dynamic import for scripts/tests, a runtime require for the app's
//   synchronous getDb()), so the Postgres path never loads the WASM. It is listed in
//   next.config.ts `serverExternalPackages`, so Next never bundles it.
// - PGlite is ONE backend with ONE session: `db.transaction()` holds an in-process mutex for the
//   whole callback, so a query on the outer `db` inside a transaction callback never resolves.
//   Every call inside a transaction must use `tx` (audited in S2.8).
// - There is no directory lock: two instances on one dir can corrupt it. Exactly one instance per
//   process (client.ts caches it on globalThis), and `pnpm dev:design` closes its own before it
//   starts the dev server.

type PGliteCtor = typeof PGliteClass;

/** Resolves a `pglite://<dir>` directory against the repo root (process.cwd()). */
export function resolvePgliteDir(dir: string): string {
  return path.isAbsolute(dir) ? dir : path.resolve(/* turbopackIgnore: true */ process.cwd(), dir);
}

function construct(PGlite: PGliteCtor, dir: string): PGliteClass {
  if (dir === PGLITE_MEMORY) return new PGlite();
  const absolute = resolvePgliteDir(dir);
  mkdirSync(absolute, { recursive: true });
  return new PGlite(absolute);
}

function toHandle(client: PGliteClass): DbHandle {
  const db: Db = drizzle(client, { schema });
  return {
    db,
    engine: 'pglite',
    async ping() {
      await db.execute(sql`select 1 as ok`);
    },
    async close() {
      if (!client.closed) await client.close();
    },
  };
}

/** Opens PGlite at `dir` (created if missing) — or in memory for `pglite://memory` — and waits until it is ready. Caller closes. */
export async function openPglite(dir: string): Promise<DbHandle> {
  const { PGlite } = await import('@electric-sql/pglite');
  const client = construct(PGlite, dir);
  await client.waitReady;
  return toHandle(client);
}

/**
 * Synchronous variant for the app's getDb() (its signature is synchronous). PGlite queues every
 * query until its WASM backend is ready, so the handle is usable immediately; `ready` resolves
 * once it is (instrumentation awaits it at boot). The require is resolved from the repo root at
 * runtime, so no bundler ever inlines the package.
 */
export function openPgliteSync(dir: string): DbHandle & { ready: Promise<void> } {
  const requireFromRoot = createRequire(path.join(/* turbopackIgnore: true */ process.cwd(), 'package.json'));
  const { PGlite } = requireFromRoot('@electric-sql/pglite') as { PGlite: PGliteCtor };
  const client = construct(PGlite, dir);
  const ready = client.waitReady;
  ready.catch(() => {}); // surfaced by the first query / ping instead of as an unhandled rejection
  return { ...toHandle(client), ready };
}
