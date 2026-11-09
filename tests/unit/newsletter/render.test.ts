import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { IssuePost } from '@/lib/api/dto';
import { renderIntro } from '@/server/newsletter/issues/intro';
import {
  CONSENT_PLACEHOLDER,
  fillPlaceholders,
  renderIssueHtml,
  renderIssueText,
  UNSUBSCRIBE_PLACEHOLDER,
  type IssueRenderInput,
} from '@/server/newsletter/issues/render';
import { toListmonkExpressions } from '@/server/newsletter/sender';

// Issue rendering (spec/architecture.md §13.4): one model → HTML (single column, inline styles) and a
// text alternative built from the model; both carry the two provider placeholders exactly once.
// The 2-post text and HTML equal the committed fixtures tests/fixtures/newsletter/issue-2-posts.*.

const FIXTURES = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'newsletter');
const BASE = 'http://localhost:3410';

const posts: IssuePost[] = [
  {
    articleId: '00000000-0000-4000-8000-000000000001',
    slug: 'why-decks',
    title: 'Why decks <work>',
    dek: 'The strongest lines, in order.',
    excerpt: 'The deck shows the strongest lines of the article in order. Each slide holds exactly one sentence from the text.',
    topic: 'Analysis',
    publishedLabel: '8 Oct 2026',
    readUrl: `${BASE}/p/why-decks`,
    tldrUrl: `${BASE}/p/why-decks/tldr`,
    listenUrl: null,
  },
  {
    articleId: '00000000-0000-4000-8000-000000000002',
    slug: 'listen-first',
    title: 'Listen first',
    dek: '',
    excerpt: '',
    topic: 'Perspectives',
    publishedLabel: '10 Oct 2026',
    readUrl: `${BASE}/p/listen-first`,
    tldrUrl: null,
    listenUrl: `${BASE}/p/listen-first/listen`,
  },
];

function input(overrides: Partial<IssueRenderInput> = {}): IssueRenderInput {
  const intro = renderIntro('Two new pieces this week — *both* short. Read [the archive](https://example.com/archive).');
  return {
    brand: 'blog0',
    publisherName: 'smallTech',
    publicBaseUrl: BASE,
    title: 'blog0 · 2 new articles',
    introHtml: intro.html,
    introText: intro.text,
    posts,
    number: 7,
    year: 2026,
    postalAddress: '',
    privacyUrl: `${BASE}/privacy`,
    ...overrides,
  };
}

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('renderIssueText', () => {
  it('equals the committed 2-post fixture', () => {
    expect(renderIssueText(input())).toBe(readFileSync(path.join(FIXTURES, 'issue-2-posts.txt'), 'utf8'));
  });

  it('has each title and URL, no tags, Read always, TLDR / Listen only when published, both placeholders once', () => {
    const text = renderIssueText(input());
    for (const p of posts) {
      expect(text).toContain(p.title);
      expect(text).toContain(`Read: ${p.readUrl}`);
    }
    expect(text).toContain(`TLDR: ${BASE}/p/why-decks/tldr`);
    expect(text).toContain(`Listen: ${BASE}/p/listen-first/listen`);
    expect(text).not.toContain('TLDR: http://localhost:3410/p/listen-first');
    expect(text).not.toMatch(/<\/?(p|a|em|strong|table)\b/);
    expect(occurrences(text, UNSUBSCRIBE_PLACEHOLDER)).toBe(1);
    expect(occurrences(text, CONSENT_PLACEHOLDER)).toBe(1);
    expect(text).toContain('Read the archive (https://example.com/archive)');
  });
});

