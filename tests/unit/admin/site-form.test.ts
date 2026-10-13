import { describe, expect, it } from 'vitest';

import { draftFrom, fieldErrorsFrom, isDirty, patchFrom, validateDraft } from '@/components/admin/site/site-form';
import type { SiteSettingsDto } from '@/lib/api/dto';
import { SITE_SETTINGS_LIMITS } from '@/lib/api/dto';

const SAVED: SiteSettingsDto = {
  tagline: 'the meaning of life, universe, and everything',
  contactEmail: 'hello@logzero.blog',
  aboutStrap: 'Less noise. More signal.',
  aboutStand: 'A publication from smallTech.',
  aboutBodyMd: 'One.\n\nTwo.',
  socialXUrl: null,
  socialLinkedinUrl: 'https://www.linkedin.com/company/smalltech',
  newsletter: { mode: 'manual', autoSend: false, digestDays: 7, digestPosts: 3, consentText: 'One issue a week at most.', consentVersion: 'v1', modeSetAt: null },
};

describe('site settings form helpers', () => {
  it('round-trips the saved settings into a clean draft (nulls become empty inputs)', () => {
    const draft = draftFrom(SAVED);

    expect(draft.socialXUrl).toBe('');
    expect(isDirty(SAVED, draft)).toBe(false);
    expect(patchFrom(SAVED, draft)).toEqual({});
  });

  it('sends only the changed fields, trimmed, with a blank URL as null', () => {
    const draft = { ...draftFrom(SAVED), aboutStrap: '  New strap. ', socialLinkedinUrl: '  ', socialXUrl: 'https://x.com/st' };

    expect(isDirty(SAVED, draft)).toBe(true);
    expect(patchFrom(SAVED, draft)).toEqual({ aboutStrap: 'New strap.', socialLinkedinUrl: null, socialXUrl: 'https://x.com/st' });
  });

  it('does not count whitespace-only edits as changes', () => {
    const draft = { ...draftFrom(SAVED), tagline: SAVED.tagline + '   ' };

    expect(isDirty(SAVED, draft)).toBe(false);
  });

  it('flags blank required text, a bad email, a non-http URL and over-long text', () => {
    const draft = {
      ...draftFrom(SAVED),
      aboutStrap: ' ',
      contactEmail: 'nope',
      socialXUrl: 'javascript:alert(1)',
      aboutStand: 'x'.repeat(SITE_SETTINGS_LIMITS.aboutStand + 1),
    };

    const errors = validateDraft(draft);

    expect(Object.keys(errors).sort()).toEqual(['aboutStand', 'aboutStrap', 'contactEmail', 'socialXUrl']);
    expect(validateDraft(draftFrom(SAVED))).toEqual({});
  });

  it('maps server VALIDATION_FAILED details to per-field messages, ignoring junk', () => {
    expect(fieldErrorsFrom({ fieldErrors: { contactEmail: ['Enter a valid email address.'], wordmark: ['x'] }, formErrors: [] })).toEqual({
      contactEmail: 'Enter a valid email address.',
    });
    expect(fieldErrorsFrom(null)).toEqual({});
    expect(fieldErrorsFrom({ fieldErrors: 'garbled' })).toEqual({});
  });
});
