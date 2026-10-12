import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ArticleTable } from '@/components/admin/ArticleTable';
import { HistoryTab } from '@/components/admin/editor/HistoryTab';
import { ImageUploadButton } from '@/components/admin/editor/ImageUploadButton';
import { LISTEN_STATUS_LABEL, ListenTab, liveLine, statusHelp, TEXT_CHANGED_WARNING, TIMING_NOTE } from '@/components/admin/editor/ListenTab';
import { MarkdownEditor } from '@/components/admin/editor/MarkdownEditor';
import { confirmLeave, LEAVE_EDITOR_CONFIRM, PublishBar } from '@/components/admin/editor/PublishBar';
import { AudioUploader, CONFIRM_REMOVE, UNSAVED_TEXT_HINT } from '@/components/admin/listen/AudioUploader';
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
    const html = renderToStaticMarkup(<ListenTab article={ARTICLE} editorDirty={false} timeZone="UTC" onArticleChanged={noop} />);
    expect(html).toContain('Loading the recording…');
  });

  const audio = {
    assetId: 'm1', key: 'blog0/audio/2026/10/x.mp3', url: '/media/blog0/audio/2026/10/x.mp3', mimeType: 'audio/mpeg' as const, bytes: 2_097_152,
    durationMs: 21_000, originalFilename: 'sample.mp3', uploadedAt: '2026-10-12T11:50:00Z', uploadedBy: 'Sai',
  };
  const base: ListenStateDto = {
    status: 'missing', revisionId: 'r1', paragraphs: [], audio: null, marks: [], timing: null, uploadFingerprint: null,
    textChangedSinceUpload: false, syncFingerprint: null, syncedAt: null, syncedBy: null, published: null,
    limits: { maxAudioMb: 50, maxAudioMinutes: 30 },
  };
  const now = new Date('2026-10-12T12:00:00Z');

  it('labels exactly the three Phase 3 fix statuses', () => {
    expect(LISTEN_STATUS_LABEL).toEqual({ missing: 'No recording', ready: 'Ready', text_changed: 'Text changed' });
  });

  it('writes one line of help per status with the limits and the uploader', () => {
    expect(statusHelp(base, now, 'UTC')).toBe(
      'Upload a word-for-word reading (mp3 or m4a, up to 50 MB / 30 min). Readers get it on the next publish.',
    );
    expect(statusHelp({ ...base, status: 'ready', audio, timing: 'estimated' }, now, 'UTC')).toBe(
      'Recording ready · uploaded 10 min ago by Sai. Readers get it on the next publish.',
    );
    expect(statusHelp({ ...base, status: 'text_changed', audio, timing: 'estimated', textChangedSinceUpload: true }, now, 'UTC')).toContain(
      'text changed',
    );
  });

  it('says what is live and whether it differs from the draft', () => {
    expect(liveLine(base, 'UTC')).toBeNull();
    const published = { durationMs: 150_000, publishedAt: '2026-10-10T09:00:00Z', sameAudioAsDraft: true };
    expect(liveLine({ published }, 'UTC')).toMatch(/^Live: 3 min recording, published .+2026$/);
    expect(liveLine({ published: { ...published, sameAudioAsDraft: false } }, 'UTC')).toMatch(/ · differs from the draft$/);
  });

  it('carries the non-blocking text-changed warning and both timing notes', () => {
    expect(TEXT_CHANGED_WARNING).toContain('The recording may no longer match the text');
    expect(TEXT_CHANGED_WARNING).toContain('Publishing is not blocked.');
    expect(TIMING_NOTE.estimated).toContain('estimated timing');
    expect(TIMING_NOTE.synced).toContain('paragraph timings saved for this recording');
  });
});

