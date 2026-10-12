import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadSeedPosts, readSeedPostBody, SEED_POSTS } from '@/server/seed/posts';
import { SITE_DEFAULTS } from '@/server/site/defaults';

interface DesignPost { id: string; title: string; tag: string; date: string; author: string; excerpt: string; draft?: boolean; md: string }

/** Evaluates the design's `var POSTS = [...]` literal (pure data) from spec/design/design-app.js. */
function designPosts(): DesignPost[] {
  const src = readFileSync(path.join(process.cwd(), 'spec', 'design', 'design-app.js'), 'utf8');
  const start = src.indexOf('var POSTS = [');
  const end = src.indexOf('\n];', start) + 3;
  return new Function(`${src.slice(start, end)}\nreturn POSTS;`)() as DesignPost[];
}

describe('seed posts', () => {
  it('ships the five design articles with bodies byte-identical to POSTS[].md', () => {
    const design = designPosts();

    const seeded = loadSeedPosts();

    expect(seeded.map((p) => p.slug)).toEqual(design.map((p) => p.id));
    for (const post of design) {
      const seed = seeded.find((p) => p.slug === post.id);
      expect(seed?.bodyMd).toBe(post.md);
      expect(seed).toMatchObject({ title: post.title, topic: post.tag, date: post.date, bylineName: post.author, dek: post.excerpt, inProgress: post.draft === true });
    }
  });

  it('marks the design FEATURED_HITS order as featured ranks 1-3', () => {
    const ranked = SEED_POSTS.filter((p) => p.featuredRank !== null).sort((a, b) => (a.featuredRank ?? 0) - (b.featuredRank ?? 0));

    expect(ranked.map((p) => p.slug)).toEqual(['ai-will-destroy-the-world', 'tech-company-first', 'humans-are-software']);
  });

  it('refuses an unknown seed slug', () => {
    expect(() => readSeedPostBody('nope')).toThrow(/Unknown seed post/);
  });
});

describe('site defaults', () => {
  it('match the seed values in spec/data.md', () => {
    expect(SITE_DEFAULTS).toMatchObject({
      slug: 'blog0',
      brandName: 'blog0',
      wordmark: 'blog0',
      publisherName: 'smallTech',
      tagline: 'the meaning of life, universe, and everything',
      contactEmail: 'hello@logzero.blog',
      aboutStrap: 'Less noise. More signal.',
      timezone: 'Asia/Kolkata',
      socialXUrl: null,
      socialLinkedinUrl: null,
    });
    expect(SITE_DEFAULTS.aboutBodyMd.split('\n\n')).toHaveLength(2);
    expect(SITE_DEFAULTS.aboutBodyMd).not.toMatch(/Placeholder/);
  });

  it('brand the site blog0 (divergence 25): no whole-word "log0" in any seeded text', () => {
    for (const value of Object.values(SITE_DEFAULTS)) {
      if (typeof value === 'string') expect(value).not.toMatch(/\blog0\b/);
    }
    expect(SITE_DEFAULTS.wordmark.slice(-1)).toBe('0'); // the nought that spins
  });

  it('seed the design ABOUT_BODY_FULL verbatim, one paragraph per entry', () => {
    const src = readFileSync(path.join(process.cwd(), 'spec', 'design', 'design-app.js'), 'utf8');
    const start = src.indexOf('var ABOUT_BODY_FULL = [');
    const end = src.indexOf('\n];', start) + 3;
    const design = new Function(`${src.slice(start, end)}\nreturn ABOUT_BODY_FULL;`)() as string[];

    expect(SITE_DEFAULTS.aboutBodyMd.split('\n\n')).toEqual(design);
    expect(SITE_DEFAULTS.aboutStand).toBe(/var ABOUT_STAND = '([^']+)';/.exec(src)?.[1]);
    expect(SITE_DEFAULTS.aboutStrap).toBe(/var ABOUT_STRAP = '([^']+)';/.exec(src)?.[1]);
  });
});

describe('hard-cases fixture', () => {
  const md = readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'articles', 'hard-cases.md'), 'utf8');

  it.each([
    ['h1', /^# /m],
    ['h2', /^## /m],
    ['h3', /^### /m],
    ['bold run then sentence', /\*\*Humans are creatures of convenience\.\*\* Even /],
    ['link URL with full stops', /\]\(https:\/\/[^)]*\.[^)]*\.[^)]*\)/],
    ['e.g.', /e\.g\./],
    ['U.S.', /U\.S\./],
    ['Dr.', /Dr\. /],
    ['decimal percent', /3\.5%/],
    ['question', /\? /],
    ['exclamation', /! /],
    ['closing curly quote after full stop', /\.”/],
    ['non-ASCII', /Madhupiṇḍikasutta/],
    ['emoji', /\p{Extended_Pictographic}/u],
    ['nested list item', /^ {2}- /m],
    ['loose ordered list', /^1\. .+\n\n2\. /m],
    ['3-line blockquote', /^> .+\n> .+\n> .+$/m],
    ['ts fence', /^```ts\n[\s\S]*?\.[\s\S]*?```/m],
    ['unknown language fence', /^```foo$/m],
    ['inline code a.b()', /`a\.b\(\)`/],
    ['table', /^\| .+ \| .+ \| .+ \|\n\| --- \| --- \| --- \|/m],
    ['footnote 1', /\[\^1\]:/],
    ['footnote note', /\[\^note\]:/],
    ['image alone with title', /^!\[[^\]]+\]\([^ )]+ "[^"]+"\)$/m],
    ['inline image', /\S !\[[^\]]*\]\([^)]+\) \S/],
    ['rule', /^---$/m],
    ['raw div', /^<div/m],
    ['known figure', /^@@fig:slide47@@$/m],
    ['unknown figure', /^@@fig:does-not-exist@@$/m],
    ['3-word paragraph', /^Only three words\.$/m],
    ['GFM strikethrough', /\S ~~[^~\n]+~~ \S/],
    ['open task item', /^- \[ \] \S/m],
    ['done task item', /^- \[x\] \S/m],
  ])('contains %s', (_name, pattern) => {
    expect(md).toMatch(pattern);
  });

  it('contains two paragraphs with identical text', () => {
    const paragraphs = md.split(/\n{2,}/).map((p) => p.trim());
    const counts = new Map<string, number>();
    for (const p of paragraphs) counts.set(p, (counts.get(p) ?? 0) + 1);

    expect([...counts.values()].some((n) => n >= 2)).toBe(true);
  });
});
