'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

import type {
  NewsletterSettingsDto,
  NewsletterSettingsResponse,
  NewsletterStatusDto,
  NewsletterSyncResponse,
  SendLegacyConfirmationsResponse,
} from '@/lib/api/dto';
import { NEWSLETTER_SETTINGS_LIMITS as L } from '@/lib/api/dto';

import { AdminLoadError, useAdminLoad } from '../AdminLoad';
import { apiRequest, signInHref } from '../api';
import { runExclusive } from '../editor/tldr-generate';
import { legacySentence } from '../subscribers/subscribers-api';

import {
  AUTO_SEND_WARNING,
  autoSendConfirm,
  CONSENT_VERSION_HINT,
  countsLine,
  digestHint,
  draftFrom,
  fieldErrorsFrom,
  isDirty,
  legacyConfirm,
  mailLine,
  MODE_HELP,
  MODE_LABEL,
  MODES,
  savablePatch,
  senderLine,
  STUB_SENDER_HINT,
  SYNC_CONFIRM,
  syncResultLine,
  validateDraft,
  type NewsletterDraft,
  type NewsletterErrors,
} from './newsletter-form';

// Admin → Site → Newsletter card (spec/ui.md §4 "Site"; capability newsletter-issues): status strip
// (sender, confirmation mail, counts, Sync to Listmonk), mode (manual / per post / digest with its
// thresholds and next-digest hint), auto-send (off by default, confirmed when turned on), consent
// text + version, legacy confirmations. Own load of GET /api/admin/newsletter/settings, own Save
// (PATCH). Never sends an issue. Anchored at #newsletter (links from Subscribers and Newsletter).

const PATH = '/admin/site';
const SETTINGS_API = '/api/admin/newsletter/settings';

const fetchSettings = () => apiRequest<NewsletterSettingsResponse>(SETTINGS_API);

export function NewsletterSettings({ timeZone }: { timeZone: string }) {
  const { load, setLoad, reload } = useAdminLoad(fetchSettings);
  // After a sync / legacy send: refetch in place (the card keeps its result lines; no loading flash).
  const refresh = () =>
    void fetchSettings().then((res) => {
      if (res.ok) setLoad({ kind: 'ready', data: res.data });
    });

  return (
    <section id="newsletter" className="admin-card nlset" aria-labelledby="nlset-h">
      <h2 className="admin-card__title" id="nlset-h">Newsletter</h2>
      {load.kind === 'loading' ? (
        <p className="admin-muted" role="status">
          Loading newsletter settings…
        </p>
      ) : null}
      {load.kind === 'error' ? <AdminLoadError error={load} what="the newsletter settings" onRetry={reload} signInPath={PATH} small /> : null}
      {load.kind === 'ready' ? (
        <>
          <StatusStrip status={load.data.status} onDone={refresh} />
          <SettingsForm
            saved={load.data.settings}
            status={load.data.status}
            timeZone={timeZone}
            onSaved={(data) => setLoad({ kind: 'ready', data })}
          />
          <LegacyRow status={load.data.status} onDone={refresh} />
        </>
      ) : null}
    </section>
  );
}

