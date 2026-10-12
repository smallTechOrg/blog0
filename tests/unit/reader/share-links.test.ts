import { describe, expect, it } from 'vitest';

import {
  articleSubject,
  clipboardText,
  deckSubject,
  menuLabel,
  nativeShareData,
  paragraphLink,
  quoteSubject,
  shareStatus,
  shareTargets,
} from '@/lib/share-links';

// spec/capabilities/paragraph-share.md "Share texts" — every URL/text exactly as the tables say.

const B = 'blog0';
const ARTICLE = 'https://blog0.example/p/ab-tests';
const QUOTE = 'Tom & Jerry’s #1 rule: don’t ship it 🚀';
const enc = encodeURIComponent;

describe('paragraphLink', () => {
  it('appends the paragraph id as the fragment of the absolute article URL', () => {
    expect(paragraphLink(ARTICLE, 'p-0a1b2c3d')).toBe(ARTICLE + '#p-0a1b2c3d');
  });
  it('replaces any fragment the article URL already carries', () => {
    expect(paragraphLink(ARTICLE + '#p-ffffffff', 'p-0a1b2c3d-2')).toBe(ARTICLE + '#p-0a1b2c3d-2');
  });
});

describe('subjects', () => {
  it('paragraph: “quote” — brand, link to the paragraph', () => {
    const s = quoteSubject('paragraph', QUOTE, paragraphLink(ARTICLE, 'p-12345678'), B);
    expect(s).toEqual({ kind: 'paragraph', text: '“' + QUOTE + '” — blog0', link: ARTICLE + '#p-12345678' });
    expect(clipboardText(s)).toBe('“' + QUOTE + '” — blog0\n' + ARTICLE + '#p-12345678');
  });

  it('selection: collapses whitespace (line breaks from the DOM) and trims', () => {
    const s = quoteSubject('selection', '  half a\n   sentence\t ', ARTICLE + '#p-12345678', B);
    expect(s.kind).toBe('selection');
    expect(s.text).toBe('“half a sentence” — blog0');
  });

  it('article: <title> — brand, the article link', () => {
    const s = articleSubject('A/B tests & you', ARTICLE, B);
    expect(s).toEqual({ kind: 'article', text: 'A/B tests & you — blog0', link: ARTICLE });
    expect(clipboardText(s)).toBe('A/B tests & you — blog0\n' + ARTICLE);
  });

  it('deck: <title> — TLDR — brand, the deck link', () => {
    const s = deckSubject('A/B tests & you', ARTICLE + '/tldr', B);
    expect(s).toEqual({ kind: 'deck', text: 'A/B tests & you — TLDR — blog0', link: ARTICLE + '/tldr' });
    expect(clipboardText(s)).toBe('A/B tests & you — TLDR — blog0\n' + ARTICLE + '/tldr');
  });

  it('the brand is an argument, never baked in', () => {
    expect(articleSubject('T', ARTICLE, 'otherbrand').text).toBe('T — otherbrand');
    expect(deckSubject('T', ARTICLE, 'x0').text).toBe('T — TLDR — x0');
  });
});

describe('shareTargets', () => {
  const s = quoteSubject('paragraph', QUOTE, ARTICLE + '#p-12345678', B);
  const t = shareTargets(s, B);

  it('lists the six options in order LinkedIn, X, WhatsApp, Notes, Notion, Copy link', () => {
    expect(t.map((o) => o.label)).toEqual(['LinkedIn', 'X', 'WhatsApp', 'Notes', 'Notion', 'Copy link']);
    expect(t.map((o) => o.icon)).toEqual(['linkedin', 'x', 'chat', 'note', 'notion', 'copy']);
  });

  it('builds each target URL exactly', () => {
    const by = Object.fromEntries(t.map((o) => [o.key, o]));
    expect(by.linkedin.href).toBe('https://www.linkedin.com/sharing/share-offsite/?url=' + enc(s.link));
    expect(by.x.href).toBe('https://x.com/intent/tweet?text=' + enc(s.text) + '&url=' + enc(s.link));
    expect(by.whatsapp.href).toBe('https://wa.me/?text=' + enc(s.text + ' ' + s.link));
    expect(by.notes.href).toBe('mailto:?subject=' + enc('Saved from blog0') + '&body=' + enc(s.text + '\n\n' + s.link));
    expect(by.notion.href).toBe('https://www.notion.so/');
    expect(by.copy.href).toBeNull();
  });

  it('encodes &, #, apostrophes and emoji so nothing leaks into the query string', () => {
    const x = t.find((o) => o.key === 'x')!.href!;
    expect(x).not.toContain('&J'); // the "&" in the quote is encoded
    expect(x).toContain('%26%20Jerry');
    expect(x).toContain('%231');
    expect(x).toContain('%F0%9F%9A%80'); // 🚀
    expect(decodeURIComponent(new URL(x).searchParams.get('text')!)).toBe(s.text);
    expect(new URL(x).searchParams.get('text')).toBe('“' + QUOTE + '” — blog0');
    expect(new URL(x).searchParams.get('url')).toBe(s.link);
  });

  it('opens web targets in a new tab and Notes in the same tab', () => {
    const tab = Object.fromEntries(t.map((o) => [o.key, o.newTab]));
    expect(tab).toEqual({ linkedin: true, x: true, whatsapp: true, notes: false, notion: true, copy: false });
  });

  it('uses the brand argument in the Notes subject', () => {
    const n = shareTargets(articleSubject('T', ARTICLE, 'zz'), 'zz').find((o) => o.key === 'notes')!;
    expect(n.href).toBe('mailto:?subject=' + enc('Saved from zz') + '&body=' + enc('T — zz\n\n' + ARTICLE));
  });

  it('builds the deck targets from the deck text and link', () => {
    const d = deckSubject('Deck title', ARTICLE + '/tldr', B);
    const wa = shareTargets(d, B).find((o) => o.key === 'whatsapp')!;
    expect(wa.href).toBe('https://wa.me/?text=' + enc('Deck title — TLDR — blog0 ' + ARTICLE + '/tldr'));
  });
});

describe('nativeShareData', () => {
  it('is { title: brand, text, url }', () => {
    const s = articleSubject('T', ARTICLE, B);
    expect(nativeShareData(s, B)).toEqual({ title: 'blog0', text: 'T — blog0', url: ARTICLE });
  });
});

describe('menu copy', () => {
  it('labels the dialog by subject', () => {
    expect(menuLabel('paragraph')).toBe('Share this passage');
    expect(menuLabel('selection')).toBe('Share this passage');
    expect(menuLabel('article')).toBe('Share this article');
    expect(menuLabel('deck')).toBe('Share this summary');
  });

  it('reports the clipboard state', () => {
    expect(shareStatus('paragraph', null)).toBe('Copying…');
    expect(shareStatus('paragraph', true)).toBe('Copied, with a link to this passage');
    expect(shareStatus('selection', true)).toBe('Copied, with a link to this passage');
    expect(shareStatus('article', true)).toBe('Copied — title and link');
    expect(shareStatus('deck', true)).toBe('Copied — title and link');
    expect(shareStatus('deck', false)).toBe('Clipboard unavailable here — share below instead');
  });
});
