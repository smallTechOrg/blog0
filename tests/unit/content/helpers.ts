import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Block, RenderedArticle } from '@/lib/content/types';
import { renderArticle } from '@/server/content';

export const HARD_CASES_MD = readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'articles', 'hard-cases.md'), 'utf8');

export function render(bodyMd: string, title = 'Title', dek = 'Dek'): Promise<RenderedArticle> {
  return renderArticle({ title, dek, bodyMd });
}

export function html(blocks: Block[]): string {
  return blocks.map((b) => (b.kind === 'html' ? b.html : `<!--figure:${b.figureId}:${b.known}-->`)).join('\n');
}

export function sentenceTexts(r: RenderedArticle): string[] {
  return r.sentences.map((s) => s.text);
}
