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
  /** Phase 7: the consent line under the footer form (recorded on every signup). */
  newsletterConsentText: string;
  topics: string[];
  year: number;
}

export interface DeckViewModel {
  slides: Array<{ text: string; image?: { url: string; alt: string } }>;
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
  updatedLabel: string | null; // publication-record (Frozen — not scheduled): always null
  inProgress: boolean;
  /** SMA-49: a slideshow-only post — the page is its deck, no Read / Listen. */
  mediaOnly: boolean;
  blocks: Block[]; // from RenderedArticle
  times: { read: number; tldr: number | null; listen: number | null };
  deck: DeckViewModel | null; // published deck only
  listen: ListenViewModel | null; // published Listen only; null without one
  correctionsHtml: string | null; // publication-record (Frozen — not scheduled): always null
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
  mediaOnly?: boolean;
  times: { tldr: number | null; listen: number | null };
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
  newsletterConsentText: string;
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
    newsletterConsentText: site.newsletterConsentText,
    topics: opts.topics,
    year: opts.year,
  };
}
