import 'server-only';

import type { RenderedArticle } from '@/lib/content/types';

import type { ChatMessage } from '../llm/types';
import { loadPrompt } from './prompt';
import { JEV_MAX_LIST_CHARS, JEV_MAX_SENTENCES, type JevBounds, type JevError, type JevInput } from './state';

// spec/agent.md §2 steps 2, 3 and 6: guardInput, buildMessages, repairMessages.

export const JEV_SCHEMA_NAME = 'jev_selection';

/** Strict JSON schema sent as response_format. Numeric bounds are deliberately NOT here (§3). */
export const JEV_SELECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['picks'],
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'reason'],
        properties: { index: { type: 'integer' }, reason: { type: 'string' } },
      },
    },
  },
} as const;

/** Builds JevInput from a rendered revision (sentences + heading paths by paragraph id). */
export function jevInputFromRendered(args: {
  articleId: string;
  revisionId: string;
  title: string;
  dek: string;
  rendered: Pick<RenderedArticle, 'sentences' | 'paragraphs'>;
  requestId: string;
}): JevInput {
  const headingPathByPid: Record<string, string[]> = {};
  for (const p of args.rendered.paragraphs) headingPathByPid[p.pid] = p.headingPath;
  return {
    articleId: args.articleId,
    revisionId: args.revisionId,
    title: args.title,
    dek: args.dek,
    sentences: args.rendered.sentences,
    headingPathByPid,
    requestId: args.requestId,
  };
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

function sectionOf(input: JevInput, pid: string): string {
  const path = input.headingPathByPid[pid] ?? [];
  return path.length === 0 ? '(intro)' : path.map(oneLine).join(' › ');
}

/** `[i] · section · text` lines, one per eligible sentence. */
export function renderSentenceList(input: JevInput): string {
  return input.sentences.map((s, i) => `[${i}] · ${sectionOf(input, s.pid)} · ${oneLine(s.text)}`).join('\n');
}

/** Pure pre-flight: an error means NO model call (and no generation row). */
export function guardInput(input: JevInput, _bounds: JevBounds): JevError | null {
  const n = input.sentences.length;
  if (n === 0) {
    return { code: 'JEV_NO_SENTENCES', message: 'This article has no sentences of five or more words to choose from.' };
  }
  const listChars = n > JEV_MAX_SENTENCES ? Infinity : renderSentenceList(input).length;
  if (n > JEV_MAX_SENTENCES || listChars > JEV_MAX_LIST_CHARS) {
    return {
      code: 'JEV_INPUT_TOO_LONG',
      message: `This article is too long for Jev (limit ${JEV_MAX_SENTENCES} sentences / ${JEV_MAX_LIST_CHARS.toLocaleString('en-US')} characters) — pick lines by hand.`,
    };
  }
  return null;
}

export function buildUserMessage(input: JevInput, bounds: JevBounds): string {
  const dek = oneLine(input.dek);
  return [
    `TITLE: ${oneLine(input.title)}`,
    `DEK: ${dek === '' ? '(none)' : dek}`,
    `PICK BETWEEN ${bounds.min} AND ${bounds.max} SENTENCES (aim for ${bounds.target}).`,
    'SENTENCES (index · section · text):',
    '<<<SENTENCES',
    renderSentenceList(input),
    'SENTENCES>>>',
  ].join('\n');
}

export function buildMessages(input: JevInput, bounds: JevBounds, opts: { siteName: string }): ChatMessage[] {
  return [
    { role: 'system', content: loadPrompt({ siteName: opts.siteName }).text },
    { role: 'user', content: buildUserMessage(input, bounds) },
  ];
}

export function repairText(errors: readonly string[], bounds: JevBounds, n: number): string {
  return (
    `Your previous answer was invalid: ${errors.join('; ')}. ` +
    `Return only corrected JSON that follows the schema, choosing between ${bounds.min} and ${bounds.max} indices from 0 to ${n - 1}.`
  );
}

/** Appends the invalid assistant output and the repair instruction. */
export function repairMessages(
  state: { messages: ChatMessage[]; bounds: JevBounds; input: JevInput },
  rawOutput: string,
  errors: readonly string[],
): ChatMessage[] {
  return [
    ...state.messages,
    { role: 'assistant', content: rawOutput.trim() === '' ? '(empty response)' : rawOutput },
    { role: 'user', content: repairText(errors, state.bounds, state.input.sentences.length) },
  ];
}
