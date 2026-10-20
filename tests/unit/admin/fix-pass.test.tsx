import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { EraseDialog } from '@/components/admin/subscribers/EraseDialog';
import { SendDialog } from '@/components/admin/newsletter/SendDialog';
import { POSTAL_WARNING, postalAddressMissing } from '@/components/admin/newsletter/newsletter-api';
import { SiteSettingsForm } from '@/components/admin/site/SiteSettingsView';
import {
  ERASE_BUTTON,
  ERASE_CONFIRM,
  eraseConfirmMatches,
  eraseErrorMessage,
  eraseNotice,
  eventLabel,
} from '@/components/admin/subscribers/subscribers-api';
import { PrivacyView } from '@/components/site/privacy/PrivacyView';
import type { SiteSettingsDto, SubscriberEventDto } from '@/lib/api/dto';

vi.mock('@/components/admin/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/components/admin/api')>();
  return { ...original, apiRequest: vi.fn(async () => ({ ok: false, status: 0, error: { code: 'NETWORK', message: 'offline' } })) };
});

const noop = () => {};
const STUB = { kind: 'stub', configured: true, listId: null, listName: null, lastSyncAt: null, healthy: null, message: null, trackingPublic: true } as const;

describe('delete-subscriber confirmation gating', () => {
  it('matches the typed address case-insensitively, ignoring surrounding spaces, and nothing else', () => {
    expect(eraseConfirmMatches('', 'Ann@Example.test')).toBe(false);
    expect(eraseConfirmMatches('ann@example.tes', 'Ann@Example.test')).toBe(false);
    expect(eraseConfirmMatches('  ann@example.test ', 'Ann@Example.test')).toBe(true);
  });

  it('writes the button, the dialog sentence, the list confirmations per Listmonk outcome, the named errors and the old timeline label', () => {
    expect(ERASE_BUTTON).toBe('Delete subscriber and personal data');
    expect(ERASE_CONFIRM('a@b.test')).toContain('Delete a@b.test and all personal data?');
    expect(ERASE_CONFIRM('a@b.test')).toContain('This cannot be undone.');
    expect(eraseNotice({ provider: 'deleted', providerError: null, providerRetry: false })).toEqual({ kind: 'ok', text: 'Subscriber and personal data deleted. The Listmonk copy was deleted too.' });
    expect(eraseNotice({ provider: 'not_found', providerError: null, providerRetry: false })).toEqual({ kind: 'ok', text: 'Subscriber and personal data deleted. Listmonk held no copy.' });
    expect(eraseNotice({ provider: 'skipped', providerError: null, providerRetry: false }).text).toContain('No Listmonk is configured');
    const retry = eraseNotice({ provider: 'failed', providerError: 'Listmonk unreachable at http://localhost:9000: fetch failed', providerRetry: true });
    expect(retry.kind).toBe('warn');
    expect(retry.text).toContain('(Listmonk unreachable at http://localhost:9000: fetch failed)');
    expect(retry.text).toContain('the hourly newsletter tick retries it.');
    expect(eraseNotice({ provider: 'failed', providerError: 'boom', providerRetry: false }).text).toContain('delete it in Listmonk’s admin');
    expect(eraseErrorMessage({ code: 'NOT_FOUND', message: 'x' })).toBe('This subscriber was already deleted — go back to the list.');
    expect(eraseErrorMessage({ code: 'NETWORK', message: 'x' })).toContain('nothing was deleted');
    expect(eraseErrorMessage({ code: 'ERASE_FAILED', message: 'The database refused the deletion (deadlock detected). Nothing was deleted.' })).toContain('deadlock detected');
    const ev = { id: 'e', kind: 'erased', source: 'admin', actor: null, ip: null, userAgent: null, details: {}, createdAt: '2026-10-12T10:00:00Z' } as SubscriberEventDto;
    expect(eventLabel(ev)).toBe('Personal data erased');
  });

  it('EraseDialog starts with Delete disabled and asks to type the address', () => {
    const html = renderToStaticMarkup(<EraseDialog subscriber={{ id: 's1', email: 'ann@example.test' }} onCancel={noop} onDone={noop} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Delete ann@example.test and all personal data?');
    expect(html).toContain('Type the address to confirm');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Delete<\/button>/);
    expect(html).toContain('>Cancel</button>');
  });
});

describe('postal address warning', () => {
  it('reads the issue warnings (strings or { code })', () => {
    expect(postalAddressMissing(['postal_address_missing'])).toBe(true);
    expect(postalAddressMissing([{ code: 'postal_address_missing' }])).toBe(true);
    expect(postalAddressMissing([])).toBe(false);
    expect(postalAddressMissing(undefined)).toBe(false);
  });

  it('SendDialog shows the warning with a Site link and keeps Send now enabled', () => {
    const html = renderToStaticMarkup(<SendDialog recipients={2} sender={STUB} pending={false} postalAddressMissing onSend={noop} onCancel={noop} />);
    expect(html).toContain(POSTAL_WARNING);
    expect(html).toContain('href="/admin/site"');
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Send now<\/button>/);
    const clean = renderToStaticMarkup(<SendDialog recipients={2} sender={STUB} pending={false} onSend={noop} onCancel={noop} />);
    expect(clean).not.toContain('No postal address is set');
  });
});

describe('Site form fields (fix pass)', () => {
  const SAVED: SiteSettingsDto = {
    tagline: 't', contactEmail: 'a@b.test', aboutStrap: 's', aboutStand: 'st', aboutBodyMd: 'body',
    socialXUrl: null, socialLinkedinUrl: null,
    privacyText: 'Para one.\n\nPara two.', newsletterPostalAddress: '',
    newsletter: { mode: 'manual', autoSend: false, digestDays: 7, digestPosts: 3, consentText: 'c', consentVersion: 'v1', modeSetAt: null },
  };

  it('renders the privacy textarea with its draft note and the postal address textarea with the legal note', () => {
    const html = renderToStaticMarkup(<SiteSettingsForm wordmark="blog0" saved={SAVED} onSaved={noop} />);
    expect(html).toMatch(/<textarea[^>]*id="site-privacyText"[^>]*maxLength="8000"|<textarea[^>]*maxLength="8000"[^>]*id="site-privacyText"/);
    expect(html).toMatch(/<textarea[^>]*id="site-newsletterPostalAddress"/);
    expect(html).toContain('Review the wording — the default is a draft, not legal advice.');
    expect(html).toContain('must be filled before you send');
    expect(html).toContain('Preview — /privacy');
    expect(html).toContain('Para two.');
  });
});

describe('PrivacyView', () => {
  it('renders the h1, the paragraphs as text and the erasure contact line', () => {
    const html = renderToStaticMarkup(<PrivacyView paragraphs={['One <b>x</b>.', 'Two.']} contactEmail="hi@x.test" />);
    expect(html).toContain('<h1>Privacy</h1>');
    expect(html).toContain('One &lt;b&gt;x&lt;/b&gt;.');
    expect(html).toContain('Questions or an erasure request: <a href="mailto:hi@x.test">hi@x.test</a>');
  });
});
