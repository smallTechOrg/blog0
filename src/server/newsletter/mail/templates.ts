// Transactional mail templates (spec/architecture.md §13.2) — pure, no I/O. HTML is built with the
// tiny `esc()` helper, never with the Markdown pipeline. Single-column table, inline styles, a button
// plus the raw link (mail clients that strip buttons still get the URL).

export function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface ConfirmationEmailInput {
  brand: string;
  confirmUrl: string;
  unsubscribeUrl: string;
  consentText: string;
  expiresHours: number;
  publicBaseUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export const IGNORE_LINE = 'If you didn’t ask for this, ignore this email.';

export function confirmationEmail(input: ConfirmationEmailInput): RenderedEmail {
  const subject = `Confirm your subscription to ${input.brand}`;
  const expiry = `This link works for ${input.expiresHours} hours.`;
  const text = [
    `Confirm your subscription to ${input.brand}`,
    '',
    `Open this link to confirm:`,
    input.confirmUrl,
    '',
    expiry,
    IGNORE_LINE,
    '',
    input.consentText,
    '',
    `${input.brand} · ${input.publicBaseUrl}`,
    `Unsubscribe: ${input.unsubscribeUrl}`,
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f6f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f4;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e3e3df;border-radius:4px;">
<tr><td style="padding:28px 32px 8px;font-size:14px;letter-spacing:.04em;color:#6b6b66;">${esc(input.brand)}</td></tr>
<tr><td style="padding:0 32px 8px;font-size:22px;font-weight:600;line-height:1.3;">Confirm your subscription</td></tr>
<tr><td style="padding:0 32px 20px;font-size:16px;line-height:1.55;">One click and you’re in. ${esc(expiry)}</td></tr>
<tr><td style="padding:0 32px 20px;">
  <a href="${esc(input.confirmUrl)}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:12px 22px;border-radius:999px;">Confirm subscription</a>
</td></tr>
<tr><td style="padding:0 32px 20px;font-size:13px;line-height:1.5;color:#6b6b66;word-break:break-all;">Or paste this link into your browser:<br><a href="${esc(input.confirmUrl)}" style="color:#1a1a1a;">${esc(input.confirmUrl)}</a></td></tr>
<tr><td style="padding:0 32px 20px;font-size:14px;line-height:1.5;color:#6b6b66;">${esc(IGNORE_LINE)}</td></tr>
<tr><td style="padding:16px 32px 28px;border-top:1px solid #e3e3df;font-size:13px;line-height:1.5;color:#6b6b66;">
  ${esc(input.consentText)}<br>
  <a href="${esc(input.publicBaseUrl)}" style="color:#6b6b66;">${esc(input.brand)}</a> · <a href="${esc(input.unsubscribeUrl)}" style="color:#6b6b66;">Unsubscribe</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
  return { subject, html, text };
}
