import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ModeCapsule } from '@/components/reader/ModeCapsule';
import { TldrDeck } from '@/components/reader/TldrDeck';
import { buildDeckSlides } from '@/lib/deck/timing';

// spec/ui.md §3 Listen: one mode switcher — the article capsule, the deck's foot and the card's
// Listen sheet — so a disabled Listen reads the same everywhere ("No recording yet").

const noop = () => {};

function tab(html: string, label: string): string {
  const m = new RegExp('<button[^>]*role="tab"[^>]*>(?:(?!</button>).)*' + label + '(?:(?!</button>).)*</button>').exec(html);
  if (!m) throw new Error('no tab ' + label + ' in ' + html);
  return m[0];
}

describe('ModeCapsule', () => {
  it('disables a mode without a time with its reason, and lights the active one', () => {
    const html = renderToStaticMarkup(<ModeCapsule active="read" times={{ read: 4, tldr: null, listen: null }} onPick={noop} />);
    expect(html).toContain('class="modes modes--timed"');
    expect(tab(html, 'Read')).toContain('aria-label="Read — 4 min"');
    expect(tab(html, 'Read')).toContain('class="mode is-on"');
    expect(tab(html, 'TLDR')).toMatch(/aria-label="TLDR — no summary yet"[^>]*disabled=""[^>]*title="No summary yet"/);
    expect(tab(html, 'Listen')).toMatch(/aria-label="Listen — no recording yet"[^>]*disabled=""[^>]*title="No recording yet"/);
  });

  it('takes an extra class and disables a timed mode that cannot be opened from here', () => {
    const html = renderToStaticMarkup(
      <ModeCapsule className="modes--deck" active="tldr" times={{ read: 4, tldr: 1, listen: 2 }} enabled={{ read: false }} onPick={noop} />,
    );
    expect(html).toContain('class="modes modes--deck modes--timed"');
    expect(tab(html, 'Read')).toMatch(/aria-label="Read — 4 min"[^>]*disabled=""/);
    expect(tab(html, 'Read')).not.toContain('title=');
    expect(tab(html, 'Listen')).not.toContain('disabled');
  });
});

describe('TldrDeck mode switcher', () => {
  const slides = buildDeckSlides('A title', 'A dek', ['One line.', 'Two lines.']);

  it('without a recording, Listen carries the capsule’s copy: "No recording yet"', () => {
    const html = renderToStaticMarkup(<TldrDeck slides={slides} title="A title" times={{ read: 3, tldr: 1, listen: null }} onClose={noop} onRead={noop} />);
    const listen = tab(html, 'Listen');
    expect(listen).toContain('aria-label="Listen — no recording yet"');
    expect(listen).toContain('title="No recording yet"');
    expect(listen).toContain('disabled=""');
    expect(html).not.toContain('later phase');
    expect(html).toContain('class="modes modes--deck modes--timed"');
    expect(tab(html, 'TLDR')).toMatch(/class="mode is-on"[^>]*aria-selected="true"[^>]*aria-label="TLDR — 1 min"/);
  });

  it('with a recording and a way to open it, Listen shows its minutes and is enabled', () => {
    const html = renderToStaticMarkup(
      <TldrDeck slides={slides} title="A title" times={{ read: 3, tldr: 1, listen: 2 }} onClose={noop} onRead={noop} onListen={noop} />,
    );
    const listen = tab(html, 'Listen');
    expect(listen).toContain('aria-label="Listen — 2 min"');
    expect(listen).not.toContain('disabled');
    expect(listen).not.toContain('title=');
  });
});
