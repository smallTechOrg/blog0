// The single list of format kinds (spec/architecture.md §5). Pure + isomorphic.
// The DB stores article_format.kind as free text, so adding a kind here needs no migration.

export const FORMAT_KINDS = ['read', 'tldr', 'listen'] as const;
export type FormatKind = (typeof FORMAT_KINDS)[number];
/** text_changed = Listen's non-blocking "recording may not match the text" warning. */
export type FormatStatus = 'missing' | 'generating' | 'failed' | 'ready' | 'stale' | 'text_changed';
export const FORMATS: Record<FormatKind, { label: string; icon: 'text' | 'bolt' | 'headphones' }> = {
  read: { label: 'Read', icon: 'text' },
  tldr: { label: 'TLDR', icon: 'bolt' },
  listen: { label: 'Listen', icon: 'headphones' },
};
