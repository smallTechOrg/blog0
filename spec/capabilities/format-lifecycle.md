# Capability: Format lifecycle (status, stale, regenerate)

Computed statuses for Read, TLDR and Listen are live (Phases 1 and 3). The TLDR stale banner with
an explicit **Regenerate** offer is Phase 4 (**on hold**). Listen has no regeneration step: its
timing is estimated at read time (`listen-sync.md`); exact timing is Phase 6's aligner.

## What It Does
Tracks each article format's status (missing, generating, ready, stale, text changed, failed)
and, when the text changes, marks the TLDR deck stale and offers — never performs —
regeneration, and flags a Listen recording that may no longer match the text, while the
published versions keep serving.

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
| Stale banner (Phase 4) | TLDR: "The text changed since this deck was made. Regenerate (one AI call) or edit the deck." | editor |
| Listen warning | `text_changed`: "The recording may no longer match the text" (non-blocking) | editor Listen tab, chips |
| Publish guard | a TLDR deck whose lines vanished blocks publish (`TLDR_DECK_STALE`); Listen never blocks | publish |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Database | reads only (status is computed) | the desk (or editor tab) shows its load error with **Retry** (`spec/ui.md` §4 load pattern); no chip is guessed |

## Business Rules
- Statuses are computed from fingerprints, never stored; rules in `spec/architecture.md` §5.
- Nothing regenerates automatically; the banner's buttons are the only triggers.
- The published copy of every format keeps serving until a successful publish replaces it.
- A new format kind is added by registering it (no data migration).

## Success Criteria
- [ ] Desk chips for an article with a ready deck show TLDR `ready`; after a sentence edit, `stale`; after Regenerate (Phase 4) or a deck save against the current revision, `ready`; at no point does a save create an `ai_generation` row.
- [ ] Heading-only edits leave TLDR and Listen `ready`; a paragraph text edit after an audio upload makes Listen `text_changed` and publishing still succeeds (200).
- [ ] The public page serves the published deck / Listen audio throughout; Listen marks always cover the published paragraphs.
- [ ] A failing `GET /api/admin/articles` shows the desk's "Couldn’t load the articles: …" alert with **Retry**, and Retry reloads the table.
- [ ] Registering a fake test-only format kind in a unit test makes it appear in chips without schema changes.
