import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { StatusFilter } from '@/components/admin/subscribers/StatusFilter';
import { SubscriberDetail, UNSUBSCRIBE_CONFIRM } from '@/components/admin/subscribers/SubscriberDetail';
import { SubscriberTimeline } from '@/components/admin/subscribers/SubscriberTimeline';
import { SubscribersView } from '@/components/admin/subscribers/SubscribersView';
import {
  AUDIT_HREF,
  adminListHref,
  confirmationAction,
  csvHref,
  emptyMessage,
  eventLabel,
  ipLine,
  legacySentence,
  listPath,
  parseStatusFilter,
  sourceCells,
  statusPillLabel,
  statusTagClass,
} from '@/components/admin/subscribers/subscribers-api';
import type { SubscriberCounts, SubscriberDetailDto, SubscriberEventDto } from '@/lib/api/dto';

vi.mock('@/components/admin/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/components/admin/api')>();
  return { ...original, apiRequest: vi.fn(async () => ({ ok: false, status: 0, error: { code: 'NETWORK', message: 'offline' } })) };
});

// Subscribers list + detail (spec/ui.md §4 "Subscribers", "Subscriber"): pure helpers and the
// static markup of every state that renders without effects.

const COUNTS: SubscriberCounts = { all: 12, pending: 2, confirmed: 7, unsubscribed: 1, bounced: 0, legacy_unconfirmed: 2 };

describe('subscriber list helpers', () => {
  it('builds the admin API path from the filter + query and keeps the filter on the CSV export only', () => {
    expect(parseStatusFilter('confirmed')).toBe('confirmed');
    expect(parseStatusFilter('legacy_unconfirmed')).toBe('legacy_unconfirmed');
    expect(parseStatusFilter('bogus')).toBe('all');
    expect(parseStatusFilter(null)).toBe('all');

    expect(listPath('all', '')).toBe('/api/admin/subscribers');
    expect(listPath('pending', 'a b@x')).toBe('/api/admin/subscribers?status=pending&q=a+b%40x');
    expect(adminListHref('confirmed', '')).toBe('/admin/subscribers?status=confirmed');
    expect(adminListHref('all', '')).toBe('/admin/subscribers');

    expect(csvHref('all')).toBe('/api/admin/subscribers?format=csv');
    expect(csvHref('bounced')).toBe('/api/admin/subscribers?format=csv&status=bounced');
    expect(AUDIT_HREF).toBe('/api/admin/subscribers?format=audit');
  });

  it('labels the status pill (expired pending, Legacy) with its modifier class', () => {
    expect(statusPillLabel({ status: 'pending', pendingExpired: false })).toBe('Pending');
    expect(statusPillLabel({ status: 'pending', pendingExpired: true })).toBe('Pending · expired');
    expect(statusPillLabel({ status: 'legacy_unconfirmed', pendingExpired: false })).toBe('Legacy');
    expect(statusTagClass('confirmed')).toBe('tag tag--confirmed');
    expect(statusTagClass('legacy_unconfirmed')).toBe('tag tag--legacy');
  });

  it('writes the empty line per filter and search, the legacy sentence and the source cells', () => {
    expect(emptyMessage('all', '')).toBe('No subscribers yet. Signups from the footer form on every public page land here.');
    expect(emptyMessage('bounced', '')).toBe('Nothing with that status.');
    expect(emptyMessage('all', 'zed')).toBe('No address matches.');
    expect(legacySentence(1)).toBe('1 subscriber from before double opt-in has not confirmed. They never receive issues until they do.');
    expect(legacySentence(2)).toBe('2 subscribers from before double opt-in have not confirmed. They never receive issues until they do.');
    expect(sourceCells({ source: 'footer', sourceUrl: '/p/hello' })).toEqual({ main: 'footer', faint: '/p/hello' });
    expect(sourceCells({ source: 'legacy', sourceUrl: null })).toEqual({ main: 'legacy', faint: null });
  });

  it('labels every event kind for the timeline', () => {
    const ev = (kind: SubscriberEventDto['kind'], source: SubscriberEventDto['source'] = 'system', details: Record<string, unknown> = {}): SubscriberEventDto => ({
      id: 'e', kind, source, actor: null, ip: null, userAgent: null, details, createdAt: '2026-10-12T10:00:00Z',
    });
    expect(eventLabel(ev('signup', 'footer', { sourceUrl: '/p/hello' }))).toBe('Signed up from /p/hello');
    expect(eventLabel(ev('confirmation_sent', 'system', { transport: 'smtp' }))).toBe('Confirmation email sent (smtp)');
    expect(eventLabel(ev('confirmation_sent', 'system', { transport: 'smtp', outcome: 'failed' }))).toBe('Confirmation email sent (smtp) — failed');
    expect(eventLabel(ev('confirmed', 'email_link'))).toBe('Confirmed');
    expect(eventLabel(ev('resubscribed', 'footer'))).toBe('Re-subscribed');
    expect(eventLabel(ev('unsubscribed', 'email_link'))).toBe('Unsubscribed via email link');
    expect(eventLabel(ev('unsubscribed', 'one_click'))).toBe('Unsubscribed via one-click');
    expect(eventLabel(ev('unsubscribed', 'admin'))).toBe('Unsubscribed by an admin');
    expect(eventLabel(ev('bounced', 'provider'))).toBe('Bounced (provider)');
    expect(eventLabel(ev('legacy_confirmation_sent', 'admin', { transport: 'stub' }))).toBe('One-time legacy confirmation sent (stub)');
    expect(eventLabel(ev('provider_synced', 'system'))).toBe('Synced to Listmonk');
    expect(eventLabel(ev('provider_synced', 'system', { provider: 'stub' }))).toBe('Synced (stub)');
    expect(eventLabel(ev('provider_removed', 'system'))).toBe('Removed from Listmonk');
    expect(eventLabel(ev('ip_pruned', 'system'))).toBe('IP pruned');
  });
});

