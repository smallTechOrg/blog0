'use client';

import { useRef, useState, type FormEvent } from 'react';

import type { AiProviderDto, AiProviderResponse, AiProviderTestResult } from '@/lib/api/dto';

import { AdminLoadError, useAdminLoad } from '../AdminLoad';
import { apiRequest } from '../api';
import { runExclusive } from '../editor/tldr-generate';
import { relativeTime } from '../relative-time';

// Admin → Site → AI provider card (SMA-44; spec/ui.md §4 "Site"): the OpenAI-compatible endpoint,
// model and API key every AI feature uses (TLDR ranking, the writing assistant). Nothing is set by
// default — AI stays off until all three are saved. The key is write-only: the card shows only
// "saved (…abcd)". Test makes one tiny real call with the form's values. A failing provider shows
// its last error here and as a banner across the desk. Anchored at #ai.

const PATH = '/admin/site';
const API = '/api/admin/ai';

const fetchProvider = () => apiRequest<AiProviderResponse>(API);

export const AI_ENDPOINT_EXAMPLES = 'e.g. https://api.openai.com/v1, https://openrouter.ai/api/v1 or http://localhost:11434/v1';

export function AiProviderSettings({ timeZone }: { timeZone: string }) {
  const { load, setLoad, reload } = useAdminLoad(fetchProvider);
  return (
    <section id="ai" className="admin-card aiset" aria-labelledby="aiset-h">
      <h2 className="admin-card__title" id="aiset-h">
        AI provider
      </h2>
      <p className="admin-hint">
        Any OpenAI-compatible chat endpoint. It ranks TLDR lines and powers the writing assistant. AI features stay off until an
        endpoint, a model and an API key are saved.
      </p>
      {load.kind === 'loading' ? (
        <p className="admin-muted" role="status">
          Loading AI provider…
        </p>
      ) : null}
      {load.kind === 'error' ? <AdminLoadError error={load} what="the AI provider" onRetry={reload} signInPath={PATH} small /> : null}
      {load.kind === 'ready' ? <AiProviderForm saved={load.data.ai} timeZone={timeZone} onSaved={(ai) => setLoad({ kind: 'ready', data: { ai } })} /> : null}
    </section>
  );
}

type Busy = { kind: 'idle' } | { kind: 'saving' } | { kind: 'testing' };
type Note = { tone: 'ok' | 'error'; text: string } | null;

export function testResultLine(r: AiProviderTestResult): { tone: 'ok' | 'error'; text: string } {
  if (!r.ok) return { tone: 'error', text: r.message };
  return {
    tone: r.jsonOk ? 'ok' : 'error',
    text: r.jsonOk
      ? `Works — ${r.model} answered in ${(r.latencyMs / 1000).toFixed(1)} s.`
      : `Reached ${r.model} (${(r.latencyMs / 1000).toFixed(1)} s), but it didn't answer valid JSON as asked — pick a model that follows JSON instructions.`,
  };
}

export function statusLine(ai: AiProviderDto, timeZone: string, now = new Date()): { tone: 'ok' | 'error' | 'muted'; text: string } {
  if (ai.keyUnreadable) return { tone: 'error', text: 'The saved key can’t be read (the server secret changed) — enter it again.' };
  if (!ai.configured) return { tone: 'muted', text: 'Not set up — AI features are off.' };
  const s = ai.status;
  if (s.failing && s.lastErrorAt) {
    return { tone: 'error', text: `Failing since ${relativeTime(s.lastErrorAt, now, timeZone)}: ${s.lastErrorMessage ?? s.lastErrorCode ?? 'unknown error'}` };
  }
  if (s.lastOkAt) return { tone: 'ok', text: `Working — last call ${relativeTime(s.lastOkAt, now, timeZone)}.` };
  return { tone: 'muted', text: 'Set up — no calls yet. Use Test to check it.' };
}

