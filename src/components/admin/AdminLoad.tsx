'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';

import { cx } from '@/components/design/motion';

import { signInHref, type ApiResult } from './api';

// The load half of every admin screen (spec/ui.md §4: loading, error + Retry or Sign in again,
// ready): one fetch on mount and again when `key` changes or `reload()` is called.

export type AdminLoad<T> =
  | { kind: 'loading' }
  | { kind: 'error'; code: string; message: string; signedOut: boolean }
  | { kind: 'ready'; data: T };

export interface AdminLoadHandle<T> {
  load: AdminLoad<T>;
  setLoad: Dispatch<SetStateAction<AdminLoad<T>>>;
  /** Back to loading, then fetch again (Retry / Reload). */
  reload: () => void;
}

/**
 * Runs `fetcher` on mount, whenever `key` changes and on `reload()`. A response that lands after
 * unmount or after a newer request is dropped. `onData` sees every successful response.
 */
export function useAdminLoad<T>(fetcher: () => Promise<ApiResult<T>>, key = '', onData?: (data: T) => void): AdminLoadHandle<T> {
  const [load, setLoad] = useState<AdminLoad<T>>({ kind: 'loading' });
  const [tick, setTick] = useState(0);
  const latest = useRef({ fetcher, onData });
  useLayoutEffect(() => {
    latest.current = { fetcher, onData };
  });

  useEffect(() => {
    let live = true;
    void latest.current.fetcher().then((res) => {
      if (!live) return;
      if (res.ok) {
        latest.current.onData?.(res.data);
        setLoad({ kind: 'ready', data: res.data });
      } else {
        setLoad({ kind: 'error', code: res.error.code, message: res.error.message, signedOut: res.error.code === 'UNAUTHENTICATED' });
      }
    });
    return () => {
      live = false;
    };
  }, [key, tick]);

  const reload = useCallback(() => {
    setLoad({ kind: 'loading' });
    setTick((n) => n + 1);
  }, []);

  return { load, setLoad, reload };
}

/** The response with the moment it arrived (`now` for relative times like "10 min ago"). */
export async function stamped<T extends object>(request: Promise<ApiResult<T>>): Promise<ApiResult<T & { now: Date }>> {
  const res = await request;
  return res.ok ? { ...res, data: { ...res.data, now: new Date() } } : res;
}

export interface AdminLoadErrorProps {
  error: { message: string; signedOut: boolean };
  /** "Couldn’t load <what>: <message>" — e.g. "the articles". */
  what?: string;
  /** Replaces the "Couldn’t load …" line. */
  message?: ReactNode;
  onRetry: () => void;
  /** Signed out → "Sign in again" back to this path instead of Retry (omitted → always Retry). */
  signInPath?: string;
  /** Small buttons on their own line (forms). */
  small?: boolean;
  className?: string;
}

/** The load-error card: what failed, then Retry — or Sign in again when the session ended. */
export function AdminLoadError({ error, what, message, onRetry, signInPath, small = false, className }: AdminLoadErrorProps) {
  const btn = cx('admin-btn', small && 'admin-btn--small');
  const action =
    signInPath && error.signedOut ? (
      <a className={btn} href={signInHref(signInPath)}>
        Sign in again
      </a>
    ) : (
      <button type="button" className={btn} onClick={onRetry}>
        Retry
      </button>
    );
  return (
    <div className={cx(className, 'admin-alert')} role="alert">
      <p>{message ?? `Couldn’t load ${what}: ${error.message}`}</p>
      {small ? <p>{action}</p> : action}
    </div>
  );
}
