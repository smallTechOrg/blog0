import { describe, expect, it } from 'vitest';

import { fileFromDataUri, findEmbeddedImages, replaceEmbeddedImages } from '@/components/admin/editor/paste-images';

// A 1×1 PNG and GIF (valid base64, tiny).
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const SVG = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=';

describe('findEmbeddedImages', () => {
  it('finds an inline data image with its alt text', () => {
    const r = findEmbeddedImages(`Intro.\n\n![A bar chart](${PNG})\n\nOutro.`);

    expect(r.images).toEqual([{ uri: PNG, mime: 'image/png', alt: 'A bar chart' }]);
    expect(r.unsupported).toBe(0);
  });

  it('finds Google Docs style reference definitions (angle brackets) and the alt on their use', () => {
    const md = `Text ![Revenue by year][image1] and more ![][image2]\n\n[image1]: <${PNG}>\n[image2]: <${GIF}>\n`;

    const r = findEmbeddedImages(md);

    expect(r.images).toEqual([
      { uri: PNG, mime: 'image/png', alt: 'Revenue by year' },
      { uri: GIF, mime: 'image/gif', alt: '' },
    ]);
  });

  it('lists the same data URL once; counts formats the library refuses instead of listing them', () => {
    const r = findEmbeddedImages(`![a](${PNG}) ![b](${PNG}) ![c](${SVG})`);

    expect(r.images.map((i) => i.alt)).toEqual(['a']);
    expect(r.unsupported).toBe(1);
  });

  it('keeps escaped brackets out of the alt text and trims it to 200 characters', () => {
    const r = findEmbeddedImages(`![Q\\[1\\] ${'x'.repeat(300)}](${PNG})`);

    expect(r.images[0].alt.startsWith('Q[1] x')).toBe(true);
    expect(r.images[0].alt).toHaveLength(200);
  });

  it('copes with a full-size photo: a data URL of several hundred KB, inline and by reference', () => {
    const big = 'data:image/jpeg;base64,' + 'QUJD'.repeat(100_000); // ~400 KB of base64
    const r = findEmbeddedImages(`![Big photo](${big})\n\nText ![Other][p]\n\n[p]: <${big}2>\n`);

    expect(r.images.map((i) => [i.alt, i.uri.length > 400_000])).toEqual([['Big photo', true], ['Other', true]]);
  });

  it('finds nothing in ordinary Markdown, remote images and /media/ images', () => {
    const md = '# Title\n\n![remote](https://example.com/a.png)\n\n![ours](/media/blog0/image/2026/11/x.png)\n\nPlain text with data: in it.';

    expect(findEmbeddedImages(md)).toEqual({ images: [], unsupported: 0 });
  });
});

describe('replaceEmbeddedImages', () => {
  it('swaps every occurrence of each data URL for its address and leaves the rest alone', () => {
    const md = `![a](${PNG})\n\nBody.\n\n![a again](${PNG})\n\n[image1]: <${GIF}>`;

    const out = replaceEmbeddedImages(md, new Map([[PNG, '/media/blog0/image/2026/11/a.png'], [GIF, '/media/blog0/image/2026/11/b.gif']]));

    expect(out).toBe('![a](/media/blog0/image/2026/11/a.png)\n\nBody.\n\n![a again](/media/blog0/image/2026/11/a.png)\n\n[image1]: </media/blog0/image/2026/11/b.gif>');
    expect(out).not.toContain('base64');
  });
});

describe('fileFromDataUri', () => {
  it('decodes the bytes into a named File of the right type', async () => {
    const file = fileFromDataUri({ uri: PNG, mime: 'image/png', alt: '' }, 2)!;

    expect(file.name).toBe('pasted-image-2.png');
    expect(file.type).toBe('image/png');
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('returns null for base64 that cannot be decoded', () => {
    expect(fileFromDataUri({ uri: 'data:image/png;base64,@@@', mime: 'image/png', alt: '' }, 1)).toBeNull();
  });
});
