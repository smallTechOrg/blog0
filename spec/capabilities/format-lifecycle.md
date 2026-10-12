# Capability: Format lifecycle (status, stale, regenerate/re-sync)

Phase 1 computes statuses for Read and TLDR; Phase 4 completes the lifecycle across all formats
and adds the explicit Regenerate / Re-sync offers.

## What It Does
Tracks each article format's status (missing, generating, ready, stale, needs sync, failed) and,
when the text changes, marks derived formats stale and offers — never performs — regeneration,
while the published versions keep serving.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Current revision fingerprints | sentences / paragraphs | database | yes |
| Format drafts + published copies | payloads with their fingerprints | database | yes |
| Latest generation | status, time | database | for TLDR |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Status chips | per format | desk, editor tabs |
| Stale banner | "The text changed since this deck was made. Regenerate (one AI call) or edit the deck." / "…since this audio was synced. Re-sync the changed paragraphs." | editor |
| Publish guard | stale formats with vanished content block publish of that format | publish |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Database | reads only (status is computed) | chips show "unknown" with retry |

## Business Rules
- Statuses are computed from fingerprints, never stored; rules in `spec/architecture.md` §5.
- Nothing regenerates or re-syncs automatically; the banner's buttons are the only triggers.
- The published copy of every format keeps serving until a successful publish replaces it.
- A new format kind is added by registering it (no data migration).

## Success Criteria
- [ ] Desk chips for an article with a ready deck show TLDR `ready`; after a sentence edit, `stale`; after Regenerate, `ready`; at no point does a save create an `ai_generation` row.
- [ ] Heading-only edits leave TLDR `ready`; paragraph text edits make Listen `stale`.
- [ ] The public page serves the published deck/cues throughout.
- [ ] Registering a fake test-only format kind in a unit test makes it appear in chips without schema changes.
