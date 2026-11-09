// Share texts and target URLs — the one source (spec/capabilities/paragraph-share.md
// "Share texts"). Pure and isomorphic. The brand always arrives as an argument from the site
// record; it is never written into this module.

export type ShareKind = 'paragraph' | 'selection' | 'article' | 'deck';

/** What is being shared: the outgoing text (brand included) and its absolute link. */
export interface ShareSubject {
  kind: ShareKind;
  text: string;
  link: string;
}

export type ShareTargetKey = 'linkedin' | 'x' | 'whatsapp' | 'notes' | 'notion' | 'copy';

export interface ShareTarget {
  key: ShareTargetKey;
  label: string;
  /** Icon name in `components/design/Icon`. */
  icon: 'linkedin' | 'x' | 'chat' | 'note' | 'notion' | 'copy';
  /** `null` for Copy link (a button, not an anchor). */
  href: string | null;
  /** External web targets open in a new tab; Notes (mailto:) and Copy link do not. */
  newTab: boolean;
}

const enc = encodeURIComponent;
const DASH = ' — ';

/** `<absolute article url>#<pid>` — any fragment already on the URL is replaced. */
export function paragraphLink(articleUrl: string, pid: string): string {
  return articleUrl.split('#')[0] + '#' + pid;
}

/** A paragraph or a selection inside one: `“<quote>” — <brand>`. Whitespace is collapsed. */
export function quoteSubject(kind: 'paragraph' | 'selection', quote: string, link: string, brand: string): ShareSubject {
  const q = quote.replace(/\s+/g, ' ').trim();
  return { kind, text: '“' + q + '”' + DASH + brand, link };
}

/** The whole article: `<title> — <brand>`. */
export function articleSubject(title: string, link: string, brand: string): ShareSubject {
  return { kind: 'article', text: title + DASH + brand, link };
}

/** The TLDR deck: `<title> — TLDR — <brand>`. */
export function deckSubject(title: string, link: string, brand: string): ShareSubject {
  return { kind: 'deck', text: title + DASH + 'TLDR' + DASH + brand, link };
}

/** What lands on the clipboard the moment a share starts: text, newline, link. */
export function clipboardText(s: ShareSubject): string {
  return s.text + '\n' + s.link;
}

/** The payload for `navigator.share`. */
export function nativeShareData(s: ShareSubject, brand: string): { title: string; text: string; url: string } {
  return { title: brand, text: s.text, url: s.link };
}

/** The six menu options, in menu order. */
export function shareTargets(s: ShareSubject, brand: string): ShareTarget[] {
  return [
    {
      key: 'linkedin',
      label: 'LinkedIn',
      icon: 'linkedin',
      // LinkedIn ignores any text parameter; the text is already on the clipboard.
      href: 'https://www.linkedin.com/sharing/share-offsite/?url=' + enc(s.link),
      newTab: true,
    },
    {
      key: 'x',
      label: 'X',
      icon: 'x',
      href: 'https://x.com/intent/tweet?text=' + enc(s.text) + '&url=' + enc(s.link),
      newTab: true,
    },
    { key: 'whatsapp', label: 'WhatsApp', icon: 'chat', href: 'https://wa.me/?text=' + enc(s.text + ' ' + s.link), newTab: true },
    {
      key: 'notes',
      label: 'Notes',
      icon: 'note',
      href: 'mailto:?subject=' + enc('Saved from ' + brand) + '&body=' + enc(s.text + '\n\n' + s.link),
      newTab: false,
    },
    // Notion has no public prefill URL; the text is on the clipboard, so this opens Notion to paste into.
    { key: 'notion', label: 'Notion', icon: 'notion', href: 'https://www.notion.so/', newTab: true },
    { key: 'copy', label: 'Copy link', icon: 'copy', href: null, newTab: false },
  ];
}

/** The menu's `aria-label`. */
export function menuLabel(kind: ShareKind): string {
  if (kind === 'article') return 'Share this article';
  if (kind === 'deck') return 'Share this summary';
  return 'Share this passage';
}

/** The menu's status line: `copied` is `null` while the clipboard write is pending. */
export function shareStatus(kind: ShareKind, copied: boolean | null): string {
  if (copied === null) return 'Copying…';
  if (!copied) return 'Clipboard unavailable here — share below instead';
  return kind === 'article' || kind === 'deck' ? 'Copied — title and link' : 'Copied, with a link to this passage';
}
