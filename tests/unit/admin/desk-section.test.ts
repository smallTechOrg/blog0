import { describe, expect, it } from 'vitest';

import { deskSection } from '@/components/admin/DeskHeader';

// DeskHeader (spec/ui.md §4): Desk, Site, Subscribers; the article screens belong to Desk.

describe('deskSection', () => {
  it('marks the section the admin is in', () => {
    expect(deskSection('/admin')).toBe('/admin');
    expect(deskSection('/admin/articles/new')).toBe('/admin');
    expect(deskSection('/admin/articles/abc')).toBe('/admin');
    expect(deskSection('/admin/site')).toBe('/admin/site');
    expect(deskSection('/admin/subscribers')).toBe('/admin/subscribers');
  });

  it('marks nothing for unknown or look-alike paths', () => {
    expect(deskSection('/admin/sitemap')).toBeNull();
    expect(deskSection('/admin/login')).toBeNull();
    expect(deskSection('/')).toBeNull();
  });
});