const DETAIL: SubscriberDetailDto = {
  id: 's1', email: 'ann@example.test', name: 'Ann', status: 'pending', source: 'footer', createdAt: '2026-10-12T10:00:00Z',
  consentedAt: '2026-10-12T10:00:00Z', confirmedAt: null, unsubscribedAt: null, pendingExpired: false, consentVersion: 'v1',
  sourceUrl: '/p/hello', providerSyncedAt: null, canSendConfirmation: true,
  signupIp: null, signupUserAgent: 'Mozilla/5.0', consentText: 'One issue a week at most.', confirmedIp: null, confirmedUserAgent: null,
  confirmTokenExpiresAt: '2026-10-15T10:00:00Z', confirmationSentCount: 1, legacyConfirmationSentAt: null, providerId: null, ipPrunedAt: null,
  events: [
    { id: 'e1', kind: 'signup', source: 'footer', actor: null, ip: null, userAgent: 'Mozilla/5.0', details: { sourceUrl: '/p/hello' }, createdAt: '2026-10-12T10:00:00Z' },
    { id: 'e2', kind: 'confirmation_sent', source: 'system', actor: null, ip: null, userAgent: null, details: { transport: 'stub' }, createdAt: '2026-10-12T10:00:01Z' },
  ],
  suppressions: [],
  messages: [{ id: 'm1', kind: 'confirmation', subject: 'Confirm your subscription', transport: 'stub', status: 'recorded', createdAt: '2026-10-12T10:00:01Z' }],
};

