import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { NewsletterSettings } from '@/components/admin/site/NewsletterSettings';
import { SiteSettingsView } from '@/components/admin/site/SiteSettingsView';
import {
  AUTO_SEND_WARNING,
  autoSendConfirm,
  countsLine,
  digestHint,
  draftFrom,
  isDirty,
  legacyConfirm,
  mailLine,
  MODE_HELP,
  patchFrom,
  senderLine,
  SYNC_CONFIRM,
  validateDraft,
} from '@/components/admin/site/newsletter-form';
import type { NewsletterSettingsDto, NewsletterStatusDto } from '@/lib/api/dto';

vi.mock('@/components/admin/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/components/admin/api')>();
  return { ...original, apiRequest: vi.fn(async () => ({ ok: false, status: 0, error: { code: 'NETWORK', message: 'offline' } })) };
});

// Site → Newsletter card (spec/ui.md §4 "Site"): form helpers + status strip lines.

const SETTINGS: NewsletterSettingsDto = { mode: 'manual', autoSend: false, digestDays: 7, digestPosts: 3, consentText: 'One issue a week at most.', consentVersion: 'v1', modeSetAt: null };
const STATUS: NewsletterStatusDto = {
  sender: { kind: 'stub', configured: true, listId: null, listName: null, lastSyncAt: null, healthy: null, message: null },
  mail: { transport: 'stub', from: null },
  counts: { all: 5, pending: 1, confirmed: 3, unsubscribed: 0, bounced: 0, legacy_unconfirmed: 1 },
  digest: null,
};

describe('newsletter settings form helpers', () => {
  it('round-trips the saved settings and sends only the changed fields with parsed numbers', () => {
    const draft = draftFrom(SETTINGS);
    expect(isDirty(SETTINGS, draft)).toBe(false);
    expect(patchFrom(SETTINGS, draft)).toEqual({});

    const edited = { ...draft, mode: 'digest' as const, digestDays: '14', consentText: '  New line. ' };
    expect(isDirty(SETTINGS, edited)).toBe(true);
    expect(patchFrom(SETTINGS, edited)).toEqual({ mode: 'digest', digestDays: 14, consentText: 'New line.' });
    expect(patchFrom(SETTINGS, { ...draft, autoSend: true })).toEqual({ autoSend: true });
  });

  it('validates the digest thresholds and the consent texts against the shared limits', () => {
    const draft = draftFrom(SETTINGS);
    expect(validateDraft(draft)).toEqual({});
    expect(validateDraft({ ...draft, mode: 'digest', digestDays: '0' })).toEqual({ digestDays: 'Between 1 and 60 days.' });
    expect(validateDraft({ ...draft, mode: 'digest', digestPosts: '21' })).toEqual({ digestPosts: 'Between 1 and 20 posts.' });
    expect(validateDraft({ ...draft, mode: 'digest', digestPosts: 'x' })).toEqual({ digestPosts: 'Between 1 and 20 posts.' });
    // thresholds are only checked in digest mode
    expect(validateDraft({ ...draft, mode: 'manual', digestDays: '0' })).toEqual({});
    expect(validateDraft({ ...draft, consentText: '   ' })).toEqual({ consentText: 'The consent text is required.' });
    expect(validateDraft({ ...draft, consentText: 'x'.repeat(301) })).toEqual({ consentText: 'At most 300 characters.' });
    expect(validateDraft({ ...draft, consentVersion: '' })).toEqual({ consentVersion: 'The version is required.' });
    expect(validateDraft({ ...draft, consentVersion: 'v'.repeat(21) })).toEqual({ consentVersion: 'At most 20 characters.' });
  });

  it('writes the status strip lines for stub and listmonk / smtp', () => {
    expect(senderLine(STATUS.sender)).toEqual({ kind: 'Stub', rest: 'issues are recorded, not delivered', stub: true });
    expect(senderLine({ kind: 'listmonk', configured: true, listId: '3', listName: 'blog0', lastSyncAt: null, healthy: true, message: null })).toEqual({
      kind: 'Listmonk', rest: 'list blog0 · healthy', stub: false,
    });
    expect(senderLine({ kind: 'listmonk', configured: true, listId: '3', listName: null, lastSyncAt: null, healthy: false, message: 'ECONNREFUSED' })).toEqual({
      kind: 'Listmonk', rest: 'list 3 · unreachable — ECONNREFUSED', stub: false,
    });
    expect(mailLine(STATUS.mail)).toBe('Stub — confirmation links are written to the server log and the subscriber’s audit view');
    expect(mailLine({ transport: 'smtp', from: 'news@blog0.test' })).toBe('SMTP from news@blog0.test');
    expect(countsLine(STATUS.counts)).toBe('3 confirmed · 1 pending · 1 legacy');
  });

  it('describes the digest schedule, the modes and the confirmations', () => {
    expect(digestHint(null, 'UTC')).toBeNull();
    expect(digestHint({ lastIssueAt: '2026-10-01T00:00:00Z', newPostsSince: 2, dueAt: '2026-10-08T00:00:00Z' }, 'UTC')).toBe('Next digest: due 8 Oct 2026 · 2 new posts since 1 Oct 2026');
    expect(digestHint({ lastIssueAt: null, newPostsSince: 0, dueAt: null }, 'UTC')).toBe('Next digest: not scheduled yet · no new posts');
    expect(MODE_HELP.manual).toBe('Issues are created only by hand.');
    expect(MODE_HELP.per_post).toBe('Every first publish creates an issue.');
    expect(MODE_HELP.digest(7, 3)).toBe('One issue every 7 days or 3 posts, whichever first.');
    expect(AUTO_SEND_WARNING).toBe('Send automatic issues without review. Off: every issue waits as a draft until you click Send.');
    expect(autoSendConfirm(3)).toBe('Issues will go out to 3 confirmed subscribers with no review. Turn auto-send on?');
    expect(legacyConfirm(2)).toBe('Send one confirmation email to 2 addresses? Each address gets it once.');
    expect(SYNC_CONFIRM).toBe('Push every confirmed subscriber to Listmonk and blocklist the unsubscribed ones?');
  });
});

describe('NewsletterSettings', () => {
  it('is the Newsletter card anchored at #newsletter, loading its own settings', () => {
    const html = renderToStaticMarkup(<NewsletterSettings timeZone="UTC" />);
    expect(html).toContain('id="newsletter"');
    expect(html).toContain('>Newsletter</h2>');
    expect(html).toContain('Loading newsletter settings…');
  });

  it('is mounted by the Site screen under the site form', () => {
    const html = renderToStaticMarkup(<SiteSettingsView wordmark="blog0" timeZone="UTC" />);
    expect(html).toContain('Loading site settings…');
    expect(html).toContain('id="newsletter"');
  });
});
