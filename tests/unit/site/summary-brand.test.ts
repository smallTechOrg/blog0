import { describe, expect, it } from 'vitest';

import { siteBrandFromDocument } from '@/components/site/SummaryHost';

// A card's TLDR deck shares under the site wordmark the masthead carries (spec/capabilities/paragraph-share.md).

function docWithLabel(label: string | null): Pick<Document, 'querySelector'> {
  return {
    querySelector: ((sel: string) => {
      if (sel !== '#blog0-root a.brandlink' || label === null) return null;
      return { getAttribute: (name: string) => (name === 'aria-label' ? label : null) };
    }) as Document['querySelector'],
  };
}

describe('siteBrandFromDocument', () => {
  it('reads the wordmark from the masthead home link', () => {
    expect(siteBrandFromDocument(docWithLabel('blog0 — home'))).toBe('blog0');
    expect(siteBrandFromDocument(docWithLabel('Field Notes — home'))).toBe('Field Notes');
  });

  it('is null when the masthead is absent or its label is empty', () => {
    expect(siteBrandFromDocument(docWithLabel(null))).toBeNull();
    expect(siteBrandFromDocument(docWithLabel(' — home'))).toBeNull();
  });

  it('is null for a label that is not the home-link form', () => {
    expect(siteBrandFromDocument(docWithLabel('blog0'))).toBeNull();
  });
});
