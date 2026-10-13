import { describe, expect, it } from 'vitest';

import { isBlog0Blocklist, latestConsentMs, listmonkOptOut, providerOptOutWins } from '@/server/newsletter/sender';

// The provider opt-out decision (sender/opt-out.ts + listmonkOptOut): an opt-out at the provider
// wins unless blog0's latest consent / confirmation is strictly newer.

const T = (iso: string) => new Date(iso);

describe('providerOptOutWins', () => {
  const consent = { consentedAt: T('2026-10-01T10:00:00Z'), confirmedAt: T('2026-10-02T10:00:00Z') };

  it('an opt-out newer than the latest confirmation wins', () => {
    expect(providerOptOutWins(T('2026-10-05T00:00:00Z'), consent)).toBe(true);
  });

  it('a confirmation newer than the opt-out (fresh double opt-in) wins', () => {
    expect(providerOptOutWins(T('2026-10-01T12:00:00Z'), consent)).toBe(false);
    // the latest of consent/confirmation counts, whichever field holds it
    expect(providerOptOutWins(T('2026-10-03T00:00:00Z'), { consentedAt: T('2026-10-04T00:00:00Z'), confirmedAt: T('2026-10-02T00:00:00Z') })).toBe(false);
  });

  it('boundary: an opt-out at exactly the confirmation instant wins (a tie goes to the opt-out)', () => {
    expect(providerOptOutWins(T('2026-10-02T10:00:00Z'), consent)).toBe(true); // tie → opt-out wins
    expect(providerOptOutWins(T('2026-10-02T10:00:00.001Z'), consent)).toBe(true);
  });

  it('ISO strings (provider attribs), nulls and garbage consent values', () => {
    expect(providerOptOutWins(T('2026-10-05T00:00:00Z'), { consentedAt: '2026-10-01T10:00:00.000Z', confirmedAt: '2026-10-06T00:00:00.000Z' })).toBe(false);
    expect(providerOptOutWins(T('2026-10-05T00:00:00Z'), { consentedAt: null, confirmedAt: null })).toBe(true);
    expect(providerOptOutWins(T('2026-10-05T00:00:00Z'), { consentedAt: 'not a date', confirmedAt: undefined })).toBe(true);
    expect(latestConsentMs({ consentedAt: null, confirmedAt: '2026-10-02T10:00:00Z' })).toBe(T('2026-10-02T10:00:00Z').getTime());
  });

  it('fails safe: an unparseable opt-out timestamp wins even over a recent confirmation', () => {
    expect(providerOptOutWins(new Date(Number.NaN), { consentedAt: new Date(), confirmedAt: new Date() })).toBe(true);
  });
});

describe('listmonkOptOut', () => {
  const LIST = 3;
  const base = { status: 'enabled' as const, updated_at: '2026-10-01T00:00:00Z' };

  it('a confirmed membership of the list is no opt-out; other lists are ignored', () => {
    expect(listmonkOptOut({ ...base, lists: [{ id: LIST, subscription_status: 'confirmed', subscription_updated_at: '2026-10-09T00:00:00Z' }] }, LIST)).toBeNull();
    expect(listmonkOptOut({ ...base, lists: [{ id: 99, subscription_status: 'unsubscribed', subscription_updated_at: '2026-10-09T00:00:00Z' }] }, LIST)).toBeNull();
    expect(listmonkOptOut({ ...base, lists: [] }, LIST)).toBeNull();
  });

  it('a list-level unsubscribe of an enabled subscriber is dated by subscription_updated_at', () => {
    const r = listmonkOptOut({ ...base, lists: [{ id: LIST, subscription_status: 'unsubscribed', subscription_updated_at: '2026-10-09T08:00:00+00:00' }] }, LIST);
    expect(r).toEqual({ kind: 'list_unsubscribed', at: T('2026-10-09T08:00:00Z') });
  });

  it('blocklisted: the later of updated_at and the subscription timestamp', () => {
    const r = listmonkOptOut(
      { status: 'blocklisted', updated_at: '2026-10-08T00:00:00Z', lists: [{ id: LIST, subscription_status: 'unsubscribed', subscription_updated_at: '2026-10-09T00:00:00Z' }] },
      LIST,
    );
    expect(r).toEqual({ kind: 'blocklisted', at: T('2026-10-09T00:00:00Z') });
    expect(listmonkOptOut({ status: 'blocklisted', updated_at: '2026-10-08T00:00:00Z', lists: [] }, LIST)).toEqual({ kind: 'blocklisted', at: T('2026-10-08T00:00:00Z') });
  });

  it('a blocklist blog0 made itself (blog0_blocklisted_at marker) is not a provider opt-out', () => {
    const lists = [{ id: LIST, subscription_status: 'unsubscribed', subscription_updated_at: '2026-10-09T00:00:00Z' }];
    expect(listmonkOptOut({ status: 'blocklisted', updated_at: '2026-10-09T00:00:00Z', lists, attribs: { blog0_blocklisted_at: '2026-10-09T00:00:00Z' } }, LIST)).toBeNull();
    expect(isBlog0Blocklist({ attribs: { blog0_blocklisted_at: '2026-10-09T00:00:00Z' } })).toBe(true);
    // an empty / non-string marker does not count; the marker never excuses a list-level unsubscribe of an enabled subscriber
    expect(listmonkOptOut({ status: 'blocklisted', updated_at: '2026-10-09T00:00:00Z', lists, attribs: { blog0_blocklisted_at: '' } }, LIST)?.kind).toBe('blocklisted');
    expect(isBlog0Blocklist({ attribs: { blog0_blocklisted_at: true } })).toBe(false);
    expect(isBlog0Blocklist({ attribs: null })).toBe(false);
    expect(listmonkOptOut({ ...base, lists, attribs: { blog0_blocklisted_at: '2026-10-09T00:00:00Z' } }, LIST)?.kind).toBe('list_unsubscribed');
  });

  it('a missing timestamp gives an invalid date that the decision treats as a winning opt-out', () => {
    const r = listmonkOptOut({ ...base, lists: [{ id: LIST, subscription_status: 'unsubscribed' }] }, LIST);
    expect(r?.kind).toBe('list_unsubscribed');
    expect(Number.isNaN(r!.at.getTime())).toBe(true);
    expect(providerOptOutWins(r!.at, { consentedAt: new Date(), confirmedAt: new Date() })).toBe(true);
  });
});
