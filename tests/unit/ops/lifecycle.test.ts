import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONFIG_DEFAULTS, ConfigError, loadConfig, resetConfigForTests } from '@/server/config';
import { resetLoggerForTests } from '@/server/log';
import {
  installShutdownHandlers,
  isShuttingDown,
  resetShutdownForTests,
  type ShutdownProcess,
} from '@/server/ops/lifecycle';

import { captureLogs, type CapturedLogs } from '../../helpers/logs';

// Graceful shutdown (spec/architecture.md §12.2): a fake process object stands in for `process`
// (signal registration + exit), so no real signal or exit ever happens here. The real signal path
// is proven by the boot check and the container E2E.

type Listener = (signal: NodeJS.Signals) => void;

interface FakeProcess extends ShutdownProcess {
  listeners: Map<string, Listener[]>;
  realExit: ReturnType<typeof vi.fn>;
  send(signal: NodeJS.Signals): void;
}

function fakeProcess(): FakeProcess {
  const listeners = new Map<string, Listener[]>();
  const realExit = vi.fn();
  const proc: FakeProcess = {
    listeners,
    realExit,
    on(signal: NodeJS.Signals, listener: Listener) {
      listeners.set(signal, [...(listeners.get(signal) ?? []), listener]);
      return proc;
    },
    exit: realExit as unknown as ShutdownProcess['exit'],
    send(signal) {
      for (const l of listeners.get(signal) ?? []) l(signal);
    },
  };
  return proc;
}

const BASE_ENV = {
  NODE_ENV: 'test',
  BLOG0_DATABASE_URL: 'postgres://sai@localhost:5432/blog0_dev',
  BLOG0_SESSION_SECRET: 'x'.repeat(48),
  BLOG0_OPENROUTER_API_KEY: 'sk-or-v1-test-key-not-real-000000000000',
};

