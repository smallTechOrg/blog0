import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  articleJsonLd,
  homeJsonLd,
  LOGO_PATH,
  OG_IMAGE,
  ogImageMetadata,
  serializeJsonLd,
  twitterMetadata,
} from '@/server/public/seo';

// Stage A items 2 + 5 (spec/ui.md §3 "head and share metadata"; spec/architecture.md §6): pure
// JSON-LD builders, the `</script>`-safe serializer, and the committed share/icon assets.

const PUBLIC = path.join(process.cwd(), 'public');

function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(path.join(PUBLIC, file));
  expect(buf.subarray(0, 8).toString('hex'), `${file} PNG signature`).toBe('89504e470d0a1a0a');
  expect(buf.subarray(12, 16).toString('ascii'), `${file} IHDR`).toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('serializeJsonLd', () => {
  it('round-trips through JSON.parse', () => {
    const obj = { '@type': 'Article', headline: 'A & B <c> "d"', n: 3 };
    expect(JSON.parse(serializeJsonLd(obj))).toEqual(obj);
  });

  it('can never close the script element or open a comment, whatever author text holds', () => {
    const evil = { headline: '</script><script>alert(1)</script><!-- & \u2028\u2029' };
    const out = serializeJsonLd(evil);
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(out).toContain('\\u003c/script\\u003e');
    expect(out).toContain('\\u0026');
    expect(out).toContain('\\u2028');
    expect(out).toContain('\\u2029');
    expect(JSON.parse(out)).toEqual(evil);
  });
});

describe('homeJsonLd', () => {
  it('is one @graph with the Organization (logo, sameAs) and the WebSite', () => {
    const ld = homeJsonLd({ brand: 'blog0', baseUrl: 'https://blog0.example', sameAs: ['https://x.com/blog0'] });
    expect(ld).toEqual({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Organization',
          name: 'blog0',
          url: 'https://blog0.example/',
          logo: 'https://blog0.example/logo.png',
          sameAs: ['https://x.com/blog0'],
        },
        { '@type': 'WebSite', name: 'blog0', url: 'https://blog0.example/' },
      ],
    });
  });

  it('omits sameAs when the site has no social URLs', () => {
    const ld = homeJsonLd({ brand: 'blog0', baseUrl: 'http://localhost:3410', sameAs: [] }) as { '@graph': Array<Record<string, unknown>> };
    expect(ld['@graph'][0]).not.toHaveProperty('sameAs');
  });
});

describe('articleJsonLd', () => {
  const base = {
    brand: 'blog0',
    baseUrl: 'https://blog0.example',
    sameAs: [],
    slug: 'humans-are-software',
    title: 'Humans are Software',
    dek: 'The dek.',
    authorName: 'Sai',
    firstPublishedAt: new Date('2026-09-01T10:00:00Z'),
  };

  it('describes the Article with absolute canonical, image and publisher logo', () => {
    const ld = articleJsonLd({ ...base, contentUpdatedAt: new Date('2026-09-05T10:00:00Z') });
    expect(ld).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: 'Humans are Software',
      description: 'The dek.',
      datePublished: '2026-09-01T10:00:00.000Z',
      dateModified: '2026-09-05T10:00:00.000Z',
      author: { '@type': 'Person', name: 'Sai' },
      publisher: { '@type': 'Organization', name: 'blog0', url: 'https://blog0.example/', logo: 'https://blog0.example/logo.png' },
      url: 'https://blog0.example/p/humans-are-software',
      mainEntityOfPage: 'https://blog0.example/p/humans-are-software',
      image: 'https://blog0.example/og-default.png',
    });
  });

  it('falls back to the first publish date when the content never changed, and drops an empty dek', () => {
    const ld = articleJsonLd({ ...base, dek: '', contentUpdatedAt: null }) as Record<string, unknown>;
    expect(ld.dateModified).toBe('2026-09-01T10:00:00.000Z');
    expect(ld).not.toHaveProperty('description');
  });
});

describe('share metadata', () => {
  it('uses the default 1200×630 image on every page and the large Twitter card', () => {
    expect(ogImageMetadata('blog0')).toEqual([{ url: '/og-default.png', width: 1200, height: 630, alt: 'blog0' }]);
    expect(twitterMetadata({ title: 'T', description: 'D' })).toEqual({
      card: 'summary_large_image',
      title: 'T',
      description: 'D',
      images: ['/og-default.png'],
    });
  });
});

describe('committed assets (public/)', () => {
  it('og-default.png is a 1200×630 PNG under 60 KB', () => {
    expect(pngSize('og-default.png')).toEqual({ width: OG_IMAGE.width, height: OG_IMAGE.height });
    expect(OG_IMAGE).toEqual({ path: '/og-default.png', width: 1200, height: 630 });
    expect(statSync(path.join(PUBLIC, 'og-default.png')).size).toBeLessThan(60 * 1024);
  });

  it('logo.png is 512×512 and favicon-32.png is 32×32', () => {
    expect(LOGO_PATH).toBe('/logo.png');
    expect(pngSize('logo.png')).toEqual({ width: 512, height: 512 });
    expect(pngSize('favicon-32.png')).toEqual({ width: 32, height: 32 });
  });

  it('favicon.ico carries a 16 px and a 32 px image', () => {
    const ico = readFileSync(path.join(PUBLIC, 'favicon.ico'));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, i) => ico.readUInt8(6 + i * 16)).sort((a, b) => a - b);
    expect(sizes).toEqual([16, 32]);
  });

  it('favicon.svg is an SVG document', () => {
    const svg = readFileSync(path.join(PUBLIC, 'favicon.svg'), 'utf8');
    expect(svg).toMatch(/^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });
});
