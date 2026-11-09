import 'server-only';

import type { RenderedArticle } from '@/lib/content/types';

import { JEV_MAX_SENTENCES, JEV_MAX_STATE_CHARS, type JevDecisionState, type JevError, type JevInput } from './state';

// spec/agent.md §2 steps 2–3: buildState (the decisions `state`) and guardInput. Pure.

export const JEV_TOO_LONG_MESSAGE =
  'This article is too long for Jev (limit 400 sentences / about 5 000 words) — pick lines by hand.';
export const JEV_NO_SENTENCES_MESSAGE = 'This article has no sentences of five or more words to choose from.';

/** Builds JevInput from a rendered revision. */
export function jevInputFromRendered(args: {
  articleId: string;
  revisionId: string;
  title: string;
  dek: string;
  rendered: Pick<RenderedArticle, 'sentences' | 'paragraphs'>;
  requestId: string;
}): JevInput {
  return {
    articleId: args.articleId,
    revisionId: args.revisionId,
    title: args.title,
    dek: args.dek,
    sentences: args.rendered.sentences,
    paragraphs: args.rendered.paragraphs,
    requestId: args.requestId,
  };
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * `{ title, dek, article }`: title/dek whitespace-collapsed; article = every paragraph's plain text
 * in document order separated by a blank line, with `## <heading>` inserted before the first
 * paragraph whose heading (last element of its headingPath) differs from the previous paragraph's.
 */
export function buildState(input: Pick<JevInput, 'title' | 'dek' | 'paragraphs'>): JevDecisionState {
  const parts: string[] = [];
  let previous: string | null = null;
  for (const p of input.paragraphs) {
    const heading = p.headingPath.length > 0 ? oneLine(p.headingPath[p.headingPath.length - 1]) : null;
    if (heading !== null && heading !== previous) parts.push(`## ${heading}`);
    previous = heading;
    parts.push(p.text);
  }
  return { title: oneLine(input.title), dek: oneLine(input.dek), article: parts.join('\n\n') };
}

/** Pure pre-flight: an error means NO model call (and no generation row). */
export function guardInput(input: Pick<JevInput, 'sentences'>, state: JevDecisionState): JevError | null {
  const n = input.sentences.length;
  if (n === 0) return { code: 'JEV_NO_SENTENCES', message: JEV_NO_SENTENCES_MESSAGE };
  if (n > JEV_MAX_SENTENCES || JSON.stringify(state).length > JEV_MAX_STATE_CHARS) {
    return { code: 'JEV_INPUT_TOO_LONG', message: JEV_TOO_LONG_MESSAGE };
  }
  return null;
}
