import 'server-only';

import { readFileSync } from 'node:fs';
import path from 'node:path';

// The 5 design articles (spec/design/design-app.js → POSTS). Bodies live next to this file as
// `<slug>.md`, byte-for-byte the design's `md` string plus one trailing newline (stripped on read).
// Used by tests (Jev integration, eval) and seeded as published posts (pnpm db:seed:posts).

export interface SeedPost {
  /** Design id = slug. */
  slug: string;
  title: string;
  /** Design `tag`. */
  topic: string;
  /** Design date `YYYY-MM-DD` (published 09:00 site timezone when seeded). */
  date: string;
  bylineName: string;
  /** Design `excerpt`. */
  dek: string;
  /** Design `draft: true` → public "Draft — in progress" badge (divergence #18). */
  inProgress: boolean;
  /** Design FEATURED_HITS order (divergence #19). */
  featuredRank: number | null;
}

export const SEED_POSTS: readonly SeedPost[] = [
  {
    slug: 'humans-are-software',
    title: 'Humans are Software',
    topic: 'Perspectives',
    date: '2026-09-08',
    bylineName: 'Sai Krishna V',
    dek: 'A human is a collection of perceptions, feelings, thoughts and intentions — read through the Buddha’s account of how perception becomes proliferation.',
    inProgress: false,
    featuredRank: 3,
  },
  {
    slug: 'tech-company-first',
    title: 'Before you become an AI company you will need to become a Tech company',
    topic: 'Op-Ed',
    date: '2026-09-15',
    bylineName: 'Sai Krishna V',
    dek: 'AI lowers the barrier to building software. It does not remove the 1% of problems that decide whether a business survives.',
    inProgress: false,
    featuredRank: 2,
  },
  {
    slug: 'artefact-driven-development',
    title: 'Artefact Driven Development',
    topic: 'Educational',
    date: '2026-09-19',
    bylineName: 'Sai Krishna V',
    dek: 'Two techniques for staying in flow with AI: version everything you make, and treat context as a collection of artefacts.',
    inProgress: false,
    featuredRank: null,
  },
  {
    slug: 'ai-will-destroy-the-world',
    title: 'AI Will Destroy the World',
    topic: 'Op-Ed',
    date: '2026-09-24',
    bylineName: 'Sai Krishna V',
    dek: 'Not for reasons based on technology. Because we are rushing it, without adequate knowledge, and with the wrong attitude.',
    inProgress: false,
    featuredRank: 1,
  },
  {
    slug: 'ai-is-expensive',
    title: 'AI is Expensive',
    topic: 'Analysis',
    date: '2026-09-29',
    bylineName: 'Sai Krishna V',
    dek: 'AI may be smarter than humans. Nobody said it was cheaper. An unfinished look at what it actually costs.',
    inProgress: true,
    featuredRank: null,
  },
];

/** Resolved from the repo root (every command runs there — see README). */
export const SEED_POSTS_DIR = path.join(process.cwd(), 'src', 'server', 'seed', 'posts');

/** The design's Markdown body for a seed post, exactly as in POSTS[].md. */
export function readSeedPostBody(slug: string): string {
  if (!SEED_POSTS.some((p) => p.slug === slug)) throw new Error(`Unknown seed post '${slug}'`);
  const raw = readFileSync(path.join(SEED_POSTS_DIR, `${slug}.md`), 'utf8');
  return raw.endsWith('\n') ? raw.slice(0, -1) : raw;
}

export function loadSeedPosts(): Array<SeedPost & { bodyMd: string }> {
  return SEED_POSTS.map((post) => ({ ...post, bodyMd: readSeedPostBody(post.slug) }));
}
