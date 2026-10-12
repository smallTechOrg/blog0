import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Wordmark } from '@/components/design/Wordmark';

// The design's Wordmark (spec/design/design-app.js) emits each space of the typed head as a
// non-breaking space inside its own span, so a multi-word wordmark keeps its gap instead of
// collapsing into an empty inline span.

describe('Wordmark', () => {
  it('renders one span per character of the head and the turning nought for the last character', () => {
    const html = renderToStaticMarkup(<Wordmark text="log0" />);

    expect(html).toContain('aria-label="log0"');
    expect(html.match(/class="typed__c"/g)).toHaveLength(3);
    expect(html).toMatch(/class="typed__c wordmark__o[^"]*is-spin[^"]*"[^>]*>0<\/span>/);
  });

  it('turns a space in the head into a non-breaking space like the design', () => {
    const html = renderToStaticMarkup(<Wordmark text="my log0" />);

    expect(html).toContain('> </span>');
    expect(html).not.toMatch(/> <\/span>/);
    expect(html).toContain('aria-label="my log0"');
  });

  it('renders the plain variant as the bare text with no typed spans', () => {
    const html = renderToStaticMarkup(<Wordmark text="log0" plain />);

    expect(html).toBe('<span class="wordmark">log0</span>');
  });
});
