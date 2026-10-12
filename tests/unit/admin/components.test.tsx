import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ArticleTable } from '@/components/admin/ArticleTable';
import { HistoryTab } from '@/components/admin/editor/HistoryTab';
import { ListenTab } from '@/components/admin/editor/ListenTab';
import { FormatChips } from '@/components/admin/FormatChips';
import { DeckList } from '@/components/admin/tldr/DeckList';
import { groupByHeading } from '@/components/admin/tldr/SentencePicker';
import type { ArticleListItemDto, FormatChipDto, SentenceDto } from '@/lib/api/dto';

const CHIPS: FormatChipDto[] = [
  { kind: 'read', status: 'ready', published: true, hasUnpublishedChanges: false },
  { kind: 'tldr', status: 'stale', published: true, hasUnpublishedChanges: true },
  { kind: 'listen', status: 'unavailable', published: false, hasUnpublishedChanges: false },
];

describe('FormatChips', () => {
  it('renders one chip per registered format with its status', () => {
    const html = renderToStaticMarkup(<FormatChips formats={CHIPS} />);

    expect(html).toContain('Read ✓');
    expect(html).toContain('TLDR stale');
    expect(html).toContain('Listen later phase');
    expect(html).toContain('data-status="unavailable"');
    expect(html).toContain('Listen arrives in Phase 3');
  });
});

describe('ArticleTable', () => {
  it('links each title to its editor and shows status, chips and who updated it', () => {
    const item: ArticleListItemDto = {
      id: 'a1', slug: 'hello', title: 'Hello <world>', topic: 'AI', status: 'published', formats: CHIPS,
      hasUnpublishedChanges: true, updatedAt: '2026-10-12T11:50:00Z', updatedBy: 'Sai', firstPublishedAt: '2026-10-01T00:00:00Z',
    };

    const html = renderToStaticMarkup(<ArticleTable articles={[item]} timeZone="UTC" now={new Date('2026-10-12T12:00:00Z')} />);

    expect(html).toContain('href="/admin/articles/a1"');
    expect(html).toContain('Hello &lt;world&gt;');
    expect(html).toContain('Published · unpublished changes');
    expect(html).toContain('10 min ago');
    expect(html).toContain(' by Sai');
  });
});

describe('DeckList', () => {
  it('numbers lines, labels the source and flags vanished lines with labelled controls', () => {
    const html = renderToStaticMarkup(
      <DeckList
        lines={[
          { sid: 's1', text: 'First line.', source: 'jev', reason: 'Sets the thesis', missing: false },
          { sid: 's2', text: 'Second line.', source: 'writer', reason: null, missing: true },
        ]}
        onMove={() => {}}
        onRemove={() => {}}
      />,
    );

    expect(html).toContain('>01<');
    expect(html).toContain('Jev: Sets the thesis');
    expect(html).toContain('Added by you');
    expect(html).toContain('No longer in the article');
    expect(html).toContain('aria-label="Move line 1 up"');
    expect(html).toContain('aria-label="Remove line 2"');
  });
});

describe('editor stubs', () => {
  it('labels the Listen and History tabs as later-phase stubs', () => {
    expect(renderToStaticMarkup(<ListenTab />)).toContain('Coming in a later phase');
    const history = renderToStaticMarkup(<HistoryTab revisionCount={3} />);
    expect(history).toContain('3 revisions');
    expect(history).toContain('Phase 4');
  });
});

describe('groupByHeading', () => {
  it('groups consecutive sentences under their heading path', () => {
    const s = (i: number, h: string[]): SentenceDto => ({ sid: `s${i}`, index: i, pid: 'p', text: 't', words: 5, headingPath: h });

    const groups = groupByHeading([s(0, []), s(1, ['Intro']), s(2, ['Intro']), s(3, ['Intro', 'Detail'])]);

    expect(groups.map((g) => [g.heading, g.items.length])).toEqual([
      ['', 1],
      ['Intro', 2],
      ['Intro › Detail', 1],
    ]);
  });
});
