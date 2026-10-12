'use client';

import { useRef, useState, type FormEvent } from 'react';

import type { LoginRequest, LoginResponse } from '@/lib/api/dto';

import { apiRequest } from './api';

// Sign-in form (spec/ui.md → Sign in). Posts to /api/auth/login; on success navigates to `next`
// (a sanitised same-site path supplied by the page). Errors render inline under the form with the
// server's message ("Email or password is incorrect." / "Too many attempts — try again in N minutes.");
// network and unexpected failures read as apiRequest's messages.

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
    const res = await apiRequest<LoginResponse>('/api/auth/login', { method: 'POST', body: payload });
    if (res.ok) {
      setState({ kind: 'done' });
      // Full navigation so every server component re-renders with the new session cookie.
      window.location.assign(next);
      return;
    }

    const { code } = res.error;
    setState({ kind: 'error', message: code === 'VALIDATION_FAILED' ? 'Enter a valid email address and your password.' : res.error.message });
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
