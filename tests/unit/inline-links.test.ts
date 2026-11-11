import { describe, expect, it } from 'vitest';

import { parseInlineLinks, plainInline } from '@/lib/inline-links';

describe('parseInlineLinks', () => {
  it('splits text around an http(s) link, keeping the order', () => {
    expect(parseInlineLinks('the official publication of [smallTech](https://smalltech.in), a company')).toEqual([
      { text: 'the official publication of ' },
      { text: 'smallTech', href: 'https://smalltech.in' },
      { text: ', a company' },
    ]);
  });

  it('handles several links, a link at either end, and no link at all', () => {
    expect(parseInlineLinks('[a](http://x.test/a)[b](https://x.test/b)')).toEqual([
      { text: 'a', href: 'http://x.test/a' },
      { text: 'b', href: 'https://x.test/b' },
    ]);
    expect(parseInlineLinks('plain text')).toEqual([{ text: 'plain text' }]);
    expect(parseInlineLinks('')).toEqual([]);
  });

  it('only http(s) addresses become links: javascript:, data:, relative and mailto stay text', () => {
    for (const bad of ['[x](javascript:alert(1))', '[x](data:text/html,hi)', '[x](/media/a.png)', '[x](mailto:a@b.test)', '[x]( https://x.test)']) {
      expect(parseInlineLinks(bad).every((p) => p.href === undefined), bad).toBe(true);
    }
  });
});

describe('plainInline', () => {
  it('drops the link syntax and keeps what the reader sees', () => {
    expect(plainInline('of [smallTech](https://smalltech.in), a software company')).toBe('of smallTech, a software company');
    expect(plainInline('no links here')).toBe('no links here');
  });
});