describe('renderIssueHtml', () => {
  it('equals the committed 2-post fixture', () => {
    expect(renderIssueHtml(input())).toBe(readFileSync(path.join(FIXTURES, 'issue-2-posts.html'), 'utf8'));
  });

  it('is a 600 px single-column presentation table with the brand, escaped titles, links and the footer', () => {
    const html = renderIssueHtml(input());
    expect(html).toContain('<table role="presentation" width="100%"');
    expect(html).toContain('max-width:600px');
    expect(html).toContain('blog<span style="color:#d64545;">0</span>');
    expect(html).toContain('Why decks &lt;work&gt;');
    expect(html).not.toContain('Why decks <work>');
    expect(html).toContain(`href="${BASE}/p/why-decks"`);
    expect(html).toMatch(/>Read<\/a>.*>TLDR<\/a>/s);
    expect(html).toMatch(/>Read<\/a>[^]*?>Listen<\/a>/);
    expect(occurrences(html, '>TLDR</a>')).toBe(1);
    expect(occurrences(html, '>Listen</a>')).toBe(1);
    expect(occurrences(html, UNSUBSCRIBE_PLACEHOLDER)).toBe(1);
    expect(occurrences(html, CONSENT_PLACEHOLDER)).toBe(1);
    expect(html).toContain('© 2026 blog0 | smallTech');
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain('<em>both</em>');
  });

  it('a post with an empty body renders the dek only; an empty intro renders no intro row', () => {
    const html = renderIssueHtml(input({ introHtml: '', introText: '', posts: [{ ...posts[0], excerpt: '' }] }));
    expect(html).toContain('The strongest lines, in order.');
    expect(html).not.toContain('font-size:16px;line-height:1.6;color:#1a1a1a;margin:0 0 12px;');
    expect(renderIssueText(input({ introHtml: '', introText: '' }))).not.toContain('Two new pieces');
  });
});

describe('issue footer: privacy link and postal address (fix pass)', () => {
  it('always links /privacy, in HTML and text', () => {
    expect(renderIssueHtml(input())).toContain(`<a href="${BASE}/privacy"`);
    expect(renderIssueText(input())).toContain(`Privacy: ${BASE}/privacy`);
  });

  it('renders the postal address only when non-empty (escaped in HTML, line breaks kept)', () => {
    const none = { html: renderIssueHtml(input()), text: renderIssueText(input()) };
    expect(none.html).not.toContain('Example Street');
    const blank = { html: renderIssueHtml(input({ postalAddress: '  \n ' })), text: renderIssueText(input({ postalAddress: '  \n ' })) };
    expect(blank).toEqual(none);

    const address = 'smallTech, 1 Example Street <Unit 2>\nMumbai 400001';
    const html = renderIssueHtml(input({ postalAddress: address }));
    const text = renderIssueText(input({ postalAddress: address }));
    expect(html).toContain('smallTech, 1 Example Street &lt;Unit 2&gt;<br>Mumbai 400001');
    expect(text).toContain(address);
    expect(occurrences(html, UNSUBSCRIBE_PLACEHOLDER)).toBe(1);
    expect(occurrences(text, CONSENT_PLACEHOLDER)).toBe(1);
  });
});

describe('fillPlaceholders / toListmonkExpressions', () => {
  it('fills per recipient, escaping for HTML only', () => {
    const values = { unsubscribeUrl: `${BASE}/newsletter/unsubscribe?t=a&b`, consentLine: 'You’re getting this because you subscribed at <b0>.' };
    const html = fillPlaceholders(renderIssueHtml(input()), values, 'html');
    const text = fillPlaceholders(renderIssueText(input()), values, 'text');
    expect(html).toContain('href="http://localhost:3410/newsletter/unsubscribe?t=a&amp;b"');
    expect(html).toContain('subscribed at &lt;b0&gt;.');
    expect(text).toContain(`Unsubscribe: ${values.unsubscribeUrl}`);
    expect(text).toContain(values.consentLine);
    expect(html).not.toContain('%%BLOG0_');
  });

  it('the Listmonk form swaps both placeholders for subscriber-attribute expressions', () => {
    const html = toListmonkExpressions(renderIssueHtml(input()));
    expect(html).toContain('href="{{ .Subscriber.Attribs.blog0_unsubscribe_url }}"');
    expect(html).toContain('{{ .Subscriber.Attribs.blog0_consent_line }}');
  });
});

describe('renderIntro', () => {
  it('keeps paragraphs, emphasis and safe links; drops code, images and raw HTML; escapes text', () => {
    const md = ['Hello **bold** and _em_ <script>x</script>', '', '```js\ncode()\n```', '', '![img](https://example.com/i.png)', '', '- one', '- [two](javascript:alert(1))'].join('\n');
    const out = renderIntro(md);
    expect(out.html).toContain('<strong>bold</strong>');
    expect(out.html).toContain('<em>em</em>');
    expect(out.html).not.toContain('<script>');
    expect(out.html).not.toContain('code()');
    expect(out.html).not.toContain('<img');
    expect(out.html).not.toContain('javascript:');
    expect(out.text).toBe('Hello bold and em x\n\n• one\n\n• two'); // the tags go, their text stays (escaped)
    expect(renderIntro('   ')).toEqual({ html: '', text: '' });
  });
});
