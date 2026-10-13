// Pure pieces of the TLDR tab's Generate flow (spec/ui.md §4 "TLDR tab"), kept out of the
// component so they are unit-testable without a DOM.

/** Where a Generate click is: idle, saving the editor first ("Save & generate"), or Jev reading. */
export type GeneratePhase = 'idle' | 'saving' | 'running';

export interface GenerateLabelInput {
  phase: GeneratePhase;
  elapsed: number;
  editorDirty: boolean;
  hasDraft: boolean;
  latestSucceeded: boolean;
}

/** The primary button's label for each phase (busy labels while a click is in flight). */
export function generateButtonLabel(input: GenerateLabelInput): string {
  if (input.phase === 'running') return `Jev is ranking… ${input.elapsed}s`;
  if (input.phase === 'saving') return 'Saving…';
  if (input.editorDirty) return 'Save & generate';
  if (input.hasDraft || input.latestSucceeded) return 'Regenerate';
  return 'Generate with Jev';
}

/**
 * Success notice (spec/ui.md §4): the server already saved Jev's top lines as the draft deck (Save
 * deck is disabled). "Jev ranked <N> sentences and picked the top <k> — saved as your draft deck."
 */
export function generatedNotice(sentenceCount: number, lineCount: number): string {
  const ranked = `${sentenceCount} ${sentenceCount === 1 ? 'sentence' : 'sentences'}`;
  const top = lineCount === 1 ? 'the top line' : `the top ${lineCount}`;
  return `Jev ranked ${ranked} and picked ${top} — saved as your draft deck. Edit them or publish.`;
}

/**
 * Single-flight guard for an async action, keyed on a mutable ref set SYNCHRONOUSLY on entry —
 * so a double-click cannot start a second run before React re-renders with a disabled button.
 * Returns undefined (and does not call `run`) when a run is already in flight.
 */
export async function runExclusive<T>(flight: { current: boolean }, run: () => Promise<T>): Promise<T | undefined> {
  if (flight.current) return undefined;
  flight.current = true;
  try {
    return await run();
  } finally {
    flight.current = false;
  }
}
