import { StubNotice } from '@/components/StubNotice';

// Labelled stub (spec/ui.md §4): revision history is deferred (Phase 3 fix — no phase number);
// revisions keep being recorded on every save.
export function HistoryTab({ revisionCount }: { revisionCount: number }) {
  return (
    <StubNotice>
      Every save is already kept ({revisionCount} {revisionCount === 1 ? 'revision' : 'revisions'}). Browsing and restoring arrives in a
      later version.
    </StubNotice>
  );
}
