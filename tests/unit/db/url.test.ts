import { describe, expect, it } from 'vitest';

import { DatabaseUrlError, databaseKey, describeDatabase, isMemoryPglite, parseDatabaseUrl } from '@/server/db/url';

describe('parseDatabaseUrl (spec/architecture.md §11.1)', () => {
  it('selects server Postgres for postgres:// and postgresql://', () => {
    expect(parseDatabaseUrl('postgres://sai@localhost:5432/blog0_dev')).toEqual({ engine: 'postgres', url: 'postgres://sai@localhost:5432/blog0_dev' });
    expect(parseDatabaseUrl('postgresql://sai@localhost/blog0_dev')).toEqual({ engine: 'postgres', url: 'postgresql://sai@localhost/blog0_dev' });
  });

  it('selects embedded PGlite for pglite://<dir> (relative, absolute, memory)', () => {
    expect(parseDatabaseUrl('pglite://./var/pglite')).toEqual({ engine: 'pglite', dir: './var/pglite' });
    expect(parseDatabaseUrl('pglite:///tmp/blog0-pglite')).toEqual({ engine: 'pglite', dir: '/tmp/blog0-pglite' });
    expect(parseDatabaseUrl('pglite://memory')).toEqual({ engine: 'pglite', dir: 'memory' });
    expect(isMemoryPglite(parseDatabaseUrl('pglite://memory'))).toBe(true);
    expect(isMemoryPglite(parseDatabaseUrl('pglite://./var/pglite'))).toBe(false);
  });

  it('defaults absent, empty and comment-only values to ./var/pglite', () => {
    for (const raw of [undefined, '', '   ', '  # nothing here']) {
      expect(parseDatabaseUrl(raw)).toEqual({ engine: 'pglite', dir: './var/pglite' });
    }
  });

  it('tolerates surrounding whitespace and a trailing comment', () => {
    expect(parseDatabaseUrl('  pglite://./var/pglite   # designer')).toEqual({ engine: 'pglite', dir: './var/pglite' });
  });

  it('rejects other schemes, a postgres URL without a database and an empty pglite dir', () => {
    expect(() => parseDatabaseUrl('mysql://localhost/blog0')).toThrow(DatabaseUrlError);
    expect(() => parseDatabaseUrl('mysql://localhost/blog0')).toThrow(/must be postgres:\/\/ or pglite:\/\//);
    expect(() => parseDatabaseUrl('sqlite://./x.db')).toThrow(/must be postgres:\/\/ or pglite:\/\//);
    expect(() => parseDatabaseUrl('postgres://localhost:5432/')).toThrow(/database name/);
    expect(() => parseDatabaseUrl('pglite://')).toThrow(/must name a directory/);
  });

  it('names the variable in the message and never echoes the URL (it may hold a password)', () => {
    let message = '';
    try {
      parseDatabaseUrl('postgres://u:hunter2@localhost:5432/', 'BLOG0_TEST_DATABASE_URL');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^BLOG0_TEST_DATABASE_URL/);
    expect(message).not.toContain('hunter2');
  });
});

describe('describeDatabase / databaseKey', () => {
  it('labels pglite by dir and postgres by database name only (no credentials)', () => {
    expect(describeDatabase({ engine: 'pglite', dir: './var/pglite' })).toBe('pglite:./var/pglite');
    expect(describeDatabase({ engine: 'postgres', url: 'postgres://u:secret@localhost:5432/blog0_dev' })).toBe('blog0_dev');
  });

  it('gives each target a distinct cache key', () => {
    expect(databaseKey({ engine: 'pglite', dir: './var/pglite' })).not.toBe(databaseKey({ engine: 'pglite', dir: './var/pglite-e2e' }));
    expect(databaseKey({ engine: 'pglite', dir: 'x' })).not.toBe(databaseKey({ engine: 'postgres', url: 'x' }));
  });
});