function AiProviderForm({ saved, timeZone, onSaved }: { saved: AiProviderDto; timeZone: string; onSaved: (ai: AiProviderDto) => void }) {
  const [baseUrl, setBaseUrl] = useState(saved.baseUrl);
  const [model, setModel] = useState(saved.model);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<Busy>({ kind: 'idle' });
  const [note, setNote] = useState<Note>(null);
  const flight = useRef(false);
  const dirty = baseUrl.trim() !== saved.baseUrl || model.trim() !== saved.model || apiKey.trim() !== '';
  const status = statusLine(saved, timeZone);

  function edit(set: (v: string) => void) {
    return (v: string) => {
      set(v);
      setNote(null);
    };
  }

  async function put(body: { baseUrl: string; model: string; apiKey?: string | null }, done: string): Promise<void> {
    setBusy({ kind: 'saving' });
    const res = await apiRequest<AiProviderResponse>(API, { method: 'PUT', body });
    setBusy({ kind: 'idle' });
    if (!res.ok) {
      setNote({ tone: 'error', text: res.error.message });
      return;
    }
    setApiKey('');
    onSaved(res.data.ai);
    setNote({ tone: 'ok', text: done });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void runExclusive(flight, async () => {
      if (!baseUrl.trim() || !model.trim()) {
        setNote({ tone: 'error', text: 'Enter the endpoint and the model.' });
        return;
      }
      if (!saved.keySet && !apiKey.trim()) {
        setNote({ tone: 'error', text: 'Enter the API key.' });
        return;
      }
      await put({ baseUrl: baseUrl.trim(), model: model.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }, 'Saved.');
    });
  }

  function removeKey(): void {
    if (!window.confirm('Remove the saved API key? AI features turn off until a key is saved again.')) return;
    void runExclusive(flight, () => put({ baseUrl: saved.baseUrl, model: saved.model, apiKey: null }, 'Key removed — AI features are off.'));
  }

  function test(): void {
    void runExclusive(flight, async () => {
      setBusy({ kind: 'testing' });
      setNote(null);
      const body = { baseUrl: baseUrl.trim() || undefined, model: model.trim() || undefined, apiKey: apiKey.trim() || undefined };
      const res = await apiRequest<AiProviderTestResult>(`${API}/test`, { method: 'POST', body });
      setBusy({ kind: 'idle' });
      if (!res.ok) {
        setNote({ tone: 'error', text: res.error.message });
        return;
      }
      setNote(testResultLine(res.data));
      // A test of the saved provider updates its status line.
      if (!dirty) void fetchProvider().then((r) => r.ok && onSaved(r.data.ai));
    });
  }

  const pending = busy.kind !== 'idle';
  return (
    <form className="admin-form aiset__form" onSubmit={onSubmit} noValidate aria-label="AI provider">
      <p className={`aiset__status aiset__status--${status.tone}`} data-testid="ai-status" role={status.tone === 'error' ? 'alert' : undefined}>
        {status.text}
      </p>
      <div className="admin-field">
        <label className="admin-label" htmlFor="ai-baseUrl">
          Endpoint
        </label>
        <input
          id="ai-baseUrl"
          className="admin-input"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://api.openai.com/v1"
          value={baseUrl}
          onChange={(e) => edit(setBaseUrl)(e.target.value)}
          disabled={pending}
          aria-describedby="ai-baseUrl-hint"
        />
        <span className="admin-hint" id="ai-baseUrl-hint">
          The OpenAI-compatible base URL ({AI_ENDPOINT_EXAMPLES}); blog0 calls <code>/chat/completions</code> on it.
        </span>
      </div>
      <div className="admin-field">
        <label className="admin-label" htmlFor="ai-model">
          Model
        </label>
        <input
          id="ai-model"
          className="admin-input"
          autoComplete="off"
          spellCheck={false}
          placeholder="gpt-4.1-mini"
          value={model}
          onChange={(e) => edit(setModel)(e.target.value)}
          disabled={pending}
        />
      </div>
      <div className="admin-field">
        <label className="admin-label" htmlFor="ai-apiKey">
          API key
        </label>
        <input
          id="ai-apiKey"
          className="admin-input"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          placeholder={saved.keySet ? `Saved (…${saved.keyHint ?? ''}) — type to replace` : 'sk-…'}
          value={apiKey}
          onChange={(e) => edit(setApiKey)(e.target.value)}
          disabled={pending}
          aria-describedby="ai-apiKey-hint"
        />
        <span className="admin-hint" id="ai-apiKey-hint">
          Stored encrypted; never shown again.
          {saved.keySet ? (
            <>
              {' '}
              <button type="button" className="admin-link" onClick={removeKey} disabled={pending}>
                Remove key
              </button>
            </>
          ) : null}
        </span>
      </div>
      <div className="admin-actions">
        <button type="submit" className="admin-btn admin-btn--primary" disabled={pending || !dirty} aria-busy={busy.kind === 'saving'}>
          {busy.kind === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="admin-btn" onClick={test} disabled={pending} aria-busy={busy.kind === 'testing'}>
          {busy.kind === 'testing' ? 'Testing…' : 'Test'}
        </button>
        <span aria-live="polite" data-testid="ai-note">
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
