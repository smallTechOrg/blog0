import 'server-only';

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { loadSeedPosts } from '../seed/posts';

// The 6 Jev evaluation articles (spec/agent.md §7): the 5 seed posts + tests/fixtures/articles/hard-cases.md.
// Shared by tests/integration/jev-openrouter.test.ts and scripts/eval-jev.ts.

export interface JevEvalArticle {
  slug: string;
  title: string;
  dek: string;
  bodyMd: string;
}

export const HARD_CASES_PATH = path.join(process.cwd(), 'tests', 'fixtures', 'articles', 'hard-cases.md');

export function loadJevEvalArticles(): JevEvalArticle[] {
  const posts = loadSeedPosts().map(({ slug, title, dek, bodyMd }) => ({ slug, title, dek, bodyMd }));
  const hard = readFileSync(HARD_CASES_PATH, 'utf8');
  const h1 = /^#\s+(.+)\n+/.exec(hard);
  return [
    ...posts,
    {
      slug: 'hard-cases',
      title: h1 ? h1[1].trim() : 'Hard Cases',
      dek: '',
      bodyMd: h1 ? hard.slice(h1[0].length) : hard,
    },
  ];
}
