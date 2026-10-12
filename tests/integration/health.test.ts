import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET } from '@/app/api/health/route';
import type { Envelope } from '@/lib/api/envelope';
import type { HealthDto } from '@/lib/api/dto';
import { APP_VERSION, resetConfigForTests } from '@/server/config';
import { resetDbForTests } from '@/server/db/client';

import { resetDb } from '../helpers/db';
import { captureLogs, type CapturedLogs } from '../helpers/logs';

const ctx = { params: Promise.resolve({}) };

describe('GET /api/health', () => {
  let logs: CapturedLogs;

  beforeEach(async () => {
    await resetDb();
    logs = captureLogs();
  });

  afterEach(() => {
    logs.stop();
  });

  it('reports the database as reachable with latency, version and uptime', async () => {
    const request = new Request('http://localhost:3410/api/health');

    const response = await GET(request, ctx);
    const body = (await response.json()) as Envelope<HealthDto>;

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(body.data.status).toBe('ok');
    expect(body.data.db).toBe('ok');
    expect(body.data.version).toBe(APP_VERSION);
    expect(body.data.version).toBe('0.1.0');
    expect(Number.isInteger(body.data.dbLatencyMs)).toBe(true);
    expect(body.data.dbLatencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.data.uptimeSec)).toBe(true);
  });

  it('emits exactly one api.request log line carrying the response request id', async () => {
    const request = new Request('http://localhost:3410/api/health');

    const response = await GET(request, ctx);

    const requestId = response.headers.get('x-request-id');
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    const lines = logs.find('api.request');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      request_id: requestId,
      method: 'GET',
      path: '/api/health',
      status: 200,
    });
    expect(typeof lines[0]?.latency_ms).toBe('number');
  });

  it('keeps a well-formed incoming x-request-id and replaces a malformed one', async () => {
    const good = new Request('http://localhost:3410/api/health', { headers: { 'x-request-id': 'trace-abc-12345' } });
    const bad = new Request('http://localhost:3410/api/health', { headers: { 'x-request-id': 'bad id <script>' } });

    const goodResponse = await GET(good, ctx);
    const badResponse = await GET(bad, ctx);

    expect(goodResponse.headers.get('x-request-id')).toBe('trace-abc-12345');
    expect(badResponse.headers.get('x-request-id')).not.toBe('bad id <script>');
    expect(badResponse.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  describe('when the database is unreachable', () => {
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

    it('answers 503 DB_UNAVAILABLE in the error envelope with the request id', async () => {
      const request = new Request('http://localhost:3410/api/health');

      const response = await GET(request, ctx);
      const body = (await response.json()) as Envelope<HealthDto>;

      expect(response.status).toBe(503);
      expect(body.ok).toBe(false);
      if (body.ok) return;
      expect(body.error.code).toBe('DB_UNAVAILABLE');
      expect(body.error.message).toMatch(/BLOG0_DATABASE_URL/);
      expect(body.error.requestId).toBe(response.headers.get('x-request-id'));
      expect(logs.find('api.request')[0]).toMatchObject({ status: 503, err_code: 'DB_UNAVAILABLE' });
    });

    it('never leaks the driver error to the client and logs it server-side instead', async () => {
      const request = new Request('http://localhost:3410/api/health');

      const response = await GET(request, ctx);
      const text = await response.text();
      const body = JSON.parse(text) as Envelope<HealthDto>;

      expect(response.status).toBe(503);
      expect(body.ok).toBe(false);
      if (body.ok) return;
      expect(body.error).not.toHaveProperty('details');
      expect(text).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|blog0_unreachable|connect |did not answer/i);
      const errorLines = logs.find('error');
      expect(errorLines).toHaveLength(1);
      expect(errorLines[0]).toMatchObject({
        level: 'error',
        request_id: response.headers.get('x-request-id'),
        err_code: 'DB_UNAVAILABLE',
      });
      expect(typeof errorLines[0]?.err_message).toBe('string');
      expect(String(errorLines[0]?.err_message).length).toBeGreaterThan(0);
    });
  });
});
