import type { FormatChipDto } from '@/lib/api/dto';

import { chipLabel } from './labels';

// Per-format status chips (spec/ui.md §4): Read ✓, TLDR missing|generating|ready|stale|failed,
// Listen missing|ready|text changed. Always every registered kind, in registry order.

export function FormatChips({ formats }: { formats: readonly FormatChipDto[] }) {
  return (
    <ul className="fchips" aria-label="Formats">
      {formats.map((f) => {
        const title = f.published ? (f.hasUnpublishedChanges ? 'Live; has unpublished changes' : 'Live') : 'Not published';
        return (
          <li key={f.kind} className={`fchip fchip--${f.status}`} data-kind={f.kind} data-status={f.status} title={title}>
            {chipLabel(f)}
            {f.published ? <span className="fchip__live" aria-label="published" /> : null}
          </li>
        );
      })}
    </ul>
  );
}
