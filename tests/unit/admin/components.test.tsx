import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ArticleTable } from '@/components/admin/ArticleTable';
import { HistoryTab } from '@/components/admin/editor/HistoryTab';
import { ImageUploadButton } from '@/components/admin/editor/ImageUploadButton';
import { ListenTab, statusHelp } from '@/components/admin/editor/ListenTab';
import { MarkdownEditor } from '@/components/admin/editor/MarkdownEditor';
import { PublishBar } from '@/components/admin/editor/PublishBar';
import { MarkList } from '@/components/admin/listen/MarkList';
import { SyncPanel } from '@/components/admin/listen/SyncPanel';
import { FormatChips } from '@/components/admin/FormatChips';
import { DeckList } from '@/components/admin/tldr/DeckList';
import { groupByHeading } from '@/components/admin/tldr/SentencePicker';
import type { ArticleDetailDto, ArticleListItemDto, FormatChipDto, SentenceDto } from '@/lib/api/dto';
import type { ListenStateDto } from '@/lib/api/dto-phase3';

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

const ARTICLE: ArticleDetailDto = {
  id: 'a1', slug: 'hello', slugLocked: false, status: 'draft', topic: 'AI', bylineName: 'Sai', isFeatured: false, featuredRank: null,
  inProgress: false, firstPublishedAt: null, lastPublishedAt: null,
  currentRevision: { id: 'r1', number: 2, createdAt: '2026-10-12T11:00:00Z', createdBy: 'Sai', title: 'Hello', dek: '', bodyMd: 'Hi', wordCount: 1, eligibleSentenceCount: 0 },
  publishedRevisionId: null, revisionCount: 2, formats: CHIPS, topics: ['AI'], publicUrl: null,
};

const noop = () => {};

describe('ListenTab', () => {
  it('shows the loading state before GET …/listen answers', () => {
    const html = renderToStaticMarkup(
      <ListenTab
        article={ARTICLE}
        editorDirty={false}
        timeZone="UTC"
        saveFirst={async () => null}
        onArticleChanged={noop}
        onSelectTab={noop}
        onMarksDirty={noop}
      />,
    );
    expect(html).toContain('Loading the recording…');
  });

  it('writes one line of help per status with the limits and sync info', () => {
    const base: ListenStateDto = {
      status: 'missing', revisionId: 'r1', paragraphs: [], audio: null, marks: [], syncFingerprint: null, syncedAt: null, syncedBy: null,
      missingPids: [], orphanPids: [], published: null, limits: { maxAudioMb: 50, maxAudioMinutes: 30 },
    };
    const now = new Date('2026-10-12T12:00:00Z');
    expect(statusHelp(base, now, 'UTC')).toContain('up to 50 MB / 30 min');
    expect(statusHelp({ ...base, status: 'needs_sync' }, now, 'UTC')).toContain('Press Start syncing');
    const ready = statusHelp(
      { ...base, status: 'ready', marks: [{ pid: 'p1', tMs: 0 }, { pid: 'p2', tMs: 900 }], syncedAt: '2026-10-12T11:50:00Z', syncedBy: 'Sai' },
      now,
      'UTC',
    );
    expect(ready).toBe('Synced 2 paragraphs · 10 min ago by Sai');
  });
});

describe('SyncPanel', () => {
  const props = { paragraphCount: 3, currentMs: 61_250, onStart: noop, onTap: noop, onUndo: noop, onRestart: noop, onStop: noop };

  it('disables Start syncing with the save-first reason while the editor has unsaved text', () => {
    const html = renderToStaticMarkup(
      <SyncPanel {...props} state={{ phase: 'idle', times: [null, null, null], nextIndex: 0, lastTapAt: null }} hasAudio editorDirty busy={false} />,
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="start-syncing"/);
    expect(html).toContain('Save your text changes first');
  });

  it('shows the tap button, clock and next paragraph while syncing', () => {
    const html = renderToStaticMarkup(
      <SyncPanel {...props} state={{ phase: 'syncing', times: [0, null, null], nextIndex: 1, lastTapAt: 1 }} hasAudio editorDirty={false} busy={false} />,
    );
    expect(html).toContain('Tap — paragraph 2 starts now');
    expect(html).toContain('Next: paragraph 2 of 3');
    expect(html).toContain('1:01.250');
    expect(html).toContain('aria-keyshortcuts="Space"');
    expect(html).toContain('Space = tap · Backspace = undo');
  });
});

describe('MarkList', () => {
  it('marks the next row, shows times and flags unmarked stale paragraphs', () => {
    const paragraphs = [
      { pid: 'p1', index: 0, text: 'First paragraph.', kind: 'p' as const, headingPath: [] },
      { pid: 'p2', index: 1, text: 'Second paragraph.', kind: 'p' as const, headingPath: ['Intro'] },
    ];
    const html = renderToStaticMarkup(
      <MarkList
        paragraphs={paragraphs}
        state={{ phase: 'idle', times: [1500, null], nextIndex: 1, lastTapAt: null }}
        durationMs={10_000}
        missingPids={new Set(['p2'])}
        liveIndex={-1}
        issues={new Map()}
        disabled={false}
        onNudge={noop}
        onRedoFrom={noop}
        onPreview={noop}
      />,
    );
    expect(html).toContain('0:01.500');
    expect(html).toContain('no mark');
    expect(html).toContain('Intro');
    expect(html).toContain('aria-label="Nudge earlier (paragraph 1)"');
  });
});

describe('PublishBar', () => {
  it('offers Go to Listen next to a LISTEN_STALE reason', () => {
    const html = renderToStaticMarkup(
      <PublishBar
        article={ARTICLE}
        title="Hello"
        dirty={false}
        saveState={{ kind: 'idle' }}
        busy={null}
        blocked={[{ code: 'LISTEN_STALE', message: 'Listen needs a re-sync.', missingPids: ['p2'], orphanPids: [] }]}
        actionError={null}
        signInHref="/admin/login"
        onSave={noop}
        onPublish={noop}
        onUnpublish={noop}
        onDelete={noop}
        onDismissBlocked={noop}
        onGoToListen={noop}
      />,
    );
    expect(html).toContain('Listen needs a re-sync.');
    expect(html).toContain('Go to Listen');
  });
});

describe('Image toolbar', () => {
  it('renders the Image button with an image-only multi-file picker inside the editor tools slot', () => {
    const html = renderToStaticMarkup(
      <MarkdownEditor id="md" value="" onChange={noop} maxLength={100} tools={<ImageUploadButton articleId="a1" onInsert={noop} />} />,
    );
    expect(html).toContain('class="mdedit__tools"');
    expect(html).toContain('>Image</button>');
    expect(html).toContain('accept="image/png,image/jpeg,image/webp,image/gif"');
    expect(html).toContain('multiple');
  });
});

describe('editor stubs', () => {
  it('labels the History tab as a later-phase stub', () => {
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
