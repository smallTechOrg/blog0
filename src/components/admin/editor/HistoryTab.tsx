import { StubNotice } from '@/components/StubNotice';

// Phase 1–3 placeholder (spec/ui.md §4); S4.1 takes this file over.
export function HistoryTab({ revisionCount }: { revisionCount: number }) {
  return (
    <StubNotice>
      Every save is already kept ({revisionCount} {revisionCount === 1 ? 'revision' : 'revisions'}). Browsing and restoring
      arrives in Phase 4.
    </StubNotice>
  );
}
