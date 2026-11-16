import { describe, expect, it } from 'vitest';

import { articleMetadata, feedAlternateTypes, sitePageMetadata, siteDefaultMetadata } from '@/server/public/metadata';
import type { ArticleViewModel } from '@/lib/view-models';

// Feed discovery (spec/capabilities/reader-site.md "Feed discovery"): every metadata helper sets the
// RSS `alternates.types` beside its own canonical, because Next merges `alternates` shallowly.

const RSS = { 'application/rss+xml': [{ url: '/feed.xml', title: 'blog0' }] };

describe('RSS discovery link in page metadata', () => {
  it('feedAlternateTypes points at /feed.xml titled with the wordmark', () => {
    expect(feedAlternateTypes('blog0')).toEqual(RSS);
  });

  it('article pages keep their canonical and carry the feed link', () => {
    const a = { title: 'T', dek: 'D', topic: '', bylineName: 'B', articleUrl: 'https://x.example/p/t', deck: null } as unknown as ArticleViewModel;
    const m = articleMetadata(a, { wordmark: 'blog0', mode: 'read', publishedAt: new Date(0) });
    expect(m.alternates).toEqual({ canonical: 'https://x.example/p/t', types: RSS });
  });

  it('site pages carry it with or without a canonical, and so do the layout defaults', () => {
    expect(sitePageMetadata({ title: 'blog0', url: 'https://x.example/', siteName: 'blog0' }).alternates).toEqual({ canonical: 'https://x.example/', types: RSS });
    expect(sitePageMetadata({ title: 'Not found', siteName: 'blog0' }).alternates).toEqual({ types: RSS });
    expect(siteDefaultMetadata('blog0').alternates).toEqual({ types: RSS });
  });
});
