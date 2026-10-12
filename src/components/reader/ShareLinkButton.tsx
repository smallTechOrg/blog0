'use client';

import { useEffect, useRef, useState } from 'react';

import { Icon } from '@/components/design/Icon';
import { cx } from '@/components/design/motion';

import { copyToClipboard } from './clipboard';

/* Copies a link and says so for a moment; falls back to the native share
   sheet where one exists and the clipboard does not. */
export interface ShareLinkButtonProps {
  /** Absolute URL to copy. Defaults to the current address. */
  link?: string;
  /** Title for the native share sheet (defaults to the page title). */
  title?: string;
  /** Button label; the design default is "Share". */
  label?: string;
}

export function ShareLinkButton({ link, title, label }: ShareLinkButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  function share() {
    const href = link || String(window.location.href);
    void copyToClipboard(href).then((ok) => {
      if (ok) {
        setCopied(true);
        timer.current = window.setTimeout(() => setCopied(false), 1800);
      } else if (navigator.share) {
        navigator.share({ title: title || document.title, url: href }).catch(() => {});
      }
    });
  }

  return (
    <button
      className={cx('btn-outline', copied && 'is-done')}
      type="button"
      onClick={share}
      aria-label={copied ? 'Link copied' : label || 'Share this summary'}
    >
      <Icon name={copied ? 'check' : 'share'} size={15} />
      {copied ? 'Link copied' : label || 'Share'}
    </button>
  );
}
