import { StubNotice } from '@/components/StubNotice';

// Labelled stub (spec/ui.md §4): browsing revision history is deferred (no phase number);
// revisions keep being recorded on every save.
export function HistoryTab({ revisionCount }: { revisionCount: number }) {
  return (
    <StubNotice>
      Every save is already kept ({revisionCount} {revisionCount === 1 ? 'revision' : 'revisions'}). Browsing and restoring arrives in a
      later version.
    </StubNotice>
  );
}
