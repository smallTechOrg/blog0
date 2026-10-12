// The single list of format kinds (spec/architecture.md §5). Pure + isomorphic.
// The DB stores article_format.kind as free text, so adding a kind here needs no migration.

export const FORMAT_KINDS = ['read', 'tldr', 'listen'] as const;
export type FormatKind = (typeof FORMAT_KINDS)[number];
export type FormatStatus = 'missing' | 'generating' | 'failed' | 'ready' | 'stale' | 'text_changed' | 'unavailable';
// Phase 3 fix: no sync step any more (upload ⇒ ready); text_changed = Listen's non-blocking "recording may not match" warning.
export const FORMATS: Record<FormatKind, { label: string; icon: 'text' | 'bolt' | 'headphones'; availableFromPhase: number }> = {
  read: { label: 'Read', icon: 'text', availableFromPhase: 1 },
  tldr: { label: 'TLDR', icon: 'bolt', availableFromPhase: 1 },
  listen: { label: 'Listen', icon: 'headphones', availableFromPhase: 3 },
};

export function isFormatKind(value: string): value is FormatKind {
  return (FORMAT_KINDS as readonly string[]).includes(value);
}
