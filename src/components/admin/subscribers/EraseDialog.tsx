'use client';

import { useRef, useState, type FormEvent } from 'react';

import type { SubscriberEraseResponse } from '@/lib/api/dto';

import { apiRequest } from '../api';
import { runExclusive } from '../editor/tldr-generate';

import { ERASE_CONFIRM, eraseConfirmMatches, subscriberApi } from './subscribers-api';

// Erase personal data (fix pass; spec/ui.md §4 "Subscriber"): a typed-confirmation dialog — Erase
// stays disabled until the input equals the subscriber's address (case-insensitive) — then
// POST …/erase { confirmEmail }.

export function EraseDialog({
  subscriber,
  onCancel,
  onDone,
}: {
  subscriber: { id: string; email: string };
  onCancel: () => void;
  onDone: (result: SubscriberEraseResponse) => void;
}) {
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flight = useRef(false);
  const matches = eraseConfirmMatches(typed, subscriber.email);

  function submit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (!matches) return;
    void runExclusive(flight, async () => {
      setPending(true);
      setError(null);
      const res = await apiRequest<SubscriberEraseResponse>(subscriberApi(subscriber.id, 'erase'), {
        method: 'POST',
        body: { confirmEmail: typed.trim() },
      });
      setPending(false);
      if (res.ok) onDone(res.data);
      else setError(res.error.message);
    });
  }

  return (
    <div className="admin-dialog__scrim" onMouseDown={(e) => e.target === e.currentTarget && !pending && onCancel()}>
      <form
        className="admin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="erase-title"
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !pending) {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        <h2 className="admin-dialog__title" id="erase-title">
          {ERASE_CONFIRM(subscriber.email)}
        </h2>
        <label className="admin-field">
          <span className="admin-label">Type the address to confirm</span>
          <input
            className="admin-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={pending}
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
        </label>
        {error ? (
          <p className="admin-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="admin-dialog__actions">
          <button type="submit" className="admin-btn admin-btn--danger" disabled={!matches || pending} aria-busy={pending}>
            {pending ? 'Erasing…' : 'Erase'}
          </button>
          <button type="button" className="admin-btn admin-btn--ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