describe('AudioUploader', () => {
  const props = {
    articleId: 'a1', limits: { maxAudioMb: 50, maxAudioMinutes: 30 }, bylineName: 'Sai', timeZone: 'UTC', now: new Date('2026-10-12T12:00:00Z'),
    onUploaded: noop, onRemoved: noop, onRemove: async () => ({ ok: false as const, status: 0, error: { code: 'X', message: 'x' } }),
  };
  const audio = {
    assetId: 'm1', key: 'k.mp3', url: '/media/k.mp3', mimeType: 'audio/mpeg' as const, bytes: 1_048_576, durationMs: 21_000,
    originalFilename: 'sample.mp3', uploadedAt: '2026-10-12T11:50:00Z', uploadedBy: 'Sai',
  };

  it('offers the dropzone with the limits; disabled with the save-first hint while the text is unsaved', () => {
    const open = renderToStaticMarkup(<AudioUploader {...props} audio={null} editorDirty={false} />);
    expect(open).toContain('mp3 or m4a · up to 50 MB / 30 min');
    expect(open).toContain('accept="audio/mpeg,audio/mp4,.mp3,.m4a"');
    expect(open).not.toContain(UNSAVED_TEXT_HINT);
    expect(open).not.toContain('aria-disabled');

    const locked = renderToStaticMarkup(<AudioUploader {...props} audio={null} editorDirty />);
    expect(locked).toContain(UNSAVED_TEXT_HINT);
    expect(locked).toContain('aria-disabled="true"');
    expect(locked).toMatch(/<button[^>]*disabled[^>]*>choose a file<\/button>/);
  });

  it('with audio: the design player as preview, the file line, Replace… and Remove audio — no tap-along controls', () => {
    const html = renderToStaticMarkup(
      <AudioUploader {...props} audio={audio} editorDirty={false}>
        <p className="listentab__timing">note</p>
      </AudioUploader>,
    );
    expect(html).toContain('class="audio"');
    expect(html).toContain('class="audio__play"');
    expect(html).toContain('src="/media/k.mp3"');
    expect(html).toContain('Read by Sai · 1 min');
    expect(html).toContain('sample.mp3');
    expect(html).toContain('0:21');
    expect(html).toContain('Replace…');
    expect(html).toContain('Remove audio');
    expect(html).toContain('listentab__timing');
    expect(html).not.toMatch(/Start syncing|Save sync|Tap|nudge/i);
    expect(CONFIRM_REMOVE).toBe('Remove the recording? The published Listen keeps serving until you publish again.');

    const locked = renderToStaticMarkup(<AudioUploader {...props} audio={audio} editorDirty />);
    expect(locked).toMatch(/<button[^>]*disabled[^>]*>Replace…<\/button>/);
    expect(locked).toContain(UNSAVED_TEXT_HINT);
  });
});

describe('PublishBar', () => {
  it('lists blocking reasons without any Listen link (Listen never blocks publishing)', () => {
    const html = renderToStaticMarkup(
      <PublishBar
        article={ARTICLE}
        title="Hello"
        dirty={false}
        saveState={{ kind: 'idle' }}
        busy={null}
        blocked={[{ code: 'TLDR_DECK_STALE', message: 'The deck quotes lines that changed.', sids: ['s1'] }]}
        actionError={null}
        signInHref="/admin/login"
        onSave={noop}
        onPublish={noop}
        onUnpublish={noop}
        onDelete={noop}
        onDismissBlocked={noop}
      />,
    );
    expect(html).toContain('The deck quotes lines that changed.');
    expect(html).toContain('see the TLDR tab');
    expect(html).not.toContain('Go to Listen');
  });

  it('← Desk confirms only with unsaved text', () => {
    let asked = 0;
    expect(confirmLeave({ dirty: false }, () => (asked++, false))).toBe(true);
    expect(asked).toBe(0);
    const seen: string[] = [];
    expect(confirmLeave({ dirty: true }, (m) => (seen.push(m), false))).toBe(false);
    expect(confirmLeave({ dirty: true }, () => true)).toBe(true);
    expect(seen).toEqual([LEAVE_EDITOR_CONFIRM]);
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
  it('labels the History tab as a deferred stub (no phase number)', () => {
    const history = renderToStaticMarkup(<HistoryTab revisionCount={3} />);
    expect(history).toContain('3 revisions');
    expect(history).toContain('arrives in a later version.');
    expect(history).not.toContain('Phase');
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
