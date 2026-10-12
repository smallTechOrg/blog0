'use client';

import { useImperativeHandle, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode, type Ref } from 'react';

import { wordCount } from './fields';
import { insertAtCursor } from './insert-image';

// Plain monospace Markdown textarea (spec/architecture.md: swap for CodeMirror later behind this
// component). Tab inserts two spaces; Esc then Tab leaves the field, so keyboard users are never
// trapped. Phase 3: a `.mdedit__tools` slot right of the label (the Image button), file drops on
// the textarea (handed to `onDropFiles`), and an imperative `insertAtCursor` for the snippet.

export interface MarkdownEditorHandle {
  /** Inserts `snippet` at the caret (replacing a selection) on its own lines; focuses the textarea with the caret after it. */
  insertAtCursor: (snippet: string) => void;
  focus: () => void;
}

export interface MarkdownEditorProps {
  id: string;
  value: string;
  onChange: (next: string) => void;
  maxLength: number;
  disabled?: boolean;
  /** Toolbar controls rendered right of the "Markdown" label (`.mdedit__tools`). */
  tools?: ReactNode;
  /** Files dropped on the textarea (when set, file drags show the `.is-dropping` outline). */
  onDropFiles?: (files: File[]) => void;
  ref?: Ref<MarkdownEditorHandle>;
}

function hasFiles(e: DragEvent<HTMLTextAreaElement>): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

export function MarkdownEditor({ id, value, onChange, maxLength, disabled, tools, onDropFiles, ref: handleRef }: MarkdownEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const escaped = useRef(false);
  const [dropping, setDropping] = useState(false);
  const latest = useRef({ value, onChange });
  useLayoutEffect(() => {
    latest.current = { value, onChange };
  });

  useImperativeHandle(
    handleRef,
    () => ({
      insertAtCursor(snippet: string) {
        const el = ref.current;
        const { value: current, onChange: change } = latest.current;
        const start = el ? el.selectionStart : current.length;
        const end = el ? el.selectionEnd : current.length;
        const next = insertAtCursor(current, start, end, snippet);
        caret.current = next.caret;
        change(next.value);
        el?.focus();
      },
      focus() {
        ref.current?.focus();
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    if (caret.current !== null && ref.current) {
      ref.current.setSelectionRange(caret.current, caret.current);
      if (document.activeElement !== ref.current) ref.current.focus();
      caret.current = null;
    }
  }, [value]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Escape') {
      escaped.current = true;
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !escaped.current) {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      caret.current = start + 2;
      onChange(value.slice(0, start) + '  ' + value.slice(end));
      return;
    }
    escaped.current = false;
  }

  const words = wordCount(value);
  const over = value.length > maxLength;

  return (
    <div className="mdedit">
      <div className="mdedit__bar">
        <label className="admin-label" htmlFor={id}>
          Markdown
        </label>
        {tools ? <div className="mdedit__tools">{tools}</div> : null}
      </div>
      <textarea
        ref={ref}
        id={id}
        className={dropping ? 'admin-input mdedit__area is-dropping' : 'admin-input mdedit__area'}
        onDragEnter={(e) => {
          if (onDropFiles && hasFiles(e)) setDropping(true);
        }}
        onDragOver={(e) => {
          if (!onDropFiles || !hasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          if (!dropping) setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          setDropping(false);
          if (!onDropFiles || !hasFiles(e)) return;
          e.preventDefault();
          const files = Array.from(e.dataTransfer.files);
          if (files.length) onDropFiles(files);
        }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        disabled={disabled}
        aria-describedby={`${id}-foot`}
        aria-invalid={over || undefined}
        placeholder={'# Paste or write Markdown here\n\nFigures: @@fig:slide47@@ or @@fig:ab-companies@@ on their own line.'}
      />
      <p className="mdedit__foot" id={`${id}-foot`}>
        <span>
          {words.toLocaleString('en-US')} {words === 1 ? 'word' : 'words'}
        </span>
        <span className="admin-faint">Tab inserts two spaces · Esc then Tab leaves the editor</span>
        {over ? (
          <span className="admin-error">
            Over the {maxLength.toLocaleString('en-US')}-character limit — saving will fail.
          </span>
        ) : null}
      </p>
    </div>
  );
}
