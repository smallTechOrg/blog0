'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

// Old design links (spec/architecture.md divergence 1, spec/capabilities/reader-site.md): the
// design addressed everything by hash on one page — `#<id>`, `#<id>/tldr`, `#hl=<sentence id>`,
// `#archive`, `#about`, `#home`. The hash never reaches the server, so the home page maps it to
// the real route client-side. `legacyHashTarget` is pure, so it is unit-tested without a browser.

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Design sentence ids: `<article id>-p<n>-s<i>` (paragraph ids `<article id>-p<n>`). */
const HL_RE = /^hl=([a-z0-9]+(?:-[a-z0-9]+)*?)-p\d+(?:-s\d+)?$/;
/** In-page anchors the design (and this site) use on the home page — never routes. */
const IN_PAGE_ANCHORS = new Set(['newsletter', 'topics', 'home', 'top', 'main']);

/**
 * The real path for a legacy hash (with or without the leading `#`), or null when the hash is
 * empty, an in-page anchor, or not a legacy route. Article existence is not checked here: an
 * unknown slug lands on the article 404 (src/proxy.ts) like any other bad link.
 */
export function legacyHashTarget(hash: string): string | null {
  let raw = hash.replace(/^#/, '');
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* keep the raw form */
  }
  raw = raw.trim();
  if (!raw || IN_PAGE_ANCHORS.has(raw)) return null;
  if (raw === 'archive') return '/archive';
  if (raw === 'about') return '/about';

  const hl = HL_RE.exec(raw);
  if (hl) return '/p/' + hl[1];

  const tldr = /^(.+)\/tldr$/.exec(raw);
  if (tldr && SLUG_RE.test(tldr[1])) return '/p/' + tldr[1] + '/tldr';

  if (SLUG_RE.test(raw)) return '/p/' + raw;
  return null;
}

/**
 * Mounted on the home page: on load (and on a later hash change) a legacy hash is replaced by
 * its real route — `/#<id>/tldr` → `/p/<id>/tldr`, `/#hl=<id>-p3-s1` → `/p/<id>`, `/#archive` →
 * `/archive`. Anchors that exist on the page (e.g. `#newsletter`) are left alone. Renders nothing.
 */
export function LegacyHashRedirect() {
  const router = useRouter();
  useEffect(() => {
    function check() {
      const raw = window.location.hash;
      if (!raw || raw === '#') return;
      const id = raw.slice(1);
      try {
        if (document.getElementById(decodeURIComponent(id))) return;
      } catch {
        /* undecodable — fall through to the mapping, which rejects it */
      }
      const target = legacyHashTarget(raw);
      if (target) router.replace(target);
    }
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, [router]);
  return null;
}
