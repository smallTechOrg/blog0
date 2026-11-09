import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Typewriter } from '@/components/design/Typewriter';
import { Wordmark } from '@/components/design/Wordmark';

// The typing is page-wide (page-typer.ts), so the wordmark and typed lines are plain text.

describe('Wordmark', () => {
  it('renders the text with the turning final letter', () => {
    expect(renderToStaticMarkup(<Wordmark text="blog0" />)).toBe('<span class="wordmark">blog<span class="wordmark__o is-spin">0</span></span>');
  });

  it('renders the plain variant as the bare text', () => {
    expect(renderToStaticMarkup(<Wordmark text="blog0" plain />)).toBe('<span class="wordmark">blog0</span>');
  });
});

describe('Typewriter', () => {
  it('keeps the tag, class and id around the plain text', () => {
    expect(renderToStaticMarkup(<Typewriter tag="h2" id="about-h" text="About Us" />)).toBe('<h2 class="typed" id="about-h">About Us</h2>');
  });
});
