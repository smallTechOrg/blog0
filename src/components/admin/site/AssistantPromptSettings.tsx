'use client';

import { useRef, useState, type FormEvent } from 'react';

import type { AssistantPromptDto, AssistantPromptResponse } from '@/lib/api/dto';
import { ASSISTANT_LIMITS } from '@/lib/api/dto';

import { AdminLoadError, useAdminLoad } from '../AdminLoad';
import { apiRequest } from '../api';
import { runExclusive } from '../editor/tldr-generate';

// Admin → Site → Writing assistant card (SMA-43): the instructions the editor's assistant follows.
// Free text; the server appends the output format, so editing it can't break the panel. "Reset to
// default" restores the built-in instructions. Anchored at #assistant.

const API = '/api/admin/ai/assistant';
const fetchPrompt = () => apiRequest<AssistantPromptResponse>(API);

export function AssistantPromptSettings() {
  const { load, setLoad, reload } = useAdminLoad(fetchPrompt);
  return (
    <section id="assistant" className="admin-card aiset" aria-labelledby="assistset-h">
      <h2 className="admin-card__title" id="assistset-h">
        Writing assistant
      </h2>
      <p className="admin-hint">
        While you write, the editor’s assistant reads your draft after each finished sentence or about 40 changed words and
        comments on it — accuracy, what to add, what is unclear. It never writes for you. These are its instructions.
      </p>
      {load.kind === 'loading' ? (
        <p className="admin-muted" role="status">
          Loading…
        </p>
      ) : null}
      {load.kind === 'error' ? <AdminLoadError error={load} what="the assistant settings" onRetry={reload} signInPath="/admin/site" small /> : null}
      {load.kind === 'ready' ? (
        <PromptForm saved={load.data.assistant} onSaved={(assistant) => setLoad({ kind: 'ready', data: { assistant } })} />
      ) : null}
    </section>
  );
}

function PromptForm({ saved, onSaved }: { saved: AssistantPromptDto; onSaved: (a: AssistantPromptDto) => void }) {
  const [text, setText] = useState(saved.prompt);
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const flight = useRef(false);
  const dirty = text.trim() !== saved.prompt.trim();

  async function put(prompt: string | null, done: string): Promise<void> {
    setSaving(true);
    const res = await apiRequest<AssistantPromptResponse>(API, { method: 'PUT', body: { prompt } });
    setSaving(false);
    if (!res.ok) {
      setNote({ tone: 'error', text: res.error.message });
      return;
    }
    onSaved(res.data.assistant);
    setText(res.data.assistant.prompt);
    setNote({ tone: 'ok', text: done });
  }

  function onSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    void runExclusive(flight, () => put(text.trim() || null, 'Saved — the assistant uses it from its next read.'));
  }

  function reset(): void {
    if (!window.confirm('Replace these instructions with the default ones?')) return;
    void runExclusive(flight, () => put(null, 'Back to the default instructions.'));
  }

  return (
    <form className="admin-form" onSubmit={onSubmit} noValidate aria-label="Writing assistant">
      <div className="admin-field">
        <label className="admin-label" htmlFor="assistant-prompt">
          Instructions {saved.isDefault ? <span className="admin-faint">(default)</span> : null}
        </label>
        <textarea
          id="assistant-prompt"
          className="admin-input"
          rows={12}
          maxLength={ASSISTANT_LIMITS.prompt}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setNote(null);
          }}
          disabled={saving}
          aria-describedby="assistant-prompt-hint"
        />
        <span className="admin-hint" id="assistant-prompt-hint">
          {text.length}/{ASSISTANT_LIMITS.prompt}. The reply format (short comments as JSON) is added automatically.
        </span>
      </div>
      <div className="admin-actions">
        <button type="submit" className="admin-btn admin-btn--primary" disabled={saving || !dirty} aria-busy={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="admin-btn" onClick={reset} disabled={saving || saved.isDefault}>
          Reset to default
        </button>
        <span aria-live="polite" data-testid="assistant-note">
          {note ? (
            <span className={note.tone === 'ok' ? 'admin-ok' : 'admin-error'} role={note.tone === 'error' ? 'alert' : undefined}>
              {note.text}
            </span>
          ) : null}
        </span>
      </div>
    </form>
  );
}
