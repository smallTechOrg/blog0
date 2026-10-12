// Reader view models (spec/architecture.md §3 "View-model contract"). Rendered by the reader
// components, produced by src/server/public. Pure + isomorphic.

import type { Block } from '@/lib/content/types';

export interface SiteViewModel {
  wordmark: string;
  tagline: string;
  publisherName: string;
  contactEmail: string;
  aboutStrap: string;
  aboutStand: string;
  aboutBodyParagraphs: string[];
  socialXUrl: string | null;
  socialLinkedinUrl: string | null;
  topics: string[];
  year: number;
}

export interface DeckViewModel {
  slides: Array<{ text: string }>;
  disclosure: string;
  shareUrl: string; // absolute …/p/<slug>/tldr
}

/** The published Listen (spec/architecture.md §3): the recording + its resolved paragraph marks. */
export interface ListenViewModel {
  audioUrl: string; // '/media/' + key (same-origin)
  mimeType: 'audio/mpeg' | 'audio/mp4';
  durationMs: number;
  marks: Array<{ pid: string; tMs: number }>; // resolveMarks over the published revision's paragraphs (one per paragraph), computed per request
  timing: 'synced' | 'estimated'; // stored marks covering the text → 'synced'; else estimated from word counts
  shareUrl: string; // absolute …/p/<slug>/listen
}

export interface ArticleViewModel {
  slug: string;
  title: string;
  dek: string;
  topic: string;
  bylineName: string;
  publishedLabel: string; // fmtDate(first_published_at, site tz) e.g. "8 Sep 2026"
  updatedLabel: string | null; // revision history (deferred): always null
  inProgress: boolean;
  blocks: Block[]; // from RenderedArticle
  times: { read: number; tldr: number | null; listen: number | null };
  deck: DeckViewModel | null; // published deck only
  listen: ListenViewModel | null; // published Listen only; null without one
  correctionsHtml: string | null; // revision history (deferred): always null
  next: { slug: string; title: string } | null;
  articleUrl: string; // absolute
}

export interface PostCardViewModel {
  slug: string;
  title: string;
  dek: string;
  topic: string;
  publishedLabel: string;
  inProgress: boolean;
  times: { tldr: number | null; listen: number | null };
}

// ---------------------------------------------------------------------------------------------
// AI disclosure on the deck's intro slide (spec/architecture.md §3, divergence 8)
// ---------------------------------------------------------------------------------------------

export const DECK_DISCLOSURE = {
  jev: 'Lines selected by Jev (AI), verbatim from the article.',
  mixed: 'Lines selected by Jev (AI) and the editors, verbatim from the article.',
  editors: 'Lines selected by the editors, verbatim from the article.',
} as const;

/** Disclosure for a deck given each slide's source. */
export function deckDisclosure(sources: ReadonlyArray<'jev' | 'writer'>): string {
  const jev = sources.filter((s) => s === 'jev').length;
  if (jev === 0) return DECK_DISCLOSURE.editors;
  return jev === sources.length ? DECK_DISCLOSURE.jev : DECK_DISCLOSURE.mixed;
}

// ---------------------------------------------------------------------------------------------
// Site record → chrome view model
// ---------------------------------------------------------------------------------------------

/** The site-record fields the chrome needs (a structural subset of the `site` row). */
export interface SiteRecordLike {
  wordmark: string;
  tagline: string;
  publisherName: string;
  contactEmail: string;
  aboutStrap: string;
  aboutStand: string;
  aboutBodyMd: string;
  socialXUrl: string | null;
  socialLinkedinUrl: string | null;
}

export function siteViewModelFrom(site: SiteRecordLike, opts: { topics: string[]; year: number }): SiteViewModel {
  return {
    wordmark: site.wordmark,
    tagline: site.tagline,
    publisherName: site.publisherName,
    contactEmail: site.contactEmail,
    aboutStrap: site.aboutStrap,
    aboutStand: site.aboutStand,
    aboutBodyParagraphs: site.aboutBodyMd
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter(Boolean),
    socialXUrl: site.socialXUrl || null,
    socialLinkedinUrl: site.socialLinkedinUrl || null,
    topics: opts.topics,
    year: opts.year,
  };
}