describe('installShutdownHandlers', () => {
  let logs: CapturedLogs;
  let clock = 1_000;
  const now = () => clock;

  beforeEach(() => {
    vi.useFakeTimers();
    resetConfigForTests();
    resetLoggerForTests();
    resetShutdownForTests();
    logs = captureLogs();
    clock = 1_000;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true); // lines still reach captureLogs()
  });

  afterEach(() => {
    logs.stop();
    resetShutdownForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('on SIGTERM flags shutdown, logs draining, and after Next exits closes the DB and logs drained with Next\'s code', async () => {
    const proc = fakeProcess();
    const closeDb = vi.fn(async () => {});
    const nextExit = proc.exit;
    installShutdownHandlers({ timeoutMs: 8000, closeDb, now, proc });

    expect(isShuttingDown()).toBe(false);
    proc.send('SIGTERM');

    expect(isShuttingDown()).toBe(true);
    expect(logs.find('app.shutdown')).toEqual([
      expect.objectContaining({ level: 'info', signal: 'SIGTERM', phase: 'draining', timeout_ms: 8000 }),
    ]);
    // The exit was wrapped once; nothing has closed yet (Next is still draining).
    expect(proc.exit).not.toBe(nextExit);
    expect(closeDb).not.toHaveBeenCalled();

    clock = 1_450;
    proc.exit(143); // Next's own handler, after server.close() finished draining
    await vi.runAllTimersAsync();

    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(proc.realExit).toHaveBeenCalledTimes(1);
    expect(proc.realExit).toHaveBeenCalledWith(143);
    const closed = logs.find('app.shutdown').filter((l) => l.phase === 'closed');
    expect(closed).toEqual([
      expect.objectContaining({ phase: 'closed', outcome: 'drained', duration_ms: 450, exit_code: 143, signal: 'SIGTERM' }),
    ]);
  });

  it('SIGINT exits with Next\'s 130 and ignores further signals', async () => {
    const proc = fakeProcess();
    const closeDb = vi.fn(async () => {});
    installShutdownHandlers({ timeoutMs: 5000, closeDb, now, proc });

    proc.send('SIGINT');
    proc.send('SIGINT');
    proc.send('SIGTERM');
    expect(logs.find('app.shutdown').filter((l) => l.phase === 'draining')).toHaveLength(1);

    proc.exit(130);
    await vi.runAllTimersAsync();
    expect(proc.realExit).toHaveBeenCalledExactlyOnceWith(130);
    expect(closeDb).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a second install registers no further listeners', () => {
    const proc = fakeProcess();
    installShutdownHandlers({ timeoutMs: 5000, closeDb: async () => {}, now, proc });
    installShutdownHandlers({ timeoutMs: 5000, closeDb: async () => {}, now, proc });

    expect(proc.listeners.get('SIGTERM')).toHaveLength(1);
    expect(proc.listeners.get('SIGINT')).toHaveLength(1);
  });

  it('when the drain deadline passes first, logs timeout, closes the DB and exits 1', async () => {
    const proc = fakeProcess();
    const closeDb = vi.fn(async () => {});
    installShutdownHandlers({ timeoutMs: 2000, closeDb, now, proc });

    proc.send('SIGTERM');
    clock = 3_000;
    await vi.advanceTimersByTimeAsync(1999);
    expect(proc.realExit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();

    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(proc.realExit).toHaveBeenCalledExactlyOnceWith(1);
    expect(logs.find('app.shutdown').filter((l) => l.phase === 'closed')).toEqual([
      expect.objectContaining({ outcome: 'timeout', exit_code: 1, duration_ms: 2000 }),
    ]);

    // A late exit from Next after the deadline fired does not exit or log a second time.
    proc.exit(143);
    await vi.runAllTimersAsync();
    expect(proc.realExit).toHaveBeenCalledTimes(1);
    expect(logs.find('app.shutdown').filter((l) => l.phase === 'closed')).toHaveLength(1);
  });

  it('a hanging or failing DB close is capped at 3 s and never blocks the exit', async () => {
    const hanging = fakeProcess();
    installShutdownHandlers({ timeoutMs: 8000, closeDb: () => new Promise<void>(() => {}), now, proc: hanging });
    hanging.send('SIGTERM');
    hanging.exit(143);
    await vi.advanceTimersByTimeAsync(2999);
    expect(hanging.realExit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hanging.realExit).toHaveBeenCalledExactlyOnceWith(143);

    resetShutdownForTests();
    const failing = fakeProcess();
    installShutdownHandlers({ timeoutMs: 8000, closeDb: async () => Promise.reject(new Error('pool gone')), now, proc: failing });
    failing.send('SIGTERM');
    failing.exit(143);
    await vi.runAllTimersAsync();
    expect(failing.realExit).toHaveBeenCalledExactlyOnceWith(143);
    expect(logs.find('app.shutdown').filter((l) => l.outcome === 'drained').length).toBeGreaterThanOrEqual(1);
  });

  it('a plain exit before any signal is not intercepted', () => {
    const proc = fakeProcess();
    const closeDb = vi.fn(async () => {});
    installShutdownHandlers({ timeoutMs: 8000, closeDb, now, proc });

    proc.exit(1);
    expect(proc.realExit).toHaveBeenCalledExactlyOnceWith(1);
    expect(closeDb).not.toHaveBeenCalled();
    expect(isShuttingDown()).toBe(false);
  });
});

describe('BLOG0_SHUTDOWN_TIMEOUT_MS', () => {
  it('defaults to 8000 ms', () => {
    expect(CONFIG_DEFAULTS.shutdownTimeoutMs).toBe(8000);
    expect(loadConfig(BASE_ENV).shutdownTimeoutMs).toBe(8000);
  });

  it('accepts the 1000 and 120000 bounds', () => {
    expect(loadConfig({ ...BASE_ENV, BLOG0_SHUTDOWN_TIMEOUT_MS: '1000' }).shutdownTimeoutMs).toBe(1000);
    expect(loadConfig({ ...BASE_ENV, BLOG0_SHUTDOWN_TIMEOUT_MS: '120000' }).shutdownTimeoutMs).toBe(120_000);
  });

  it.each(['999', '120001', '8s', '-5'])('rejects %s', (value) => {
    expect(() => loadConfig({ ...BASE_ENV, BLOG0_SHUTDOWN_TIMEOUT_MS: value })).toThrow(ConfigError);
    expect(() => loadConfig({ ...BASE_ENV, BLOG0_SHUTDOWN_TIMEOUT_MS: value })).toThrow(
      /BLOG0_SHUTDOWN_TIMEOUT_MS must be an integer between 1000 and 120000/,
    );
  });
});
