// Issue rendering (spec/architecture.md §13.4) — pure, no I/O. One model (`IssueRenderInput`) →
// a single-column, inline-styled HTML email and a plain-text alternative built from the same
// model (never from the HTML). Both bodies carry the two provider placeholders of
// `sender/types.ts` exactly once each; the stub sender, the test message and the preview fill them
// (`fillPlaceholders`), the Listmonk adapter rewrites them to template expressions.

import type { IssuePost } from '@/lib/api/dto';

import { esc, postalAddressLines } from '../mail/templates';
import { CONSENT_PLACEHOLDER, UNSUBSCRIBE_PLACEHOLDER } from '../sender/types';

export { CONSENT_PLACEHOLDER, UNSUBSCRIBE_PLACEHOLDER };

export interface IssueRenderInput {
  brand: string;
  publisherName: string;
  publicBaseUrl: string;
  title: string;
  /** The intro Markdown rendered to the email-safe inline subset (paragraphs, emphasis, links). */
  introHtml: string;
  /** The same intro as plain text. */
  introText: string;
  posts: IssuePost[];
  number: number;
  year: number;
  /** Site setting `newsletterPostalAddress` (fix pass): printed in the footer only when non-blank. */
  postalAddress: string;
  /** Absolute `<publicBaseUrl>/privacy`, linked in the footer (fix pass). */
  privacyUrl: string;
}

// Design tokens (light) and their dark-mode counterparts (the <style> block below).
const C = {
  page: '#f6f6f4',
  card: '#ffffff',
  border: '#e3e3df',
  ink: '#1a1a1a',
  muted: '#6b6b66',
  accent: '#d64545',
} as const;
const HEAD = "'Space Grotesk', 'Helvetica Neue', Arial, sans-serif";
const BODY = "'Source Serif 4', Georgia, serif";

const DARK_CSS = `@media (prefers-color-scheme: dark) {
  .b0-bg { background: #151514 !important; }
  .b0-card { background: #1d1d1b !important; border-color: #33332f !important; }
  .b0-ink { color: #ecebe6 !important; }
  .b0-muted { color: #a3a29b !important; }
  .b0-rule { border-color: #33332f !important; }
  .b0-link { color: #ff7a7a !important; }
}`;

function wordmark(brand: string): string {
  const chars = Array.from(brand);
  if (chars.length < 2) return `<span style="color:${C.accent};">${esc(brand)}</span>`;
  const last = chars.pop() as string;
  return `${esc(chars.join(''))}<span style="color:${C.accent};">${esc(last)}</span>`;
}

function postLinks(post: IssuePost): Array<{ label: 'Read' | 'TLDR' | 'Listen'; url: string }> {
  const links: Array<{ label: 'Read' | 'TLDR' | 'Listen'; url: string }> = [{ label: 'Read', url: post.readUrl }];
  if (post.tldrUrl) links.push({ label: 'TLDR', url: post.tldrUrl });
  if (post.listenUrl) links.push({ label: 'Listen', url: post.listenUrl });
  return links;
}

function eyebrow(post: IssuePost): string {
  return [post.topic, post.publishedLabel].filter((s) => s.trim() !== '').join(' · ');
}

function postHtml(post: IssuePost): string {
  const links = postLinks(post)
    .map((l) => `<a href="${esc(l.url)}" class="b0-link" style="color:${C.accent};text-decoration:none;font-weight:600;">${l.label}</a>`)
    .join(`<span class="b0-muted" style="color:${C.muted};"> · </span>`);
  const rows = [
    eyebrow(post)
      ? `<div class="b0-muted" style="font-family:${HEAD};font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${C.muted};margin:0 0 6px;">${esc(eyebrow(post))}</div>`
      : '',
    `<h2 style="font-family:${HEAD};font-size:20px;line-height:1.3;font-weight:700;margin:0 0 6px;"><a href="${esc(post.readUrl)}" class="b0-ink" style="color:${C.ink};text-decoration:none;">${esc(post.title)}</a></h2>`,
    post.dek ? `<p class="b0-muted" style="font-family:${BODY};font-size:16px;line-height:1.5;font-style:italic;color:${C.muted};margin:0 0 10px;">${esc(post.dek)}</p>` : '',
    post.excerpt ? `<p class="b0-ink" style="font-family:${BODY};font-size:16px;line-height:1.6;color:${C.ink};margin:0 0 12px;">${esc(post.excerpt)}</p>` : '',
    `<p style="font-family:${HEAD};font-size:14px;line-height:1.4;margin:0;">${links}</p>`,
  ].filter(Boolean);
  return `<tr><td class="b0-rule" style="padding:22px 32px;border-top:1px solid ${C.border};">
${rows.join('\n')}
</td></tr>`;
}

