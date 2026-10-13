import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { LinkActionButton } from '@/components/site/newsletter/LinkActionButton';
import { LINK_ACTIONS, outcomeCopy, postLinkAction } from '@/components/site/newsletter/link-action';
import { LINK_COPY } from '@/components/site/newsletter/LinkPage';

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('LinkActionButton (prompt state)', () => {
  it('confirm: heading, one enabled button, no outcome copy yet', () => {
    const html = renderToStaticMarkup(<LinkActionButton kind="confirm" token="t" brand="blog0" brandName="blog0" />);
    expect(html).toContain('Confirm your subscription');
    expect(html).toContain('>Confirm my subscription</button>');
    expect(html).not.toContain('disabled');
    expect(html).not.toContain(LINK_COPY.confirmed.heading);
  });

  it('unsubscribe: names the brand, offers Yes, unsubscribe me and the sign-up-again note', () => {
    const html = renderToStaticMarkup(<LinkActionButton kind="unsubscribe" token="t" brand="blog0" brandName="Blog Zero" />);
    expect(html).toContain('Unsubscribe from Blog Zero?');
    expect(html).toContain('>Yes, unsubscribe me</button>');
    expect(html).toContain('You can sign up again any time.');
  });
});

describe('postLinkAction', () => {
  it('confirm: POSTs { token } and maps 200 to the success copy', async () => {
    const f = vi.fn().mockResolvedValue(res(200, { ok: true, data: { confirmed: true, alreadyConfirmed: false } }));
    const out = await postLinkAction('confirm', 'tok', f as unknown as typeof fetch);
    expect(out).toEqual({ kind: 'done' });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/newsletter/confirm');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ token: 'tok' });
  });

  it('unsubscribe: sends source email_link', async () => {
    const f = vi.fn().mockResolvedValue(res(200, { ok: true, data: { unsubscribed: true, alreadyUnsubscribed: false } }));
    expect(await postLinkAction('unsubscribe', 'tok', f as unknown as typeof fetch)).toEqual({ kind: 'done' });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/newsletter/unsubscribe');
    expect(JSON.parse(init.body as string)).toEqual({ token: 'tok', source: 'email_link' });
  });

  it('410 → expired, 404 → invalid, 429 → rate-limited with minutes from Retry-After', async () => {
    const mk = (r: Response) => postLinkAction('confirm', 't', vi.fn().mockResolvedValue(r) as unknown as typeof fetch);
    expect(await mk(res(410, { ok: false, error: { code: 'TOKEN_EXPIRED', message: 'x' } }))).toEqual({ kind: 'expired' });
    expect(await mk(res(404, { ok: false, error: { code: 'TOKEN_INVALID', message: 'x' } }))).toEqual({ kind: 'invalid' });
    expect(await mk(res(429, { ok: false, error: { code: 'RATE_LIMITED', message: 'x' } }, { 'retry-after': '125' }))).toEqual({ kind: 'rate_limited', minutes: 3 });
    expect(await mk(res(429, { ok: false, error: { code: 'RATE_LIMITED', message: 'x' } }))).toEqual({ kind: 'rate_limited', minutes: 1 });
  });

  it('a network error or a 500 is "failed" (button re-enabled by the component)', async () => {
    expect(await postLinkAction('confirm', 't', vi.fn().mockRejectedValue(new Error('down')) as unknown as typeof fetch)).toEqual({ kind: 'failed' });
    expect(await postLinkAction('confirm', 't', vi.fn().mockResolvedValue(res(500, { ok: false, error: { code: 'INTERNAL', message: 'x' } })) as unknown as typeof fetch)).toEqual({ kind: 'failed' });
  });
});

describe('outcomeCopy', () => {
  it('reuses the existing link-page copy', () => {
    expect(outcomeCopy('confirm', { kind: 'done' }, 'Blog Zero')).toEqual({ heading: LINK_COPY.confirmed.heading, body: LINK_COPY.confirmed.body('Blog Zero') });
    expect(outcomeCopy('unsubscribe', { kind: 'done' }, 'x').heading).toBe(LINK_COPY.unsubscribed.heading);
    expect(outcomeCopy('confirm', { kind: 'expired' }, 'x').heading).toBe(LINK_COPY.expired.heading);
    expect(outcomeCopy('confirm', { kind: 'invalid' }, 'x').heading).toBe(LINK_COPY.invalid.heading);
    expect(outcomeCopy('confirm', { kind: 'rate_limited', minutes: 2 }, 'x').body).toBe('Try the link again in 2 minutes.');
    expect(outcomeCopy('confirm', { kind: 'failed' }, 'x').body).toBe('Something went wrong — try again.');
  });

  it('declares the button labels', () => {
    expect(LINK_ACTIONS.confirm.button).toBe('Confirm my subscription');
    expect(LINK_ACTIONS.unsubscribe.button).toBe('Yes, unsubscribe me');
  });
});
