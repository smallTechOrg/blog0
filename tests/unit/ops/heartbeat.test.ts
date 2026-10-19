import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetConfigForTests } from '@/server/config';
import { resetLoggerForTests } from '@/server/log';
import { dropInvalidHeartbeatEnv, heartbeatSetting, heartbeatUrlFromEnv, pingHeartbeat, pingHeartbeatFromEnv } from '@/server/ops/heartbeat';

import { captureLogs, type CapturedLogs } from '../../helpers/logs';

// Stage A heartbeats (spec/architecture.md §12.3): GET <url> on success, GET <url>/fail on failure,
// 5 s timeout, one `ops.heartbeat` line without the URL, never throws. The real scripts are proven
// against a local HTTP listener in tests/integration/heartbeat.test.ts.

const URL_OK = 'https://hc-ping.com/0b7f2a64-secret-uuid';

type FetchCall = { url: string; init?: RequestInit };

function fakeFetch(respond: (url: string) => Promise<Response> | Response): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return respond(url);
  }) as typeof fetch;
  return { fetch: f, calls };
}

let logs: CapturedLogs;
beforeEach(() => {
  resetConfigForTests();
  resetLoggerForTests();
  logs = captureLogs();
});
afterEach(() => logs.stop());

describe('heartbeatUrlFromEnv / heartbeatSetting', () => {
  it('absolute http(s) → the URL (trimmed); unset/empty → null; anything else → invalid', () => {
    expect(heartbeatUrlFromEnv({ X: `  ${URL_OK}  ` }, 'X')).toBe(URL_OK);
    expect(heartbeatUrlFromEnv({ X: 'http://127.0.0.1:9/hb' }, 'X')).toBe('http://127.0.0.1:9/hb');
    expect(heartbeatUrlFromEnv({}, 'X')).toBeNull();
    expect(heartbeatUrlFromEnv({ X: '   ' }, 'X')).toBeNull();
    expect(heartbeatUrlFromEnv({ X: 'hc-ping.com/abc' }, 'X')).toBeNull();
    expect(heartbeatSetting({}, 'X')).toEqual({ kind: 'unset' });
    expect(heartbeatSetting({ X: 'ftp://x.example/hb' }, 'X')).toEqual({ kind: 'invalid' });
    expect(heartbeatSetting({ X: 'not a url' }, 'X')).toEqual({ kind: 'invalid' });
    expect(heartbeatSetting({ X: URL_OK }, 'X')).toEqual({ kind: 'url', url: URL_OK });
  });

  it('dropInvalidHeartbeatEnv removes only invalid heartbeat values (so a script\'s config still loads) and names them', () => {
    const env: Record<string, string | undefined> = { BLOG0_HEARTBEAT_BACKUP_URL: 'nope', BLOG0_HEARTBEAT_TICK_URL: URL_OK };
    expect(dropInvalidHeartbeatEnv(env)).toEqual(['BLOG0_HEARTBEAT_BACKUP_URL']);
    expect(env).toEqual({ BLOG0_HEARTBEAT_TICK_URL: URL_OK });
  });
});

describe('pingHeartbeat', () => {
  it('success → one GET <url>; logs info ok with the status and never the URL', async () => {
    const { fetch, calls } = fakeFetch(() => new Response('OK', { status: 200 }));
    await pingHeartbeat({ job: 'backup', url: URL_OK, signal: 'success', fetch });

    expect(calls.map((c) => [c.url, c.init?.method ?? 'GET'])).toEqual([[URL_OK, 'GET']]);
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    const [line] = logs.find('ops.heartbeat');
    expect(line).toMatchObject({ level: 'info', job: 'backup', signal: 'success', outcome: 'ok', status: 200 });
    expect(typeof line?.ms).toBe('number');
    expect(JSON.stringify(logs.lines)).not.toContain('secret-uuid');
  });

  it('failure → GET <url>/fail (a trailing slash is not doubled)', async () => {
    const { fetch, calls } = fakeFetch(() => new Response('', { status: 200 }));
    await pingHeartbeat({ job: 'newsletter_tick', url: `${URL_OK}/`, signal: 'fail', fetch });
    expect(calls.map((c) => c.url)).toEqual([`${URL_OK}/fail`]);
    expect(logs.find('ops.heartbeat')[0]).toMatchObject({ job: 'newsletter_tick', signal: 'fail', outcome: 'ok' });
  });

  it('a non-2xx answer → warn http_error; a network error → warn network_error; never throws', async () => {
    await pingHeartbeat({ job: 'backup', url: URL_OK, signal: 'success', fetch: fakeFetch(() => new Response('', { status: 404 })).fetch });
    await pingHeartbeat({
      job: 'backup',
      url: URL_OK,
      signal: 'success',
      fetch: fakeFetch(() => {
        throw new TypeError(`fetch failed: connect ECONNREFUSED ${URL_OK}`);
      }).fetch,
    });
    const lines = logs.find('ops.heartbeat');
    expect(lines.map((l) => [l.level, l.outcome, l.status])).toEqual([
      ['warn', 'http_error', 404],
      ['warn', 'network_error', undefined],
    ]);
    expect(JSON.stringify(logs.lines)).not.toContain('secret-uuid');
  });

  it('a listener that never answers → timeout after timeoutMs (warn timeout), resolved not thrown', async () => {
    const never = (async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const started = Date.now();
    await pingHeartbeat({ job: 'backup', url: URL_OK, signal: 'fail', fetch: never, timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(logs.find('ops.heartbeat')[0]).toMatchObject({ level: 'warn', outcome: 'timeout', signal: 'fail' });
  });
});

describe('pingHeartbeatFromEnv', () => {
  it('unset → no request and no log line', async () => {
    const { fetch, calls } = fakeFetch(() => new Response('', { status: 200 }));
    await pingHeartbeatFromEnv({ job: 'backup', env: {}, name: 'BLOG0_HEARTBEAT_BACKUP_URL', signal: 'success', fetch });
    expect(calls).toHaveLength(0);
    expect(logs.find('ops.heartbeat')).toHaveLength(0);
  });

  it('invalid → no request, one warn invalid_url (the value is not logged)', async () => {
    const { fetch, calls } = fakeFetch(() => new Response('', { status: 200 }));
    await pingHeartbeatFromEnv({ job: 'newsletter_tick', env: { BLOG0_HEARTBEAT_TICK_URL: 'secret-but-not-a-url' }, name: 'BLOG0_HEARTBEAT_TICK_URL', signal: 'success', fetch });
    expect(calls).toHaveLength(0);
    expect(logs.find('ops.heartbeat')).toEqual([expect.objectContaining({ level: 'warn', outcome: 'invalid_url', job: 'newsletter_tick', signal: 'success' })]);
    expect(JSON.stringify(logs.lines)).not.toContain('secret-but-not-a-url');
  });

  it('valid → pings', async () => {
    const { fetch, calls } = fakeFetch(() => new Response('', { status: 200 }));
    await pingHeartbeatFromEnv({ job: 'backup', env: { BLOG0_HEARTBEAT_BACKUP_URL: URL_OK }, name: 'BLOG0_HEARTBEAT_BACKUP_URL', signal: 'fail', fetch });
    expect(calls.map((c) => c.url)).toEqual([`${URL_OK}/fail`]);
  });
});
