import 'server-only';

import { getConfig } from '../config';
import { log } from '../log';

// Graceful shutdown (capability container-image; spec/architecture.md §12.2). Next 16's own
// SIGTERM/SIGINT handler (`next start` and the standalone server.js alike) stops accepting
// connections, waits for in-flight requests, then calls process.exit(143 | 130). Next exposes no
// post-drain callback, so on the first signal we wrap process.exit once: Next's exit first closes
// the DB pool (capped at 3 s), logs `app.shutdown` closed/drained, then exits with Next's code. An
// unref'd deadline timer (BLOG0_SHUTDOWN_TIMEOUT_MS) logs `timeout`, closes the DB and exits 1 if
// the drain takes too long. Installed by src/instrumentation.ts in production only.
//
// State lives on globalThis: instrumentation and each route are separate bundles in Next, and
// /api/health/{live,ready} must see the flag set by the signal handler.

/** The slice of `process` this module touches; tests pass a fake. */
export interface ShutdownProcess {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  exit: (code?: number) => never;
}

export interface ShutdownOptions {
  /** Drain deadline; default getConfig().shutdownTimeoutMs. */
  timeoutMs?: number;
  /** The final exit; default the process's own (unwrapped) exit. */
  exit?: (code: number) => never;
  /** Closes the app's DB handle; default db/client closeDb(). */
  closeDb?: () => Promise<void>;
  now?: () => number;
  /** Default the real `process`. */
  proc?: ShutdownProcess;
}

interface ShutdownState {
  installed: boolean;
  shuttingDown: boolean;
  /** Restores the wrapped exit (tests only). */
  restore?: () => void;
}

const KEY = Symbol.for('blog0.shutdown');
type GlobalWithShutdown = typeof globalThis & { [KEY]?: ShutdownState };

const DB_CLOSE_CAP_MS = 3000;
const SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

function state(): ShutdownState {
  const g = globalThis as GlobalWithShutdown;
  g[KEY] ??= { installed: false, shuttingDown: false };
  return g[KEY];
}

/** True from the first SIGTERM/SIGINT until the process exits (readiness answers SHUTTING_DOWN). */
export function isShuttingDown(): boolean {
  return state().shuttingDown;
}

async function defaultCloseDb(): Promise<void> {
  const { closeDb } = await import('../db/client');
  await closeDb();
}

/** closeDb() raced with a 3 s cap; failures are logged, never thrown. */
async function closeDbCapped(closeDb: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<'cap'>((resolve) => {
    timer = setTimeout(() => resolve('cap'), DB_CLOSE_CAP_MS);
  });
  try {
    const result = await Promise.race([closeDb().then(() => 'closed' as const), cap]);
    if (result === 'cap') log.warn('app.shutdown', { msg: `database pool did not close within ${DB_CLOSE_CAP_MS} ms`, phase: 'closing' });
  } catch (error) {
    log.warn('app.shutdown', {
      msg: 'database pool close failed',
      phase: 'closing',
      err_message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Registers the SIGTERM/SIGINT handlers once per process (idempotent). */
export function installShutdownHandlers(opts: ShutdownOptions = {}): void {
  const s = state();
  if (s.installed) return;
  s.installed = true;

  const proc: ShutdownProcess = opts.proc ?? (process as unknown as ShutdownProcess);
  const now = opts.now ?? Date.now;
  const closeDb = opts.closeDb ?? defaultCloseDb;
  let signalled = false;

  const onSignal = (signal: NodeJS.Signals): void => {
    if (signalled) return; // further signals are ignored (Next ignores them too)
    signalled = true;
    s.shuttingDown = true;

    const timeoutMs = opts.timeoutMs ?? getConfig().shutdownTimeoutMs;
    const started = now();
    const nextExit = proc.exit;
    const finalExit = opts.exit ?? ((code: number) => nextExit.call(proc, code));
    let finishing = false;

    log.info('app.shutdown', {
      msg: `${signal} received — draining in-flight requests (up to ${timeoutMs} ms)`,
      signal,
      phase: 'draining',
      timeout_ms: timeoutMs,
    });

    const finish = async (outcome: 'drained' | 'timeout', code: number): Promise<void> => {
      if (finishing) return;
      finishing = true;
      clearTimeout(deadline);
      await closeDbCapped(closeDb);
      log.info('app.shutdown', {
        msg: outcome === 'drained' ? `drained — exiting with ${code}` : `drain deadline of ${timeoutMs} ms hit — exiting with ${code}`,
        signal,
        phase: 'closed',
        outcome,
        duration_ms: Math.round(now() - started),
        exit_code: code,
      });
      finalExit(code);
    };

    const deadline = setTimeout(() => void finish('timeout', 1), timeoutMs);
    deadline.unref?.();

    proc.exit = ((code?: number) => {
      void finish('drained', typeof code === 'number' ? code : 0);
      return undefined as never;
    }) as ShutdownProcess['exit'];
    s.restore = () => {
      clearTimeout(deadline);
      proc.exit = nextExit;
    };
  };

  for (const signal of SIGNALS) proc.on(signal, onSignal);
}

/** Tests only: restores a wrapped exit and clears the flag. Listeners on fake processes are dropped with them. */
export function resetShutdownForTests(): void {
  const g = globalThis as GlobalWithShutdown;
  g[KEY]?.restore?.();
  g[KEY] = undefined;
}
