import { describe, expect, it } from 'vitest';

import { confirmationEmail, esc, IGNORE_LINE } from '@/server/newsletter/mail/templates';

// The confirmation message (spec/architecture.md §13.2 templates.ts): HTML + text both carry the
// confirm URL, the expiry note, the consent line, the brand and the unsubscribe link; HTML escapes.

const INPUT = {
  brand: 'blog0',
  confirmUrl: 'http://localhost:3410/newsletter/confirm?t=abc_DEF-123',
  unsubscribeUrl: 'http://localhost:3410/newsletter/unsubscribe?t=xyz.sig',
  consentText: 'One issue a week at most. Unsubscribe in one click; we never share the list.',
  expiresHours: 72,
  publicBaseUrl: 'http://localhost:3410',
  postalAddress: '',
};

describe('confirmationEmail', () => {
  it('names the brand in the subject', () => {
    expect(confirmationEmail(INPUT).subject).toBe('Confirm your subscription to blog0');
  });

  it('HTML contains the confirm URL (button + raw link), the expiry note, the consent line, the brand and the unsubscribe link', () => {
    const { html } = confirmationEmail(INPUT);
    expect(html.split(INPUT.confirmUrl).length - 1).toBeGreaterThanOrEqual(2);
    expect(html).toContain('This link works for 72 hours.');
    expect(html).toContain(INPUT.consentText);
    expect(html).toContain('blog0');
    expect(html).toContain(INPUT.unsubscribeUrl);
    expect(html).toContain(IGNORE_LINE);
    expect(html).toMatch(/^<!doctype html>/);
  });

  it('text contains the same essentials without tags', () => {
    const { text } = confirmationEmail(INPUT);
    expect(text).toContain(INPUT.confirmUrl);
    expect(text).toContain('This link works for 72 hours.');
    expect(text).toContain(INPUT.consentText);
    expect(text).toContain('blog0');
    expect(text).toContain(`Unsubscribe: ${INPUT.unsubscribeUrl}`);
    expect(text).not.toMatch(/<[a-z]+[ >]/);
  });

  it('escapes HTML in the brand, consent text and URLs', () => {
    const { html, text } = confirmationEmail({
      ...INPUT,
      brand: 'a<b>&"c"',
      consentText: 'We <3 you & "yours"',
      confirmUrl: 'http://x/confirm?t=1&u=2',
    });
    expect(html).toContain('a&lt;b&gt;&amp;&quot;c&quot;');
    expect(html).toContain('We &lt;3 you &amp; &quot;yours&quot;');
    expect(html).toContain('href="http://x/confirm?t=1&amp;u=2"');
    expect(html).not.toContain('<b>');
    expect(text).toContain('http://x/confirm?t=1&u=2'); // text is raw
  });

  it('links /privacy in the HTML and text footers (fix pass)', () => {
    const { html, text } = confirmationEmail(INPUT);
    expect(html).toContain('href="http://localhost:3410/privacy"');
    expect(text).toContain('Privacy: http://localhost:3410/privacy');
  });

  it('prints the postal address only when it is set, escaped in HTML and raw in text (fix pass)', () => {
    const none = confirmationEmail(INPUT);
    const blank = confirmationEmail({ ...INPUT, postalAddress: '   ' });
    expect(none.html).not.toContain('Example Street');
    expect(blank.html).toBe(none.html);
    expect(blank.text).toBe(none.text);

    const set = confirmationEmail({ ...INPUT, postalAddress: 'smallTech, 1 Example Street <Unit 2>\nMumbai 400001' });
    expect(set.html).toContain('smallTech, 1 Example Street &lt;Unit 2&gt;<br>Mumbai 400001');
    expect(set.text).toContain('smallTech, 1 Example Street <Unit 2>\nMumbai 400001');
  });

  it('esc covers the five characters', () => {
    expect(esc(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
});
