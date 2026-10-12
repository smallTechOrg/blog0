import 'server-only';

import { readFileSync } from 'node:fs';
import path from 'node:path';

// Versioned system prompt (spec/agent.md §4). Any wording change → new file select-v2.md + bump
// JEV_PROMPT_VERSION; old files stay for audit. The version is stored on every generation row.

export const JEV_PROMPT_VERSION = 'jev-select-v1';
export const JEV_PROMPT_FILE = 'select-v1.md';

/** Resolved from the repo root (every command runs there — see README), like the seed posts. */
export function promptPath(file: string = JEV_PROMPT_FILE): string {
  return path.join(process.cwd(), 'src', 'server', 'jev', 'prompts', file);
}

const cache = new Map<string, string>();

/** Raw template text (cached per file). */
export function loadPromptTemplate(file: string = JEV_PROMPT_FILE): string {
  let text = cache.get(file);
  if (text === undefined) {
    text = readFileSync(promptPath(file), 'utf8');
    cache.set(file, text);
  }
  return text;
}

export interface PromptVars {
  siteName: string;
}

/** Fills `{{site_name}}`; throws if any `{{placeholder}}` is left unfilled. */
export function renderPrompt(template: string, vars: PromptVars): string {
  const values: Record<string, string> = { site_name: vars.siteName };
  const rendered = template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, name: string) => values[name] ?? match);
  const leftover = /\{\{\s*[a-z_]+\s*\}\}/.exec(rendered);
  if (leftover) throw new Error(`Jev prompt ${JEV_PROMPT_VERSION} has an unfilled placeholder ${leftover[0]}`);
  return rendered;
}

/** The rendered system prompt for JEV_PROMPT_VERSION. */
export function loadPrompt(vars: PromptVars): { version: string; text: string } {
  return { version: JEV_PROMPT_VERSION, text: renderPrompt(loadPromptTemplate(), vars) };
}

export function resetPromptCacheForTests(): void {
  cache.clear();
}
