import 'server-only';

import rehypeShikiFromHighlighter from '@shikijs/rehype/core';
import { createHighlighter, type HighlighterGeneric } from 'shiki';

import type { HRoot } from './ast';

// Shiki syntax highlighting (spec/architecture.md §4): dual theme via CSS variables
// (`--shiki-light` / `--shiki-dark`, `defaultColor: false`), a fixed preloaded language set,
// anything else rendered as plain text (warning UNKNOWN_CODE_LANG raised by plugins/code-langs).

export const PRELOADED_LANGS = [
  'ts', 'tsx', 'js', 'jsx', 'json', 'bash', 'shell', 'python', 'sql', 'yaml', 'markdown', 'html',
  'css', 'go', 'rust', 'diff',
] as const;

export const SHIKI_THEMES = { light: 'github-light', dark: 'github-dark' } as const;

/** Language used for fences without a language and for unsupported ones. */
export const PLAIN_LANG = 'text';

/** Shiki's built-in plain-text ids (never highlighted, always accepted). */
const PLAIN_LANGS = new Set(['text', 'txt', 'plain', 'plaintext']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- shiki's own generic default
type Highlighter = HighlighterGeneric<any, any>;

let highlighterPromise: Promise<Highlighter> | null = null;
let loadedLangs: Set<string> | null = null;

/** Process-wide highlighter singleton (grammar loading is the expensive part). */
export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [SHIKI_THEMES.light, SHIKI_THEMES.dark],
      langs: [...PRELOADED_LANGS],
    }).then((h) => {
      loadedLangs = new Set(h.getLoadedLanguages());
      return h;
    });
    highlighterPromise.catch(() => {
      highlighterPromise = null;
    });
  }
  return highlighterPromise;
}

/**
 * True when a fence language renders highlighted (a preloaded language or one of its aliases,
 * case-insensitive) or is explicit plain text. Requires `await getHighlighter()` first.
 */
export function isSupportedCodeLang(lang: string): boolean {
  const id = lang.toLowerCase();
  if (PLAIN_LANGS.has(id)) return true;
  if (!loadedLangs) throw new Error('isSupportedCodeLang() called before getHighlighter() resolved');
  return loadedLangs.has(id);
}

/** Replaces every `<pre><code class="language-…">` in the tree with Shiki's highlighted hast. */
export async function highlightCode(tree: HRoot): Promise<void> {
  const highlighter = await getHighlighter();
  const transform = rehypeShikiFromHighlighter(highlighter, {
    themes: SHIKI_THEMES,
    defaultColor: false,
    defaultLanguage: PLAIN_LANG,
    fallbackLanguage: PLAIN_LANG,
  }) as unknown as (tree: HRoot) => void | Promise<void>;
  await transform(tree);
}