/** The footer address block (`line<br>line<br>\n`), or '' when the setting is blank. */
function addressHtml(address: string): string {
  const lines = postalAddressLines(address);
  return lines.length > 0 ? `${lines.map(esc).join('<br>')}<br>\n` : '';
}

/** The email HTML: contains UNSUBSCRIBE_PLACEHOLDER and CONSENT_PLACEHOLDER exactly once each. */
export function renderIssueHtml(input: IssueRenderInput): string {
  const intro = input.introHtml.trim()
    ? `<tr><td class="b0-ink" style="padding:4px 32px 18px;font-family:${BODY};font-size:16px;line-height:1.6;color:${C.ink};">${input.introHtml}</td></tr>\n`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(input.title)}</title>
<style>
${DARK_CSS}
</style>
</head>
<body class="b0-bg" style="margin:0;padding:0;background:${C.page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="b0-bg" style="background:${C.page};padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="b0-card" style="max-width:600px;background:${C.card};border:1px solid ${C.border};border-radius:4px;">
<tr><td class="b0-ink" style="padding:28px 32px 2px;font-family:${HEAD};font-size:22px;font-weight:700;letter-spacing:-.01em;color:${C.ink};"><a href="${esc(input.publicBaseUrl)}" class="b0-ink" style="color:${C.ink};text-decoration:none;">${wordmark(input.brand)}</a></td></tr>
<tr><td class="b0-muted" style="padding:0 32px 14px;font-family:${HEAD};font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${C.muted};">Issue #${input.number}</td></tr>
<tr><td class="b0-ink" style="padding:0 32px 14px;font-family:${HEAD};font-size:26px;line-height:1.25;font-weight:700;color:${C.ink};">${esc(input.title)}</td></tr>
${intro}${input.posts.map(postHtml).join('\n')}
<tr><td class="b0-rule b0-muted" style="padding:20px 32px 28px;border-top:1px solid ${C.border};font-family:${HEAD};font-size:13px;line-height:1.6;color:${C.muted};">
<a href="${UNSUBSCRIBE_PLACEHOLDER}" class="b0-muted" style="color:${C.muted};text-decoration:underline;">Unsubscribe</a> · <a href="${esc(input.privacyUrl)}" class="b0-muted" style="color:${C.muted};text-decoration:underline;">Privacy</a><br>
${CONSENT_PLACEHOLDER}<br>
${addressHtml(input.postalAddress)}© ${input.year} ${esc(input.brand)} | ${esc(input.publisherName)}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}

/** The plain-text alternative, from the model (not from the HTML). Same placeholders, once each. */
export function renderIssueText(input: IssueRenderInput): string {
  const lines: string[] = [`${input.brand} — Issue #${input.number}`, '', input.title];
  if (input.introText.trim()) lines.push('', input.introText.trim());
  for (const post of input.posts) {
    lines.push('', '———', '');
    if (eyebrow(post)) lines.push(eyebrow(post));
    lines.push(post.title);
    if (post.dek) lines.push(post.dek);
    if (post.excerpt) lines.push('', post.excerpt);
    lines.push('');
    for (const link of postLinks(post)) lines.push(`${link.label}: ${link.url}`);
  }
  lines.push('', '———', '', `Unsubscribe: ${UNSUBSCRIBE_PLACEHOLDER}`, `Privacy: ${input.privacyUrl}`, CONSENT_PLACEHOLDER);
  const address = postalAddressLines(input.postalAddress);
  if (address.length > 0) lines.push(...address);
  lines.push(`© ${input.year} ${input.brand} | ${input.publisherName}`, '');
  return lines.join('\n');
}

/** Per-recipient values for the two placeholders; HTML bodies get them escaped. */
export function fillPlaceholders(body: string, values: { unsubscribeUrl: string; consentLine: string }, format: 'html' | 'text' = 'html'): string {
  const enc = format === 'html' ? esc : (s: string) => s;
  return body.split(UNSUBSCRIBE_PLACEHOLDER).join(enc(values.unsubscribeUrl)).split(CONSENT_PLACEHOLDER).join(enc(values.consentLine));
}
