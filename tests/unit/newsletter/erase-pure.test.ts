import { describe, expect, it } from 'vitest';

import { failureReason, isErasedEmail, redactConfirmUrl, REDACTED_TOKEN } from '@/server/newsletter/erase';
import { confirmationEmail } from '@/server/newsletter/mail/templates';

// Pure helpers of the fix pass: token redaction for stored confirmation messages and tombstone detection.

const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF123_-aaa';

describe('redactConfirmUrl', () => {
  it('replaces the t value of every /newsletter/confirm?t= link, in HTML and text, leaving the rest alone', () => {
    const mail = confirmationEmail({
      brand: 'blog0',
      confirmUrl: `http://localhost:3410/newsletter/confirm?t=${TOKEN}`,
      unsubscribeUrl: 'http://localhost:3410/newsletter/unsubscribe?t=xyz.sig',
      consentText: 'consent',
      expiresHours: 72,
      publicBaseUrl: 'http://localhost:3410',
      postalAddress: '',
    });
    const html = redactConfirmUrl(mail.html);
    const text = redactConfirmUrl(mail.text);
    expect(html).not.toContain(TOKEN);
    expect(text).not.toContain(TOKEN);
    expect(html.split('/newsletter/confirm?t=[redacted]').length - 1).toBeGreaterThanOrEqual(2);
    expect(text).toContain('http://localhost:3410/newsletter/confirm?t=[redacted]');
    expect(html).toContain('/newsletter/unsubscribe?t=xyz.sig');
    expect(REDACTED_TOKEN).toBe('[redacted]');
  });

  it('handles an escaped query (&amp;) and a percent-encoded token, and is idempotent', () => {
    const body = `<a href="http://x/newsletter/confirm?t=${encodeURIComponent('a+b/c=')}&amp;u=1">x</a> http://x/newsletter/confirm?t=${TOKEN} end`;
    const once = redactConfirmUrl(body);
    expect(once).toBe('<a href="http://x/newsletter/confirm?t=[redacted]&amp;u=1">x</a> http://x/newsletter/confirm?t=[redacted] end');
    expect(redactConfirmUrl(once)).toBe(once);
  });

  it('leaves text without a confirm link unchanged', () => {
    expect(redactConfirmUrl('nothing to see')).toBe('nothing to see');
  });
});

describe('isErasedEmail', () => {
  it('recognises the tombstone and nothing else', () => {
    expect(isErasedEmail(`erased+${'a'.repeat(64)}@erased.invalid`)).toBe(true);
    expect(isErasedEmail('reader@example.com')).toBe(false);
    expect(isErasedEmail('erased+x@example.com')).toBe(false);
  });
});

describe('failureReason (the named error of a refused deletion)', () => {
  it('unwraps a drizzle "Failed query" error to the driver message, first line only, with no address', () => {
    const driver = new Error('duplicate key value violates unique constraint "newsletter_subscriber_site_email_unique"\nDETAIL: Key (email)=(reader@example.com) exists.');
    const wrapped = new Error("Failed query: select newsletter_erase_subscriber($1::uuid, $2::uuid) as r\nparams: 1,2", { cause: driver });
    expect(failureReason(wrapped)).toBe('duplicate key value violates unique constraint "newsletter_subscriber_site_email_unique"');
    expect(failureReason(new Error('could not reach reader@example.com'))).toBe('could not reach [email]');
    expect(failureReason('plain')).toBe('plain');
    expect(failureReason(new Error(''))).toBe('unknown error');
  });
});
