import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  NL_DELIVERY_COPY,
  NewsletterForm,
  signupBody,
  signupOutcome,
} from '@/components/site/NewsletterForm';

// Stage A items 9 + 12 (spec/ui.md §3 "Newsletter form"; spec/api.md POST /api/newsletter): the
// success copy follows `delivery`; the form carries a honeypot and the fill time.

describe('signup copy by delivery', () => {
  it('has one honest line per delivery value', () => {
    expect(NL_DELIVERY_COPY).toEqual({
      sent: 'Almost there — check your inbox and confirm.',
      recorded: 'Signup recorded — this environment doesn’t send email.',
      failed: 'We couldn’t send your confirmation email — please try again shortly.',
    });
  });

  it('maps the response envelope onto an outcome', () => {
    expect(signupOutcome(200, { ok: true, data: { subscribed: true, delivery: 'sent' } })).toEqual({ kind: 'done', delivery: 'sent' });
    expect(signupOutcome(200, { ok: true, data: { subscribed: true, delivery: 'recorded' } })).toEqual({ kind: 'done', delivery: 'recorded' });
    expect(signupOutcome(200, { ok: true, data: { subscribed: true, delivery: 'failed' } })).toEqual({ kind: 'done', delivery: 'failed' });
  });

  it('treats a success without a known delivery as sent, a 400 as invalid and anything else as failed', () => {
    expect(signupOutcome(200, { ok: true, data: { subscribed: true } })).toEqual({ kind: 'done', delivery: 'sent' });
    expect(signupOutcome(400, { ok: false })).toEqual({ kind: 'invalid' });
    expect(signupOutcome(429, { ok: false })).toEqual({ kind: 'failed' });
    expect(signupOutcome(500, null)).toEqual({ kind: 'failed' });
  });
});

describe('signupBody', () => {
  it('sends the honeypot value and the rounded fill time with the address', () => {
    expect(signupBody({ email: 'a@b.co', name: '', sourceUrl: '/p/x', website: '', fillMs: 2345.6 })).toEqual({
      email: 'a@b.co',
      sourceUrl: '/p/x',
      website: '',
      fillMs: 2346,
    });
    expect(signupBody({ email: 'a@b.co', name: 'Ann', sourceUrl: '/', website: 'spam', fillMs: -5 })).toEqual({
      email: 'a@b.co',
      name: 'Ann',
      sourceUrl: '/',
      website: 'spam',
      fillMs: 0,
    });
  });
});

describe('NewsletterForm markup', () => {
  it('has an off-screen, aria-hidden honeypot input that is skipped by Tab and autofill', () => {
    const html = renderToStaticMarkup(<NewsletterForm consentText="I agree." />);
    const hp = /<div class="ft-hp" aria-hidden="true">([\s\S]*?)<\/div>/.exec(html);

    expect(hp, 'honeypot wrapper').not.toBeNull();
    expect(hp![1]).toMatch(/<input[^>]*name="website"/);
    expect(hp![1]).toMatch(/tabindex="-1"/i);
    expect(hp![1]).toMatch(/autocomplete="off"/i);
    expect(html).not.toMatch(/display:\s*none/);
  });
});
