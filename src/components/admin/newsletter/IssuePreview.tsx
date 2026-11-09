'use client';

import { useState } from 'react';

import type { IssuePreviewDto } from '@/lib/api/dto';

// Issue preview (spec/ui.md §4 "Issue" → Preview): tabs HTML / Text. The HTML is the email as sent,
// in an `<iframe sandbox srcdoc>` (empty sandbox: no scripts, no same-origin, links inert) with a
// light/dark toggle that sets `color-scheme` on the frame; Text is the plain alternative in a <pre>.

export type PreviewTab = 'html' | 'text';

export interface IssuePreviewProps {
  preview: IssuePreviewDto;
  tab: PreviewTab;
  onTab: (tab: PreviewTab) => void;
  /** the draft's posts changed when the preview re-snapshotted them */
  refreshed: boolean;
}

const TABS: ReadonlyArray<{ value: PreviewTab; label: string }> = [
  { value: 'html', label: 'HTML' },
  { value: 'text', label: 'Text' },
];

export function IssuePreview({ preview, tab, onTab, refreshed }: IssuePreviewProps) {
  const [scheme, setScheme] = useState<'light' | 'dark'>('light');

  return (
    <div className="issue-preview">
      <p className="admin-hint">Preview uses sample values for the unsubscribe link and consent line.</p>
      {refreshed ? <p className="admin-ok">Posts refreshed from their published versions.</p> : null}
      <p className="issue-preview__subject">
        <span className="admin-faint">Subject:</span> {preview.subject}
      </p>
      <div className="issue-preview__bar">
        <div className="modes" role="tablist" aria-label="Preview format">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              id={'issue-tab-' + t.value}
              aria-selected={tab === t.value}
              aria-controls="issue-tabpanel"
              className={tab === t.value ? 'mode is-on' : 'mode'}
              onClick={() => onTab(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'html' ? (
          <div className="modes" role="group" aria-label="Colour scheme">
            {(['light', 'dark'] as const).map((s) => (
              <button key={s} type="button" className={scheme === s ? 'mode is-on' : 'mode'} aria-pressed={scheme === s} onClick={() => setScheme(s)}>
                {s === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div id="issue-tabpanel" role="tabpanel" aria-labelledby={'issue-tab-' + tab}>
        {tab === 'html' ? (
          <iframe className="issue-preview__frame" sandbox="" srcDoc={preview.html} title="Issue preview" style={{ colorScheme: scheme }} />
        ) : (
          <pre className="issue-preview__text">{preview.text}</pre>
        )}
      </div>
    </div>
  );
}
