import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { LinkActionButton } from '@/components/site/newsletter/LinkActionButton';
import { outcomeCopy, postUnsubscribe, UNSUBSCRIBE_ACTION } from '@/components/site/newsletter/link-action';
import { LINK_COPY, LinkPage } from '@/components/site/newsletter/LinkPage';

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('LinkActionButton (unsubscribe prompt state)', () => {
  it('names the brand, offers one enabled Yes, unsubscribe me and the sign-up-again note, no outcome copy yet', () => {
    const html = renderToStaticMarkup(<LinkActionButton token="t" brand="blog0" brandName="Blog Zero" />);
    expect(html).toContain('Unsubscribe from Blog Zero?');
    expect(html).toContain('>Yes, unsubscribe me</button>');
    expect(html).toContain('You can sign up again any time.');
    expect(html).not.toContain('disabled');
    expect(html).not.toContain(LINK_COPY.unsubscribed.heading);
    // The confirm variant is gone: the confirm link confirms on open (owner decision 2026-10-19).
    expect(html).not.toContain('Confirm my subscription');
  });
});

describe('postUnsubscribe', () => {
  it('POSTs { token, source: email_link } to the JSON route and maps 200 to done', async () => {
    const f = vi.fn().mockResolvedValue(res(200, { ok: true, data: { unsubscribed: true, alreadyUnsubscribed: false } }));
    expect(await postUnsubscribe('tok', f as unknown as typeof fetch)).toEqual({ kind: 'done' });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/newsletter/unsubscribe');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ token: 'tok', source: 'email_link' });
  });

  it('410 → expired, 404 → invalid, 429 → rate-limited with minutes from Retry-After', async () => {
    const mk = (r: Response) => postUnsubscribe('t', vi.fn().mockResolvedValue(r) as unknown as typeof fetch);
    expect(await mk(res(410, { ok: false, error: { code: 'TOKEN_EXPIRED', message: 'x' } }))).toEqual({ kind: 'expired' });
    expect(await mk(res(404, { ok: false, error: { code: 'TOKEN_INVALID', message: 'x' } }))).toEqual({ kind: 'invalid' });
    expect(await mk(res(429, { ok: false, error: { code: 'RATE_LIMITED', message: 'x' } }, { 'retry-after': '125' }))).toEqual({ kind: 'rate_limited', minutes: 3 });
    expect(await mk(res(429, { ok: false, error: { code: 'RATE_LIMITED', message: 'x' } }))).toEqual({ kind: 'rate_limited', minutes: 1 });
  });

  it('a network error or a 500 is "failed" (button re-enabled by the component)', async () => {
    expect(await postUnsubscribe('t', vi.fn().mockRejectedValue(new Error('down')) as unknown as typeof fetch)).toEqual({ kind: 'failed' });
    expect(await postUnsubscribe('t', vi.fn().mockResolvedValue(res(500, { ok: false, error: { code: 'INTERNAL', message: 'x' } })) as unknown as typeof fetch)).toEqual({ kind: 'failed' });
  });
});

describe('outcomeCopy', () => {
  it('reuses the existing link-page copy', () => {
    expect(outcomeCopy({ kind: 'done' })).toEqual({ heading: LINK_COPY.unsubscribed.heading, body: LINK_COPY.unsubscribed.body() });
    expect(outcomeCopy({ kind: 'expired' }).heading).toBe(LINK_COPY.expired.heading);
    expect(outcomeCopy({ kind: 'invalid' }).heading).toBe(LINK_COPY.invalid.heading);
    expect(outcomeCopy({ kind: 'rate_limited', minutes: 2 }).body).toBe('Try the link again in 2 minutes.');
    expect(outcomeCopy({ kind: 'failed' }).body).toBe('Something went wrong — try again.');
  });

  it('declares the button label', () => {
    expect(UNSUBSCRIBE_ACTION.button).toBe('Yes, unsubscribe me');
  });
});

describe('confirm result copy (confirm-on-open)', () => {
  it('ok welcomes the reader by brand; already is a success, never an error', () => {
    expect(LINK_COPY.confirmed.heading('Blog Zero')).toBe('You’re confirmed — welcome to Blog Zero.');
    expect(LINK_COPY.alreadyConfirmed.heading).toBe('You’re already confirmed.');
    const html = renderToStaticMarkup(<LinkPage brand="blog0" heading={LINK_COPY.alreadyConfirmed.heading} body={LINK_COPY.alreadyConfirmed.body('Blog Zero')} />);
    expect(html).toContain('You’re already confirmed.');
    expect(html).toMatch(/Back to (<!-- -->)?blog0/);
    expect(html).not.toContain(LINK_COPY.expired.heading);
  });
});
