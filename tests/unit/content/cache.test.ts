import { beforeEach, describe, expect, it } from 'vitest';

import {
  getRenderedRevision,
  RENDER_CACHE_MAX,
  RENDER_VERSION,
  renderArticle,
  renderCacheKey,
  renderCacheSize,
  resetRenderCacheForTests,
} from '@/server/content';

const input = { title: 'T', dek: 'D', bodyMd: 'A cached paragraph with enough words.' };

beforeEach(() => {
  resetRenderCacheForTests();
});

describe('render cache', () => {
  it('keys entries by revision id and RENDER_VERSION', () => {
    expect(RENDER_VERSION).toBe('r1');
    expect(renderCacheKey('rev-1')).toBe('rev-1:r1');
  });

  it('renders a revision once and returns the same result for later calls', async () => {
    const first = await getRenderedRevision('rev-1', input);

    const second = await getRenderedRevision('rev-1', { ...input, bodyMd: 'Different text that must be ignored.' });

    expect(second).toBe(first);
    expect(first).toEqual(await renderArticle(input));
    expect(renderCacheSize()).toBe(1);
  });

  it('shares one in-flight render between concurrent callers', async () => {
    const [a, b] = await Promise.all([getRenderedRevision('rev-2', input), getRenderedRevision('rev-2', input)]);

    expect(a).toBe(b);
  });

  it(`evicts the least recently used entry beyond ${RENDER_CACHE_MAX} entries`, async () => {
    await getRenderedRevision('rev-0', input);
    for (let i = 1; i < RENDER_CACHE_MAX; i++) await getRenderedRevision(`rev-${i}`, input);
    const kept = await getRenderedRevision('rev-0', input); // touch → most recent

    await getRenderedRevision('rev-new', input);

    expect(renderCacheSize()).toBe(RENDER_CACHE_MAX);
    expect(await getRenderedRevision('rev-0', input)).toBe(kept);
    const evictedAgain = await getRenderedRevision('rev-1', { ...input, bodyMd: 'Fresh render after eviction happens.' });
    expect(evictedAgain.paragraphs[0].text).toBe('Fresh render after eviction happens.');
  });

  it('does not cache a failed render', async () => {
    const bad = { title: 'T', dek: 'D', bodyMd: null as unknown as string };

    await expect(getRenderedRevision('rev-bad', bad)).rejects.toThrow();

    expect(renderCacheSize()).toBe(0);
    const ok = await getRenderedRevision('rev-bad', input);
    expect(ok.paragraphs).toHaveLength(1);
  });
});
