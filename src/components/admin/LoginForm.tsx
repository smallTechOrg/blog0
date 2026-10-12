'use client';

import { useRef, useState, type FormEvent } from 'react';

import type { LoginRequest, LoginResponse } from '@/lib/api/dto';
import type { Envelope } from '@/lib/api/envelope';

// Sign-in form (spec/ui.md → Sign in). Posts to /api/auth/login; on success navigates to `next`
// (a sanitised same-site path supplied by the page). Errors render inline under the form with the
// server's message ("Email or password is incorrect." / "Too many attempts — try again in N minutes.").

const NETWORK_MESSAGE = "Couldn't reach the server — check your connection and try again.";
const UNEXPECTED_MESSAGE = 'Something went wrong on our side. Try again in a moment.';

type State = { kind: 'idle' } | { kind: 'pending' } | { kind: 'error'; message: string } | { kind: 'done' };

export function LoginForm({ next }: { next: string }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const passwordRef = useRef<HTMLInputElement>(null);
  const busy = state.kind === 'pending' || state.kind === 'done';

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const payload: LoginRequest = {
      email: String(form.get('email') ?? '').trim(),
      password: String(form.get('password') ?? ''),
    };
    if (payload.email === '' || payload.password === '') {
      setState({ kind: 'error', message: 'Enter your email and password.' });
      return;
    }

    setState({ kind: 'pending' });
    let response: Response;
    try {
      response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
      });
    } catch {
      setState({ kind: 'error', message: NETWORK_MESSAGE });
      return;
    }

    let body: Envelope<LoginResponse> | null = null;
    try {
      body = (await response.json()) as Envelope<LoginResponse>;
    } catch {
      body = null;
    }

    if (body?.ok) {
      setState({ kind: 'done' });
      // Full navigation so every server component re-renders with the new session cookie.
      window.location.assign(next);
      return;
    }

    const code = body && !body.ok ? body.error.code : null;
    let message = body && !body.ok ? body.error.message : UNEXPECTED_MESSAGE;
    if (code === 'VALIDATION_FAILED') message = 'Enter a valid email address and your password.';
    if (code === 'INTERNAL') message = UNEXPECTED_MESSAGE;
    setState({ kind: 'error', message });
    if (code === 'BAD_CREDENTIALS' && passwordRef.current) {
      passwordRef.current.value = '';
      passwordRef.current.focus();
    }
  }

  const error = state.kind === 'error' ? state.message : null;

  return (
    <form className="admin-login__form" onSubmit={onSubmit} noValidate aria-describedby={error ? 'admin-login-error' : undefined}>
      <label className="admin-login__field">
        <span className="admin-login__label">Email</span>
        <input
          className="admin-login__input"
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          maxLength={254}
          required
          autoFocus
          disabled={busy}
        />
      </label>
      <label className="admin-login__field">
        <span className="admin-login__label">Password</span>
        <input
          ref={passwordRef}
          className="admin-login__input"
          type="password"
          name="password"
          autoComplete="current-password"
          maxLength={200}
          required
          disabled={busy}
        />
      </label>
      <button className="btn-outline admin-login__submit" type="submit" disabled={busy} aria-busy={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p id="admin-login-error" className="admin-login__error" role="alert" aria-live="polite">
        {error}
      </p>
    </form>
  );
}
