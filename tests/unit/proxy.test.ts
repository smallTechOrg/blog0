import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ARTICLE_NOT_FOUND_PATH, config, errorCode, proxy, slugFromArticlePath } from '@/proxy';
import { addLogSink, resetLoggerForTests, type LogLine } from '@/server/log';
import { publishedSlugExists } from '@/server/public/articles';

vi.mock('@/server/public/articles', () => ({ publishedSlugExists: vi.fn() }));

const exists = vi.mocked(publishedSlugExists);

afterEach(() => {
  exists.mockReset();
  resetLoggerForTests();
});

describe('slugFromArticlePath', () => {
  it('extracts the slug from /p/<slug>', () => {
    expect(slugFromArticlePath('/p/measure-the-work')).toBe('measure-the-work');
  });

  it('extracts the slug from the /tldr share path', () => {
    expect(slugFromArticlePath('/p/measure-the-work/tldr')).toBe('measure-the-work');
  });

  it('extracts the slug from the /listen share path', () => {
    expect(slugFromArticlePath('/p/measure-the-work/listen')).toBe('measure-the-work');
    expect(slugFromArticlePath('/p/measure-the-work/listen/')).toBe('measure-the-work');
    expect(slugFromArticlePath('/p/a/listen/extra')).toBeNull();
  });

  it('accepts a trailing slash on both shapes', () => {
    expect(slugFromArticlePath('/p/measure-the-work/')).toBe('measure-the-work');
    expect(slugFromArticlePath('/p/measure-the-work/tldr/')).toBe('measure-the-work');
  });

  it('percent-decodes the slug, and keeps the raw segment when the encoding is malformed', () => {
    expect(slugFromArticlePath('/p/caf%C3%A9')).toBe('café');
    expect(slugFromArticlePath('/p/bad%E0%A4%A')).toBe('bad%E0%A4%A');
    expect(slugFromArticlePath('/p/%')).toBe('%');
  });

  it('returns null for nested or non-article paths', () => {
    expect(slugFromArticlePath('/p/a/b')).toBeNull();
    expect(slugFromArticlePath('/p/a/tldr/extra')).toBeNull();
    expect(slugFromArticlePath('/p/')).toBeNull();
    expect(slugFromArticlePath('/p')).toBeNull();
    expect(slugFromArticlePath('/archive')).toBeNull();
    expect(slugFromArticlePath('/x/p/slug')).toBeNull();
  });

  it('returns uppercase slugs unchanged (the published-only query then rejects them)', () => {
    expect(slugFromArticlePath('/p/Measure-The-Work')).toBe('Measure-The-Work');
    expect(slugFromArticlePath('/p/ABC/tldr')).toBe('ABC');
  });
});

describe('proxy config', () => {
  it('matches only the article, TLDR and Listen share routes', () => {
    expect(config.matcher).toEqual(['/p/:slug', '/p/:slug/tldr', '/p/:slug/listen']);
  });

  it('rewrites to an internal path no route matches', () => {
    expect(ARTICLE_NOT_FOUND_PATH.startsWith('/_')).toBe(true);
  });
});

describe('errorCode (proxy failure log field)', () => {
  it('uses the driver code when it is a short identifier', () => {
    expect(errorCode(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED');
    expect(errorCode({ code: '28P01' })).toBe('28P01');
  });

  it('falls back to the error class name, never the message text', () => {
    const err = new TypeError('password authentication failed for user "sai" at postgres://sai:secret@db');
    expect(errorCode(err)).toBe('TypeError');
    expect(errorCode(Object.assign(new Error('x'), { code: 'postgres://sai:secret@db:5432/blog0' }))).toBe('Error');
  });

  it('returns "unknown" for non-errors', () => {
    expect(errorCode('boom')).toBe('unknown');
    expect(errorCode(null)).toBe('unknown');
  });
});

describe('proxy', () => {
  it('passes a published slug through untouched', async () => {
    exists.mockResolvedValue(true);
    const res = await proxy(new NextRequest('http://localhost:3410/p/live-piece'));

    expect(exists).toHaveBeenCalledWith('live-piece');
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('rewrites an unknown slug to the internal not-found path', async () => {
    exists.mockResolvedValue(false);
    const res = await proxy(new NextRequest('http://localhost:3410/p/nope/tldr'));

    expect(res.headers.get('x-middleware-rewrite')).toBe(`http://localhost:3410${ARTICLE_NOT_FOUND_PATH}`);
  });

  it('logs a warning without the slug or error text and falls through when the DB check throws', async () => {
    const lines: LogLine[] = [];
    addLogSink((l) => lines.push(l));
    exists.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED postgres://sai:secret@db:5432'), { code: 'ECONNREFUSED' }));

    const res = await proxy(new NextRequest('http://localhost:3410/p/secret-draft-slug/tldr'));

    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    const warn = lines.find((l) => l.event === 'proxy.slug_check_failed');
    expect(warn).toMatchObject({ level: 'warn', path: '/p/:slug/tldr', err_code: 'ECONNREFUSED' });
    const text = JSON.stringify(lines);
    expect(text).not.toContain('secret-draft-slug');
    expect(text).not.toContain('ECONNREFUSED postgres');
    expect(text).not.toContain('secret@db');
  });
});
