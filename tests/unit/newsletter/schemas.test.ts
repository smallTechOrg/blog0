import { describe, expect, it } from 'vitest';

import {
  adminUnsubscribeBody,
  confirmTrueBody,
  issueCreate,
  issueUpdate,
  settingsPatch,
  subscribeBody,
  subscriberListQuery,
  webhookBody,
} from '@/server/newsletter/schemas';

// Zod bodies of the newsletter routes (spec/api.md → newsletter; spec/architecture.md §13.1).

describe('subscribeBody', () => {
  it('trims + lower-cases the email, trims the name, defaults sourceUrl to /', () => {
    expect(subscribeBody.parse({ email: '  A@B.com ', name: ' Asha ' })).toEqual({ email: 'a@b.com', name: 'Asha', sourceUrl: '/' });
    expect(subscribeBody.parse({ email: 'a@b.com', sourceUrl: '/p/humans-are-software?x=1' })).toMatchObject({ sourceUrl: '/p/humans-are-software?x=1' });
    expect(subscribeBody.parse({ email: 'a@b.com', name: '  ' }).name).toBeNull();
  });

  it('refuses a non-relative, protocol-relative, javascript-ish or over-long sourceUrl', () => {
    for (const sourceUrl of ['https://evil.example/', '//evil.example', '/\\evil', 'p/slug', '/a b', '/<script>', '/' + 'x'.repeat(500)]) {
      expect(subscribeBody.safeParse({ email: 'a@b.com', sourceUrl }).success, sourceUrl).toBe(false);
    }
    expect(subscribeBody.safeParse({ email: 'a@b.com', sourceUrl: '/' + 'x'.repeat(499) }).success).toBe(true);
  });

  it('refuses a bad address, an over-long email and an over-long name', () => {
    expect(subscribeBody.safeParse({ email: 'nope' }).success).toBe(false);
    expect(subscribeBody.safeParse({ email: `${'a'.repeat(250)}@b.com` }).success).toBe(false);
    expect(subscribeBody.safeParse({ email: 'a@b.com', name: 'n'.repeat(121) }).success).toBe(false);
  });
});

describe('settingsPatch', () => {
  it('accepts a valid subset and rejects modeSetAt, digestDays 0, digestPosts 21, mode weekly, blank consent', () => {
    expect(settingsPatch.parse({ mode: 'digest', digestDays: 7, digestPosts: 3, consentText: ' x ', autoSend: true })).toEqual({
      mode: 'digest',
      digestDays: 7,
      digestPosts: 3,
      consentText: 'x',
      autoSend: true,
    });
    expect(settingsPatch.safeParse({ modeSetAt: '2026-01-01T00:00:00Z' }).success).toBe(false);
    expect(settingsPatch.safeParse({ digestDays: 0 }).success).toBe(false);
    expect(settingsPatch.safeParse({ digestDays: 61 }).success).toBe(false);
    expect(settingsPatch.safeParse({ digestPosts: 21 }).success).toBe(false);
    expect(settingsPatch.safeParse({ digestPosts: 1.5 }).success).toBe(false);
    expect(settingsPatch.safeParse({ mode: 'weekly' }).success).toBe(false);
    expect(settingsPatch.safeParse({ consentText: '   ' }).success).toBe(false);
    expect(settingsPatch.safeParse({ consentText: 'x'.repeat(301) }).success).toBe(false);
    expect(settingsPatch.safeParse({ consentVersion: 'v'.repeat(21) }).success).toBe(false);
  });
});

describe('issueCreate / issueUpdate', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  it('needs a title and 1–10 uuid article ids; introMd defaults to empty', () => {
    expect(issueCreate.parse({ title: ' Hi ', articleIds: [id] })).toEqual({ title: 'Hi', introMd: '', articleIds: [id] });
    expect(issueCreate.safeParse({ title: '', articleIds: [id] }).success).toBe(false);
    expect(issueCreate.safeParse({ title: 'x', articleIds: [] }).success).toBe(false);
    expect(issueCreate.safeParse({ title: 'x', articleIds: Array(11).fill(id) }).success).toBe(false);
    expect(issueCreate.safeParse({ title: 'x', articleIds: ['nope'] }).success).toBe(false);
    expect(issueCreate.safeParse({ title: 'x'.repeat(151), articleIds: [id] }).success).toBe(false);
    expect(issueCreate.safeParse({ title: 'x', articleIds: [id], extra: 1 }).success).toBe(false);
    expect(issueUpdate.parse({})).toEqual({});
    expect(issueUpdate.safeParse({ introMd: 'x'.repeat(5001) }).success).toBe(false);
  });
});

describe('the small bodies', () => {
  it('webhookBody, confirmTrueBody, adminUnsubscribeBody, subscriberListQuery', () => {
    expect(webhookBody.parse({ event: 'bounce', email: ' X@Y.io ' })).toEqual({ event: 'bounce', email: 'x@y.io' });
    expect(webhookBody.safeParse({ event: 'open', email: 'x@y.io' }).success).toBe(false);
    expect(confirmTrueBody.safeParse({ confirm: false }).success).toBe(false);
    expect(confirmTrueBody.safeParse({}).success).toBe(false);
    expect(confirmTrueBody.parse({ confirm: true })).toEqual({ confirm: true });
    expect(adminUnsubscribeBody.parse({})).toEqual({ note: undefined });
    expect(adminUnsubscribeBody.parse({ note: '  ' })).toEqual({ note: undefined });
    expect(adminUnsubscribeBody.safeParse({ note: 'n'.repeat(301) }).success).toBe(false);
    expect(subscriberListQuery.parse({ status: 'confirmed', q: ' a ', format: 'csv' })).toEqual({ status: 'confirmed', q: 'a', format: 'csv' });
    expect(subscriberListQuery.safeParse({ status: 'subscribed' }).success).toBe(false);
    expect(subscriberListQuery.safeParse({ format: 'xml' }).success).toBe(false);
    expect(subscriberListQuery.safeParse({ q: 'q'.repeat(101) }).success).toBe(false);
  });
});
