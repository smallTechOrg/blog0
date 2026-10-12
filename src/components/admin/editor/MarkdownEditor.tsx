'use client';

import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';

import { wordCount } from './fields';

// Plain monospace Markdown textarea (spec/architecture.md: swap for CodeMirror later behind this
// component). Tab inserts two spaces; Esc then Tab leaves the field, so keyboard users are never
// trapped.

export interface MarkdownEditorProps {
  id: string;
  value: string;
  onChange: (next: string) => void;
  maxLength: number;
  disabled?: boolean;
}

export function MarkdownEditor({ id, value, onChange, maxLength, disabled }: MarkdownEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const escaped = useRef(false);

  useLayoutEffect(() => {
    if (caret.current !== null && ref.current) {
      ref.current.setSelectionRange(caret.current, caret.current);
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
      <label className="admin-label" htmlFor={id}>
        Markdown
      </label>
      <textarea
        ref={ref}
        id={id}
        className="admin-input mdedit__area"
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
