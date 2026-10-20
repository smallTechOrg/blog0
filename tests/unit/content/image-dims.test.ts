import { describe, expect, it } from 'vitest';

import { renderArticle } from '@/server/content';
import { mediaImageSrcs } from '@/server/public/image-dims';

import { html } from './helpers';

// Stage A item 6 (spec/architecture.md §4 "Image dimensions"): the published page looks up the
// `/media/` images of the body before rendering and passes a dims map into the pure renderArticle;
// the `images` plugin adds width/height only for srcs in the map.

const KEY_A = '/media/images/2f1c0e1e-1111-4a4a-8a8a-000000000001.png';
const KEY_B = '/media/images/2f1c0e1e-1111-4a4a-8a8a-000000000002.jpg';

const BODY = [
  'A paragraph that opens the article with enough words.',
  '',
  `![Figure A](${KEY_A} "Caption A")`,
  '',
  `Inline ![b](${KEY_B}) and ![ext](https://example.com/x.png) and ![other](/media/images/unknown.png) images.`,
].join('\n');

describe('mediaImageSrcs', () => {
  it('lists the /media/ image srcs of the body once each, in document order', () => {
    expect(mediaImageSrcs(BODY + `\n\n![again](${KEY_A})`)).toEqual([KEY_A, KEY_B, '/media/images/unknown.png']);
  });

  it('ignores external images, links to media, code and an empty body', () => {
    expect(mediaImageSrcs('[a link](/media/x.png) `![no](/media/y.png)` ![e](https://cdn.example/z.png)')).toEqual([]);
    expect(mediaImageSrcs('')).toEqual([]);
  });

  it('includes reference-style image definitions', () => {
    expect(mediaImageSrcs(`![ref][r]\n\n[r]: ${KEY_A}`)).toEqual([KEY_A]);
  });
});

describe('renderArticle imageDims', () => {
  const dims = new Map([
    [KEY_A, { width: 1600, height: 900 }],
    [KEY_B, { width: 40, height: 20 }],
  ]);

  it('adds width/height to figure and inline images whose src is in the map — and to no other image', async () => {
    const out = html((await renderArticle({ title: 'T', dek: 'D', bodyMd: BODY, imageDims: dims })).blocks);

    expect(out).toMatch(new RegExp(`<img src="${KEY_A}" alt="Figure A" loading="lazy" width="1600" height="900">`));
    expect(out).toMatch(new RegExp(`<img src="${KEY_B}" alt="b" loading="lazy" class="mdimg" width="40" height="20">`));
    expect(out).toMatch(/<img src="https:\/\/example\.com\/x\.png" alt="ext" loading="lazy" class="mdimg">/);
    expect(out).toMatch(/<img src="\/media\/images\/unknown\.png" alt="other" loading="lazy" class="mdimg">/);
  });

  it('without a map no image gets dimensions, and the rest of the output is identical', async () => {
    const plain = await renderArticle({ title: 'T', dek: 'D', bodyMd: BODY });
    const withDims = await renderArticle({ title: 'T', dek: 'D', bodyMd: BODY, imageDims: dims });

    expect(html(plain.blocks)).not.toMatch(/width=|height=/);
    expect(html(withDims.blocks).replace(/ width="\d+" height="\d+"/g, '')).toBe(html(plain.blocks));
    expect(withDims.fingerprints).toEqual(plain.fingerprints);
    expect(withDims.paragraphs).toEqual(plain.paragraphs);
  });

  it('an empty map behaves like no map', async () => {
    const out = html((await renderArticle({ title: 'T', dek: 'D', bodyMd: BODY, imageDims: new Map() })).blocks);
    expect(out).not.toMatch(/width=|height=/);
  });
});
