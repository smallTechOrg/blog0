'use client';

import { useRef, useState } from 'react';

import type { ArticleDetailDto } from '@/lib/api/dto';
import { ARTICLE_LIMITS } from '@/lib/articles/limits';

import { AssistantPanel } from './AssistantPanel';
import type { EditorFields } from './fields';
import { LivePreview } from './LivePreview';
import { ImageUploadButton, type ImageUploadHandle } from './ImageUploadButton';
import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor';
import { usePasteImages } from './use-paste-images';
import { useWritingAssistant } from './use-writing-assistant';

// Write tab (spec/ui.md §4): Title, Dek, Topic; Settings disclosure (slug, byline (read-only), featured,
// in-progress badge); Markdown left + a side column right at ≥ 1100 px holding the live preview or the
// writing assistant (SMA-43; tabs Preview / Assistant), a Write / Preview / Assistant toggle below
// that (admin.css switches on `data-pane` and `data-side`). The assistant keeps watching the draft
// whichever view is showing. The Image button sits in the editor's toolbar
// slot; files dropped on the textarea go to the same queue. Field limits = the API's (ARTICLE_LIMITS).

export interface WriteTabProps {
  article: ArticleDetailDto;
  fields: EditorFields;
  onField: <K extends keyof EditorFields>(key: K, value: EditorFields[K]) => void;
  dateLabel: string;
  timeZone: string;
}

