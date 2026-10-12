'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { AboutView } from '@/components/site/about/AboutView';
import { aboutParagraphs } from '@/components/site/about/about-text';
import type { SiteSettingsDto, SiteSettingsResponse } from '@/lib/api/dto';

import { apiRequest, signInHref } from '../api';

import {
  draftFrom,
  FIELD_LABELS,
  fieldErrorsFrom,
  isDirty,
  maxLengthOf,
  patchFrom,
  validateDraft,
  type FieldErrors,
  type SiteField,
  type SiteSettingsDraft,
} from './site-form';

// Admin → Site /admin/site (spec/ui.md §4 "Later admin screens"; spec/api.md GET/PATCH
// /api/admin/site): tagline, contact email, About strap/stand/body, social URLs, with a live
// preview of the About page. States: loading, load error + Retry (or Sign in again), editing,
// saving, saved, save error (per-field from the server's VALIDATION_FAILED details).

const PATH = '/admin/site';

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; signedOut: boolean }
  | { kind: 'ready'; saved: SiteSettingsDto };

async function fetchSettings(): Promise<Load> {
  const res = await apiRequest<SiteSettingsResponse>('/api/admin/site');
  if (res.ok) return { kind: 'ready', saved: res.data.site };
  return { kind: 'error', message: res.error.message, signedOut: res.error.code === 'UNAUTHENTICATED' };
}

