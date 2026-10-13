import { describe, expect, it } from 'vitest';

import { bootCommand, bootRouteKey } from '@/components/site/Boot';

// The boot strip's line per route (spec/architecture.md divergence 6; design bootCommand).

describe('bootRouteKey', () => {
  it('maps the public pathnames onto the design routes', () => {
    expect(bootRouteKey('/')).toBe('home');
    expect(bootRouteKey('/archive')).toBe('archive');
    expect(bootRouteKey('/about')).toBe('about');
    expect(bootRouteKey('/p/humans-are-software')).toBe('humans-are-software');
  });

  it('treats the deck and listen addresses as the same article route', () => {
    expect(bootRouteKey('/p/humans-are-software/tldr')).toBe('humans-are-software');
    expect(bootRouteKey('/p/humans-are-software/listen')).toBe('humans-are-software');
  });

  it('ignores trailing slashes and falls back to the bare path for anything else', () => {
    expect(bootRouteKey('/archive/')).toBe('archive');
    expect(bootRouteKey('')).toBe('home');
    expect(bootRouteKey('/not-a-page')).toBe('not-a-page');
  });
});

describe('bootCommand', () => {
  it('types the start line with the brand on the first paint of a session, whatever the route', () => {
    expect(bootCommand('home', { first: true, brand: 'blog0' })).toBe('> start of blog0');
    expect(bootCommand('archive', { first: true, brand: 'blog0' })).toBe('> start of blog0');
    expect(bootCommand('humans-are-software', { first: true, brand: 'blog0' })).toBe('> start of blog0');
  });

  it('types the route command on every later navigation', () => {
    expect(bootCommand('home', { first: false, brand: 'blog0' })).toBe('> cd ~');
    expect(bootCommand('archive', { first: false, brand: 'blog0' })).toBe('> ls archive');
    expect(bootCommand('about', { first: false, brand: 'blog0' })).toBe('> cat about');
    expect(bootCommand('tech-company-first', { first: false, brand: 'blog0' })).toBe('> open tech-company-first');
  });

  it('takes the brand from the caller rather than a constant', () => {
    expect(bootCommand('home', { first: true, brand: 'other' })).toBe('> start of other');
  });

  it('never prints "log0" for the default brand', () => {
    const line = bootCommand('home', { first: true, brand: 'blog0' });

    expect(/\blog0\b/.test(line)).toBe(false);
  });
});
