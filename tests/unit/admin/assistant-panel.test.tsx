import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AssistantPanel, statusText } from '@/components/admin/editor/AssistantPanel';
import type { WritingAssistant } from '@/components/admin/editor/use-writing-assistant';
import { parseComments } from '@/server/ai/assistant';

// SMA-43: the assistant panel's copy, and the server's cleaning of the model's comments.

const noop = () => {};
const NOW = new Date('2026-11-21T12:00:00Z');

function panel(a: Partial<WritingAssistant>): string {
  const assistant: WritingAssistant = { status: { kind: 'watching' }, rounds: [], on: true, setOn: noop, reviewNow: noop, ...a };
  return renderToStaticMarkup(<AssistantPanel assistant={assistant} timeZone="UTC" now={NOW} />);
}

describe('AssistantPanel', () => {
  it('links to the AI provider settings when no provider is set up, with the toggle disabled', () => {
    const html = panel({ status: { kind: 'unconfigured' } });
    expect(html).toContain('Set up an AI provider to use the assistant.');
    expect(html).toContain('href="/admin/site#ai"');
    expect(html).toMatch(/<input type="checkbox"[^>]*disabled=""/);
    expect(html).not.toContain('Review now');
  });

  it('shows the latest comments with their kind and quote, and earlier rounds collapsed', () => {
    const html = panel({
      rounds: [
        { at: NOW.getTime() - 120_000, trigger: 'words', comments: [{ kind: 'accuracy', quote: 'founded in 1998', text: 'It was founded in 1999.' }] },
        { at: NOW.getTime() - 600_000, trigger: 'sentence', comments: [{ kind: 'missing', quote: null, text: 'Add an example.' }] },
      ],
    });
    expect(html).toContain('Read 2 min ago');
    expect(html).toMatch(/<span class="assist__kind">Accuracy<\/span><q class="assist__quote">founded in 1998<\/q><p class="assist__text">It was founded in 1999.<\/p>/);
    expect(html).toContain('<summary>Earlier (1)</summary>');
    expect(html).toContain('Review now');
  });

  it('says what it is doing', () => {
    expect(statusText({ kind: 'watching' })).toMatch(/finished sentence .* about 40 changed words/);
    expect(statusText({ kind: 'reading', trigger: 'sentence' })).toBe('Reading your new sentence…');
    expect(statusText({ kind: 'off' })).toMatch(/^Off/);
    expect(statusText({ kind: 'error', message: 'down' })).toBe('Couldn’t read the draft: down');
  });
});

describe('parseComments', () => {
  it('keeps known kinds, trims, maps unknown kinds to note, drops empty text, caps the count', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ kind: 'clarity', quote: '', text: `c${i}` }));
    expect(parseComments(JSON.stringify({ comments: many }))).toHaveLength(6);
    expect(
      parseComments(
        JSON.stringify({ comments: [{ kind: 'rewrite', quote: ' q ', text: ' Say more. ' }, { kind: 'accuracy', text: '' }, 'junk'] }),
      ),
    ).toEqual([{ kind: 'note', quote: 'q', text: 'Say more.' }]);
  });

  it('accepts an empty list and a fenced reply; null for anything else', () => {
    expect(parseComments('{"comments":[]}')).toEqual([]);
    expect(parseComments('```json\n{"comments":[{"kind":"question","text":"Who said this?"}]}\n```')).toEqual([
      { kind: 'question', quote: null, text: 'Who said this?' },
    ]);
    expect(parseComments('Looks great!')).toBeNull();
    expect(parseComments('{"notes":[]}')).toBeNull();
  });
});
