import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SiteRow } from '@/server/db/schema';

// getCurrentSite's cache must never re-store a row read before invalidateCurrentSite() (a read that
// started before a site save would otherwise put the pre-save row back for SITE_CACHE_MS).

const selects: Array<(rows: SiteRow[]) => void> = [];

vi.mock('@/server/config', () => ({ getConfig: () => ({ siteSlug: 'blog0' }) }));
vi.mock('@/server/db/client', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => new Promise<SiteRow[]>((resolve) => selects.push(resolve)),
        }),
      }),
    }),
  }),
}));

const { getCurrentSite, invalidateCurrentSite, resetCurrentSiteForTests } = await import('@/server/site/current');

function row(about: string): SiteRow {
  return { slug: 'blog0', about } as unknown as SiteRow;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  selects.length = 0;
  resetCurrentSiteForTests();
});

afterEach(() => resetCurrentSiteForTests());

describe('getCurrentSite cache', () => {
  it('caches a completed read', async () => {
    const first = getCurrentSite(1000);
    await flush();
    selects.shift()!([row('v1')]);
    expect(await first).toEqual(row('v1'));

    expect(await getCurrentSite(2000)).toEqual(row('v1'));
    expect(selects).toHaveLength(0);
  });

  it('does not re-store a row whose read started before invalidateCurrentSite()', async () => {
    const stale = getCurrentSite(1000); // read starts before the save…
    await flush();
    invalidateCurrentSite(); // …the save commits and invalidates…
    selects.shift()!([row('old')]); // …then the stale SELECT resolves.
    expect(await stale).toEqual(row('old')); // the caller still gets its answer

    const fresh = getCurrentSite(1001);
    await flush();
    expect(selects).toHaveLength(1); // not served from cache: a new SELECT ran
    selects.shift()!([row('new')]);
    expect(await fresh).toEqual(row('new'));

    expect(await getCurrentSite(1002)).toEqual(row('new'));
    expect(selects).toHaveLength(0);
  });

  it('still throws SiteNotFoundError when the row is missing', async () => {
    const missing = getCurrentSite(1000);
    await flush();
    selects.shift()!([]);
    await expect(missing).rejects.toThrow(/Site 'blog0' not found/);
  });
});