describe('subscriber detail helpers', () => {
  it('describes the signup / confirmation IP: recorded, pruned or never recorded', () => {
    expect(ipLine({ ...DETAIL, signupIp: '203.0.113.9' }, 'signup', 'UTC')).toBe('203.0.113.9');
    expect(ipLine({ ...DETAIL, ipPrunedAt: '2027-10-12T00:00:00Z' }, 'signup', 'UTC')).toBe('pruned 12 Oct 2027');
    expect(ipLine(DETAIL, 'signup', 'UTC')).toBe('not recorded — no trusted proxy');
    expect(ipLine(DETAIL, 'confirmed', 'UTC')).toBe('not recorded — no trusted proxy');
  });

  it('offers the confirmation button only to legacy and pending rows, disabled with the reason', () => {
    expect(confirmationAction(DETAIL, 'UTC')).toEqual({ label: 'Resend confirmation', disabled: false, title: undefined });
    expect(confirmationAction({ ...DETAIL, canSendConfirmation: false }, 'UTC')).toMatchObject({ label: 'Resend confirmation', disabled: true });
    expect(confirmationAction({ ...DETAIL, canSendConfirmation: false }, 'UTC')?.title).toMatch(/^Limit reached — try again later/);
    const legacy = confirmationAction({ ...DETAIL, status: 'legacy_unconfirmed' }, 'UTC');
    expect(legacy).toEqual({ label: 'Send the one-time confirmation', disabled: false, title: undefined });
    const sent = confirmationAction({ ...DETAIL, status: 'legacy_unconfirmed', canSendConfirmation: false, legacyConfirmationSentAt: '2026-10-01T00:00:00Z' }, 'UTC');
    expect(sent).toEqual({ label: 'Send the one-time confirmation', disabled: true, title: 'Already sent 1 Oct 2026' });
    expect(confirmationAction({ ...DETAIL, status: 'confirmed' }, 'UTC')).toBeNull();
    expect(confirmationAction({ ...DETAIL, status: 'unsubscribed' }, 'UTC')).toBeNull();
  });

  it('names the permanent suppression in the unsubscribe confirmation', () => {
    expect(UNSUBSCRIBE_CONFIRM('ann@example.test')).toBe('Unsubscribe ann@example.test? This writes a permanent suppression entry.');
  });
});

describe('StatusFilter', () => {
  it('is a tablist of pills with counts; the active one is on', () => {
    const html = renderToStaticMarkup(<StatusFilter counts={COUNTS} value="pending" onChange={() => {}} />);
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/<button[^>]*class="pill"[^>]*>All<span class="pill__n">12<\/span><\/button>/);
    expect(html).toMatch(/<button[^>]*class="pill is-on"[^>]*aria-selected="true"[^>]*>Pending<span class="pill__n">2<\/span><\/button>/);
    expect(html).toContain('>Legacy<span class="pill__n">2</span>');
    expect(html).toContain('>Bounced<span class="pill__n">0</span>');
  });
});

describe('SubscribersView', () => {
  it('starts in the loading state with the search box and the filter from the URL', () => {
    const html = renderToStaticMarkup(<SubscribersView timeZone="UTC" initialStatus="confirmed" initialQuery="ann" />);
    expect(html).toContain('Loading subscribers…');
    expect(html).toContain('type="search"');
    expect(html).toContain('value="ann"');
    expect(html).toContain('Subscribers');
    expect(html).not.toContain('Export CSV');
  });
});

describe('SubscriberTimeline', () => {
  it('lists events oldest first with label, source, time and a details block', () => {
    const html = renderToStaticMarkup(<SubscriberTimeline events={DETAIL.events} timeZone="UTC" />);
    expect(html).toContain('<ol class="timeline">');
    expect(html.indexOf('Signed up from /p/hello')).toBeLessThan(html.indexOf('Confirmation email sent (stub)'));
    expect(html).toContain('data-kind="signup"');
    expect(html).toContain('footer');
    expect(html).toContain('<details');
    expect(html).toContain('&quot;sourceUrl&quot;');
    expect(html).toContain('dateTime="2026-10-12T10:00:00Z"');
  });

  it('says so when there are no events', () => {
    expect(renderToStaticMarkup(<SubscriberTimeline events={[]} timeZone="UTC" />)).toContain('No events recorded.');
  });
});

describe('SubscriberDetail', () => {
  it('loads the subscriber before showing anything else', () => {
    const html = renderToStaticMarkup(<SubscriberDetail id="s1" timeZone="UTC" />);
    expect(html).toContain('Loading the subscriber…');
    expect(html).toContain('href="/admin/subscribers"');
  });
});