export function WriteTab({ article, fields, onField, dateLabel, timeZone }: WriteTabProps) {
  const [pane, setPane] = useState<'write' | 'side'>('write');
  const [side, setSide] = useState<'preview' | 'assistant'>('preview');
  const assistant = useWritingAssistant({ articleId: article.id, title: fields.title, dek: fields.dek, bodyMd: fields.bodyMd });
  const fresh = assistant.rounds[0]?.comments.length ?? 0;
  function show(next: 'write' | 'preview' | 'assistant'): void {
    if (next === 'write') setPane('write');
    else {
      setPane('side');
      setSide(next);
    }
  }
  const id = article.id;
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const imageRef = useRef<ImageUploadHandle>(null);
  const paste = usePasteImages(id, editorRef, imageRef);

  return (
    <div className="writetab">
      <div className="writetab__meta">
        <label className="admin-field writetab__title">
          <span className="admin-label">Title</span>
          <input
            className="admin-input admin-input--title"
            value={fields.title}
            maxLength={ARTICLE_LIMITS.title}
            required
            onChange={(e) => onField('title', e.target.value)}
          />
        </label>
        <label className="admin-field writetab__dek">
          <span className="admin-label">Dek</span>
          <textarea
            className="admin-input admin-input--dek"
            rows={2}
            value={fields.dek}
            maxLength={ARTICLE_LIMITS.dek}
            onChange={(e) => onField('dek', e.target.value)}
          />
        </label>
        <label className="admin-field writetab__topic">
          <span className="admin-label">Topic</span>
          <input
            className="admin-input"
            value={fields.topic}
            list={`topics-${id}`}
            maxLength={ARTICLE_LIMITS.topic}
            onChange={(e) => onField('topic', e.target.value)}
          />
          <datalist id={`topics-${id}`}>
            {article.topics.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
      </div>

      <details className="settings">
        <summary className="settings__sum">Settings</summary>
        <div className="settings__body">
          <label className="admin-field">
            <span className="admin-label">Slug</span>
            <span className="settings__slug">
              <span className="admin-faint mono">/p/</span>
              <input
                className="admin-input mono"
                value={fields.slug}
                maxLength={ARTICLE_LIMITS.slug}
                disabled={article.slugLocked}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                onChange={(e) => onField('slug', e.target.value)}
                aria-describedby={`slug-note-${id}`}
              />
            </span>
            <span className="admin-hint" id={`slug-note-${id}`}>
              {article.slugLocked
                ? 'Locked — the slug cannot change after the first publish.'
                : 'Lowercase words joined by hyphens. Follows the title until you edit it; locks at first publish.'}
            </span>
          </label>
          <label className="admin-field">
            <span className="admin-label">Byline</span>
            <input
              className="admin-input"
              value={article.bylineName}
              readOnly
              aria-describedby={`byline-note-${id}`}
            />
            <span className="admin-hint" id={`byline-note-${id}`}>
              The author’s name. To change it, change the author’s display name.
            </span>
          </label>
          <div className="settings__row">
            <label className="admin-check">
              <input
                type="checkbox"
                checked={fields.isFeatured}
                onChange={(e) => onField('isFeatured', e.target.checked)}
              />
              Featured
            </label>
            <label className="admin-field admin-field--inline">
              <span className="admin-label">Rank</span>
              <input
                className="admin-input admin-input--num"
                type="number"
                min={1}
                max={99}
                disabled={!fields.isFeatured}
                value={fields.featuredRank ?? ''}
                onChange={(e) =>
                  onField(
                    'featuredRank',
                    e.target.value === '' ? null : Math.max(1, Math.trunc(Number(e.target.value))),
                  )
                }
              />
            </label>
          </div>
          <label className="admin-check">
            <input
              type="checkbox"
              checked={fields.inProgress}
              onChange={(e) => onField('inProgress', e.target.checked)}
            />
            Show ‘Draft — in progress’ badge
          </label>
          <label className="admin-check">
            <input
              type="checkbox"
              checked={fields.mediaOnly}
              onChange={(e) => onField('mediaOnly', e.target.checked)}
            />
            Slideshow only — readers get just the TLDR deck (images and short lines), no article text or Listen
          </label>
        </div>
      </details>

      <div className="split" data-pane={pane} data-side={side}>
        <div className="split__toggle modes" role="group" aria-label="Show">
          <button type="button" className={pane === 'write' ? 'mode is-on' : 'mode'} aria-pressed={pane === 'write'} onClick={() => show('write')}>
            Write
          </button>
          <button
            type="button"
            className={pane === 'side' && side === 'preview' ? 'mode is-on' : 'mode'}
            aria-pressed={pane === 'side' && side === 'preview'}
            onClick={() => show('preview')}
          >
            Preview
          </button>
          <button
            type="button"
            className={pane === 'side' && side === 'assistant' ? 'mode is-on' : 'mode'}
            aria-pressed={pane === 'side' && side === 'assistant'}
            onClick={() => show('assistant')}
          >
            Assistant{fresh > 0 ? <span className="tabchip">{fresh}</span> : null}
          </button>
        </div>
        <div className="split__write">
          <MarkdownEditor
            ref={editorRef}
            id={`md-${id}`}
            value={fields.bodyMd}
            onChange={(v) => onField('bodyMd', v)}
            maxLength={ARTICLE_LIMITS.body}
            onDropFiles={(files) => imageRef.current?.addFiles(files)}
            onPasteContent={paste.onPaste}
            tools={
              <>
                <ImageUploadButton
                  ref={imageRef}
                  articleId={id}
                  onBegin={() => editorRef.current?.markInsertion() ?? 0}
                  onInsert={(snippet, mark) => {
                    const editor = editorRef.current;
                    if (!editor) return;
                    if (mark !== null) editor.insertAtMark(mark, snippet);
                    else editor.insertAtCursor(snippet);
                  }}
                  onRelease={(mark) => editorRef.current?.releaseMark(mark)}
                />
                {paste.status ? (
                  <p
                    className={
                      paste.status.kind === 'error' ? 'admin-error mdedit__note' : 'admin-hint mdedit__note'
                    }
                    role={paste.status.kind === 'error' ? 'alert' : 'status'}
                  >
                    {paste.status.text}
                  </p>
                ) : null}
              </>
            }
          />
        </div>
        <div className="split__side">
          <div className="split__sidetabs modes" role="group" aria-label="Side panel">
            <button type="button" className={side === 'preview' ? 'mode is-on' : 'mode'} aria-pressed={side === 'preview'} onClick={() => setSide('preview')}>
              Preview
            </button>
            <button
              type="button"
              className={side === 'assistant' ? 'mode is-on' : 'mode'}
              aria-pressed={side === 'assistant'}
              onClick={() => setSide('assistant')}
            >
              Assistant{fresh > 0 ? <span className="tabchip">{fresh}</span> : null}
            </button>
          </div>
          <div className="split__preview">
            <LivePreview
              title={fields.title}
              dek={fields.dek}
              bodyMd={fields.bodyMd}
              topic={fields.topic}
              bylineName={article.bylineName}
              inProgress={fields.inProgress}
              dateLabel={dateLabel}
            />
          </div>
          <div className="split__assist">
            <AssistantPanel assistant={assistant} timeZone={timeZone} />
          </div>
        </div>
      </div>
    </div>
  );
}