function StatusStrip({ status, onDone }: { status: NewsletterStatusDto; onDone: () => void }) {
  const sender = senderLine(status.sender);
  const [sync, setSync] = useState<{ kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; text: string; errors: string[] } | { kind: 'error'; text: string }>({
    kind: 'idle',
  });
  const flight = useRef(false);

  function runSync(): void {
    if (!window.confirm(SYNC_CONFIRM)) return;
    void runExclusive(flight, async () => {
      setSync({ kind: 'busy' });
      const res = await apiRequest<NewsletterSyncResponse>('/api/admin/newsletter/sync', { method: 'POST', body: { confirm: true } });
      if (res.ok) {
        setSync({ kind: 'done', text: syncResultLine(res.data), errors: res.data.errors.map((e) => `${e.email}: ${e.message}`) });
        onDone();
      } else setSync({ kind: 'error', text: res.error.message });
    });
  }

  return (
    <div className="nlset__status" aria-label="Newsletter status">
      <p>
        Sender: <strong>{sender.kind}</strong> {sender.stub ? '— ' : '· '}
        {sender.rest}
      </p>
      {sender.stub ? <p className="stub nlset__stub">{STUB_SENDER_HINT}</p> : null}
      <p>
        Confirmation mail: <strong>{status.mail.transport === 'smtp' ? 'SMTP' : 'Stub'}</strong>{' '}
        {mailLine(status.mail).replace(/^(SMTP|Stub)\s?/, '')}
      </p>
      <p className="admin-muted">{countsLine(status.counts)}</p>
      <div className="admin-actions">
        <button type="button" className="admin-btn admin-btn--small" onClick={runSync} disabled={sync.kind === 'busy'} aria-busy={sync.kind === 'busy'}>
          {sync.kind === 'busy' ? 'Syncing…' : 'Sync to Listmonk'}
        </button>
        <span aria-live="polite">
          {sync.kind === 'done' ? <span className="admin-ok">{sync.text}</span> : null}
          {sync.kind === 'error' ? (
            <span className="admin-error" role="alert">
              {sync.text}
            </span>
          ) : null}
        </span>
      </div>
      {sync.kind === 'done' && sync.errors.length ? (
        <ul className="admin-error nlset__syncerrs">
          {sync.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

type Save = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string; signedOut: boolean };

function SettingsForm({
  saved,
  status,
  timeZone,
  onSaved,
}: {
  saved: NewsletterSettingsDto;
  status: NewsletterStatusDto;
  timeZone: string;
  onSaved: (data: NewsletterSettingsResponse) => void;
}) {
  const [draft, setDraft] = useState<NewsletterDraft>(() => draftFrom(saved));
  const [errors, setErrors] = useState<NewsletterErrors>({});
  const [save, setSave] = useState<Save>({ kind: 'idle' });
  const flight = useRef(false);
  const dirty = isDirty(saved, draft);
  const pending = save.kind === 'saving';
  const consentChanged = draft.consentText.trim() !== saved.consentText;
  const hint = digestHint(status.digest, timeZone);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  function set<K extends keyof NewsletterDraft>(key: K, value: NewsletterDraft[K]): void {
    setDraft((d) => ({ ...d, [key]: value }));
    if (key in errors) setErrors((e) => ({ ...e, [key]: undefined }));
    if (save.kind === 'saved' || save.kind === 'error') setSave({ kind: 'idle' });
  }

  function onAutoSend(checked: boolean): void {
    if (checked && !window.confirm(autoSendConfirm(status.counts.confirmed))) return;
    set('autoSend', checked);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void runExclusive(flight, async () => {
      const found = validateDraft(draft);
      if (draft.mode !== 'digest') {
        delete found.digestDays;
        delete found.digestPosts;
      }
      if (Object.keys(found).length) {
        setErrors(found);
        setSave({ kind: 'error', message: 'Fix the highlighted fields, then save.', signedOut: false });
        return;
      }
      const patch = savablePatch(saved, draft);
      if (Object.keys(patch).length === 0) return;
      setSave({ kind: 'saving' });
      const res = await apiRequest<NewsletterSettingsResponse>(SETTINGS_API, { method: 'PATCH', body: patch });
      if (res.ok) {
        setErrors({});
        setDraft(draftFrom(res.data.settings));
        onSaved(res.data);
        setSave({ kind: 'saved' });
        return;
      }
      setErrors(res.error.code === 'VALIDATION_FAILED' ? fieldErrorsFrom(res.error.details) : {});
      setSave({ kind: 'error', message: res.error.message, signedOut: res.error.code === 'UNAUTHENTICATED' });
    });
  }

  function err(f: keyof NewsletterErrors) {
    return errors[f] ? (
      <span className="admin-error" id={'nl-' + f + '-err'}>
        {errors[f]}
      </span>
    ) : null;
  }

  return (
    <form className="admin-form nlset__form" onSubmit={onSubmit} noValidate aria-label="Newsletter settings">
      <fieldset className="nlset__modes" disabled={pending}>
        <legend className="admin-label">Mode</legend>
        {MODES.map((m) => (
          <label key={m} className="admin-check nlset__mode">
            <input type="radio" name="nl-mode" value={m} checked={draft.mode === m} onChange={() => set('mode', m)} />
            <span>
              <strong>{MODE_LABEL[m]}</strong>{' '}
              <span className="admin-hint">{m === 'digest' ? MODE_HELP.digest(draft.digestDays || '…', draft.digestPosts || '…') : MODE_HELP[m]}</span>
            </span>
          </label>
        ))}
        {draft.mode === 'digest' ? (
          <div className="nlset__digest">
            <label className="admin-field admin-field--inline">
              <span className="admin-label">Every N days</span>
              <input
                type="number"
                className="admin-input admin-input--num"
                min={L.digestDays[0]}
                max={L.digestDays[1]}
                value={draft.digestDays}
                onChange={(e) => set('digestDays', e.target.value)}
                aria-invalid={errors.digestDays ? true : undefined}
                aria-describedby={errors.digestDays ? 'nl-digestDays-err' : undefined}
              />
              {err('digestDays')}
            </label>
            <label className="admin-field admin-field--inline">
              <span className="admin-label">or N posts</span>
              <input
                type="number"
                className="admin-input admin-input--num"
                min={L.digestPosts[0]}
                max={L.digestPosts[1]}
                value={draft.digestPosts}
                onChange={(e) => set('digestPosts', e.target.value)}
                aria-invalid={errors.digestPosts ? true : undefined}
                aria-describedby={errors.digestPosts ? 'nl-digestPosts-err' : undefined}
              />
              {err('digestPosts')}
            </label>
            {hint && saved.mode === 'digest' ? <p className="admin-hint">{hint}</p> : null}
          </div>
        ) : null}
      </fieldset>

      <label className="admin-check nlset__auto">
        <input type="checkbox" checked={draft.autoSend} disabled={pending} onChange={(e) => onAutoSend(e.target.checked)} />
        <span>
          <strong>Auto-send</strong> <span className="nlset__warn">{AUTO_SEND_WARNING}</span>
        </span>
      </label>

      <div className="admin-field">
        <label className="admin-label" htmlFor="nl-consentText">
          Consent text
        </label>
        <textarea
          id="nl-consentText"
          className="admin-input"
          rows={3}
          maxLength={L.consentText}
          value={draft.consentText}
          disabled={pending}
          onChange={(e) => set('consentText', e.target.value)}
          aria-invalid={errors.consentText ? true : undefined}
          aria-describedby={'nl-consentText-hint' + (errors.consentText ? ' nl-consentText-err' : '')}
        />
        <span className="admin-hint" id="nl-consentText-hint">
          Shown under the footer form and stored with every signup. {draft.consentText.trim().length}/{L.consentText}
        </span>
        {err('consentText')}
      </div>
      <div className="admin-field">
        <label className="admin-label" htmlFor="nl-consentVersion">
          Consent version
        </label>
        <input
          id="nl-consentVersion"
          className="admin-input admin-input--num"
          maxLength={L.consentVersion}
          value={draft.consentVersion}
          disabled={pending}
          onChange={(e) => set('consentVersion', e.target.value)}
          aria-invalid={errors.consentVersion ? true : undefined}
          aria-describedby={'nl-consentVersion-hint' + (errors.consentVersion ? ' nl-consentVersion-err' : '')}
          autoComplete="off"
        />
        <span className="admin-hint" id="nl-consentVersion-hint">
          {CONSENT_VERSION_HINT}
          {consentChanged && draft.consentVersion.trim() === saved.consentVersion ? ` Saving bumps it from ${saved.consentVersion}.` : ''}
        </span>
        {err('consentVersion')}
      </div>

      <div className="admin-form__actions">
        <button type="submit" className="admin-btn admin-btn--primary" disabled={pending || !dirty} aria-busy={pending}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          disabled={pending || !dirty}
          onClick={() => {
            setDraft(draftFrom(saved));
            setErrors({});
            setSave({ kind: 'idle' });
          }}
        >
          Discard changes
        </button>
        {dirty && !pending ? <span className="admin-faint">Unsaved changes</span> : null}
      </div>
      <div aria-live="polite">
        {save.kind === 'saved' ? <p className="admin-ok">Saved</p> : null}
        {save.kind === 'error' ? (
          <p className="admin-error" role="alert">
            {save.signedOut ? (
              <>
                Your session ended — <a href={signInHref(PATH)}>sign in again</a>.
              </>
            ) : (
              <>Couldn’t save — {save.message}</>
            )}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function LegacyRow({ status, onDone }: { status: NewsletterStatusDto; onDone: () => void }) {
  const n = status.counts.legacy_unconfirmed;
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; text: string } | { kind: 'error'; text: string }>({ kind: 'idle' });
  const flight = useRef(false);
  if (n <= 0 && state.kind !== 'done') return null;

  function send(): void {
    if (!window.confirm(legacyConfirm(n))) return;
    void runExclusive(flight, async () => {
      setState({ kind: 'busy' });
      const res = await apiRequest<SendLegacyConfirmationsResponse>('/api/admin/subscribers/send-legacy-confirmations', {
        method: 'POST',
        body: { confirm: true },
      });
      if (res.ok) {
        setState({ kind: 'done', text: `Sent ${res.data.sent}, skipped ${res.data.skipped}` });
        onDone();
      } else setState({ kind: 'error', text: res.error.message });
    });
  }

  return (
    <div className="admin-alert is-warn nlset__legacy">
      {n > 0 ? <p>{legacySentence(n)}</p> : null}
      <p className="admin-actions">
        {n > 0 ? (
          <button type="button" className="admin-btn admin-btn--small" onClick={send} disabled={state.kind === 'busy'} aria-busy={state.kind === 'busy'}>
            {state.kind === 'busy' ? 'Sending…' : 'Send confirmation to all legacy'}
          </button>
        ) : null}
        <span aria-live="polite">
          {state.kind === 'done' ? <span className="admin-ok">{state.text}</span> : null}
          {state.kind === 'error' ? (
            <span className="admin-error" role="alert">
              {state.text}
            </span>
          ) : null}
        </span>
      </p>
    </div>
  );
}
