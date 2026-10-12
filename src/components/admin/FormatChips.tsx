import type { FormatChipDto } from '@/lib/api/dto';
import { FORMATS } from '@/lib/formats/registry';

import { chipLabel } from './labels';

// Per-format status chips (spec/ui.md §4): Read ✓, TLDR missing|generating|ready|stale|failed,
// Listen "later phase" greyed until Phase 3. Always every registered kind, in registry order.

export function FormatChips({ formats }: { formats: readonly FormatChipDto[] }) {
  return (
    <ul className="fchips" aria-label="Formats">
      {formats.map((f) => {
        const later = f.status === 'unavailable';
        const title = later
          ? `${FORMATS[f.kind]?.label ?? f.kind} arrives in Phase ${FORMATS[f.kind]?.availableFromPhase ?? '—'}`
          : f.published
            ? f.hasUnpublishedChanges
              ? 'Live; has unpublished changes'
              : 'Live'
            : 'Not published';
        return (
          <li key={f.kind} className={`fchip fchip--${f.status}`} data-kind={f.kind} data-status={f.status} title={title}>
            {chipLabel(f)}
            {f.published && !later ? <span className="fchip__live" aria-label="published" /> : null}
          </li>
        );
      })}
    </ul>
  );
}
