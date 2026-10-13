// Plain text of a Markdown article, close enough to the rendered prose to check that a TLDR line
// is verbatim: emphasis markers, link targets, footnote refs and inline code ticks removed.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const E2E_ARTICLE_PATH = path.join(process.cwd(), 'tests', 'fixtures', 'articles', 'e2e-article.md');

export function readE2eArticle(): string {
  return readFileSync(E2E_ARTICLE_PATH, 'utf8');
}

export function markdownPlainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[\^[^\]]+\]:?/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|\*|_|`/g, '')
    .replace(/\s+/g, ' ');
}