export function SiteSettingsView({ wordmark }: { wordmark: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  const retry = useCallback(async () => {
    setLoad({ kind: 'loading' });
    setLoad(await fetchSettings());
  }, []);

  useEffect(() => {
    let live = true;
    void fetchSettings().then((next) => {
      if (live) setLoad(next);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <main className="desk-main">
      <div className="desk-page desk-page--narrow">
        <p className="admin-crumb">
          <Link href="/admin">← Desk</Link>
        </p>
        <h1 className="desk-page__title">Site</h1>
        {load.kind === 'loading' ? (
          <p className="admin-muted" role="status">
            Loading site settings…
          </p>
        ) : null}
        {load.kind === 'error' ? (
          <div className="admin-alert" role="alert">
            <p>{load.signedOut ? 'Your session ended — sign in again to edit the site.' : load.message}</p>
            <p>
              {load.signedOut ? (
                <a className="admin-btn admin-btn--small" href={signInHref(PATH)}>
                  Sign in again
                </a>
              ) : (
                <button type="button" className="admin-btn admin-btn--small" onClick={() => void retry()}>
                  Retry
                </button>
              )}
            </p>
          </div>
        ) : null}
        {load.kind === 'ready' ? (
          <SiteSettingsForm wordmark={wordmark} saved={load.saved} onSaved={(saved) => setLoad({ kind: 'ready', saved })} />
        ) : null}
      </div>
    </main>
  );
}

type Save = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string; signedOut: boolean };

function SiteSettingsForm({
  wordmark,
  saved,
  onSaved,
}: {
  wordmark: string;
  saved: SiteSettingsDto;
  onSaved: (saved: SiteSettingsDto) => void;
}) {
  const [draft, setDraft] = useState<SiteSettingsDraft>(() => draftFrom(saved));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [save, setSave] = useState<Save>({ kind: 'idle' });
  const dirty = isDirty(saved, draft);
  const pending = save.kind === 'saving';

  // Leaving with unsaved edits asks first.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  function set(field: SiteField, value: string): void {
    setDraft((d) => ({ ...d, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
    if (save.kind === 'saved' || save.kind === 'error') setSave({ kind: 'idle' });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const found = validateDraft(draft);
    if (Object.keys(found).length) {
      setErrors(found);
      setSave({ kind: 'error', message: 'Fix the highlighted fields, then save.', signedOut: false });
      return;
    }
    const patch = patchFrom(saved, draft);
    if (Object.keys(patch).length === 0) return;

    setSave({ kind: 'saving' });
    const res = await apiRequest<SiteSettingsResponse>('/api/admin/site', { method: 'PATCH', body: patch });
    if (res.ok) {
      setErrors({});
      setDraft(draftFrom(res.data.site));
      onSaved(res.data.site);
      setSave({ kind: 'saved' });
      return;
    }
    const fromServer = res.error.code === 'VALIDATION_FAILED' ? fieldErrorsFrom(res.error.details) : {};
    setErrors(fromServer);
    setSave({ kind: 'error', message: res.error.message, signedOut: res.error.code === 'UNAUTHENTICATED' });
  }

  function field(name: SiteField, opts: { type?: 'text' | 'email' | 'url'; rows?: number; hint?: string; autoComplete?: string } = {}) {
    const id = 'site-' + name;
    const err = errors[name];
    const describedBy = [opts.hint ? id + '-hint' : null, err ? id + '-err' : null].filter(Boolean).join(' ') || undefined;
    const common = {
      id,
      name,
      className: 'admin-input',
      value: draft[name],
      maxLength: maxLengthOf(name),
      disabled: pending,
      'aria-invalid': err ? true : undefined,
      'aria-describedby': describedBy,
    };
    return (
      <div className="admin-field">
        <label className="admin-label" htmlFor={id}>
          {FIELD_LABELS[name]}
        </label>
        {opts.rows ? (
          <textarea {...common} rows={opts.rows} onChange={(e) => set(name, e.target.value)} />
        ) : (
          <input {...common} type={opts.type ?? 'text'} autoComplete={opts.autoComplete ?? 'off'} onChange={(e) => set(name, e.target.value)} />
        )}
        {opts.hint ? (
          <span className="admin-hint" id={id + '-hint'}>
            {opts.hint}
          </span>
        ) : null}
        {err ? (
          <span className="admin-error" id={id + '-err'}>
            {err}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <form className="admin-form" onSubmit={onSubmit} noValidate aria-label="Site settings">
        {field('tagline', { hint: 'The line under the wordmark.' })}
        {field('contactEmail', { type: 'email', autoComplete: 'email', hint: 'Shown in the footer for tips, corrections and pitches.' })}
        {field('aboutStrap', { hint: 'The short line in the About block (home and /about).' })}
        {field('aboutStand', { rows: 2, hint: 'The standfirst under “About ' + wordmark + '”.' })}
        {field('aboutBodyMd', { rows: 8, hint: 'Plain paragraphs; a blank line starts a new one.' })}
        {field('socialXUrl', { type: 'url', hint: 'Leave blank to hide the X icon in the footer.' })}
        {field('socialLinkedinUrl', { type: 'url', hint: 'Leave blank to hide the LinkedIn icon in the footer.' })}
        <div className="admin-form__actions">
          <button type="submit" className="admin-btn admin-btn--primary" disabled={pending || !dirty} aria-busy={pending}>
            {pending ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="admin-btn admin-btn--ghost" disabled={pending || !dirty} onClick={() => {
            setDraft(draftFrom(saved));
            setErrors({});
            setSave({ kind: 'idle' });
          }}>
            Discard changes
          </button>
          {dirty && !pending ? <span className="admin-faint">Unsaved changes</span> : null}
        </div>
        <div aria-live="polite">
          {save.kind === 'saved' ? <p className="admin-ok">Saved — the home page and /about show it on the next load.</p> : null}
          {save.kind === 'error' ? (
            <p className="admin-error" role="alert">
              {save.signedOut ? (
                <>
                  Your session ended — <a href={signInHref(PATH)}>sign in again</a> (copy your edits first).
                </>
              ) : (
                save.message
              )}
            </p>
          ) : null}
        </div>
      </form>
      <section
        aria-labelledby="site-preview-h"
        style={{ marginTop: 28, padding: '14px 20px', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--surface)' }}
      >
        <h2 id="site-preview-h" className="admin-label">
          Preview — /about
        </h2>
        <AboutView
          as="div"
          wordmark={wordmark}
          stand={draft.aboutStand.trim()}
          strap={draft.aboutStrap.trim()}
          paragraphs={aboutParagraphs(draft.aboutBodyMd)}
        />
      </section>
    </>
  );
}
