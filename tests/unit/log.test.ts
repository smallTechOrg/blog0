import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetConfigForTests } from '@/server/config';
import { log, maskEmail, resetLoggerForTests } from '@/server/log';

import { captureLogs } from '../helpers/logs';

describe('log', () => {
  let dir: string;
  const saved = { file: process.env.BLOG0_LOG_FILE, level: process.env.BLOG0_LOG_LEVEL };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'blog0-log-'));
    resetConfigForTests();
    resetLoggerForTests();
  });

  afterEach(() => {
    process.env.BLOG0_LOG_FILE = saved.file;
    process.env.BLOG0_LOG_LEVEL = saved.level;
    if (saved.file === undefined) delete process.env.BLOG0_LOG_FILE;
    if (saved.level === undefined) delete process.env.BLOG0_LOG_LEVEL;
    resetConfigForTests();
    resetLoggerForTests();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes one JSON object per line with ts, level, event, msg and context to stdout and the log file', () => {
    const file = path.join(dir, 'nested', 'server.log');
    process.env.BLOG0_LOG_FILE = file;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    log.info('api.request', { msg: 'GET /api/health 200', status: 200, request_id: 'req-12345678' });

    const written = String(stdout.mock.calls[0]?.[0]);
    const fromStdout = JSON.parse(written);
    const fromFile = JSON.parse(readFileSync(file, 'utf8').trim());
    for (const line of [fromStdout, fromFile]) {
      expect(line).toMatchObject({ level: 'info', event: 'api.request', msg: 'GET /api/health 200', status: 200 });
      expect(new Date(line.ts).toISOString()).toBe(line.ts);
    }
    expect(written.endsWith('\n')).toBe(true);
  });

  it('drops lines below BLOG0_LOG_LEVEL from stdout but still hands them to test sinks', () => {
    process.env.BLOG0_LOG_LEVEL = 'warn';
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logs = captureLogs();

    log.info('quiet.event');
    log.error('loud.event', { err_message: 'boom' });
    logs.stop();

    expect(stdout).toHaveBeenCalledTimes(1);
    expect(String(stdout.mock.calls[0]?.[0])).toContain('loud.event');
    expect(logs.lines.map((l) => l.event)).toEqual(['quiet.event', 'loud.event']);
    expect(logs.find('loud.event')[0]?.msg).toBe('loud.event');
  });

  it('serialises Error values without stack traces and omits undefined fields', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logs = captureLogs();

    log.warn('thing.failed', { cause: new Error('nope'), user_id: undefined });
    logs.stop();

    expect(logs.lines[0]).toMatchObject({ cause: { name: 'Error', message: 'nope' } });
    expect(logs.lines[0]).not.toHaveProperty('user_id');
  });

  it('masks emails down to the first character and the domain', () => {
    expect(maskEmail('sai@smalltech.in')).toBe('s***@smalltech.in');
    expect(maskEmail('not-an-email')).toBe('***');
  });
});
