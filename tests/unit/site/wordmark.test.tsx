import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Typewriter } from '@/components/design/Typewriter';
import { Wordmark } from '@/components/design/Wordmark';

// The design's Wordmark (spec/design/design-app.js) emits each space of the typed head as a
// non-breaking space inside its own span, so a multi-word wordmark keeps its gap instead of
// collapsing into an empty inline span. Stage A (spec/ui.md §3 "accessible animated text"): every
// typed text is `<span class="sr">full text</span><span aria-hidden="true">animated copy</span>`.

describe('Wordmark', () => {
  it('renders the full text once for assistive tech and the typed copy hidden from it', () => {
    const html = renderToStaticMarkup(<Wordmark text="log0" />);

    expect(html).toMatch(/^<span class="wordmark"><span class="sr">log0<\/span><span aria-hidden="true">/);
    expect(html).not.toContain('aria-label');
    expect(html.match(/class="typed__c"/g)).toHaveLength(3);
    expect(html).toMatch(/class="typed__c wordmark__o[^"]*is-spin[^"]*"[^>]*>0<\/span>/);
  });

  it('turns a space in the head into a non-breaking space like the design', () => {
    const html = renderToStaticMarkup(<Wordmark text="my log0" />);

    expect(html).toContain('>\u00A0</span>');
    expect(html).not.toMatch(/> <\/span>/);
    expect(html).toContain('<span class="sr">my log0</span>');
  });

  it('renders the plain variant as the bare text with no typed spans', () => {
    const html = renderToStaticMarkup(<Wordmark text="log0" plain />);

    expect(html).toBe('<span class="wordmark">log0</span>');
  });
});

describe('Typewriter', () => {
  it('keeps the tag and class, reads the full text from .sr and hides the per-character copy', () => {
    const html = renderToStaticMarkup(<Typewriter tag="h2" id="about-h" text="About Us" />);

    expect(html).toMatch(/^<h2 class="typed" id="about-h"><span class="sr">About Us<\/span><span aria-hidden="true">/);
    expect(html).not.toContain('aria-label');
    expect(html.match(/class="typed__c"/g)).toHaveLength(7);
  });
});
