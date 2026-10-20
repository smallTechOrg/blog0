# Capability: Publication record (dates, corrections, sign-off)

**Frozen — not scheduled** (was Phase 4). Readers see no "Updated" date and no corrections note;
the schema columns exist unused (`spec/data.md`).

## What It Does
Shows readers when a piece was first published and last substantively updated, carries an
optional dated corrections note, and records optional editor sign-off before publishing.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Publish events | publish actions over time | editor | yes |
| Corrections note | Markdown ≤ 2 000 chars or empty | editor | no |
| Submit / Approve | explicit actions | editor | no |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Public dates | "Published 8 Sep 2026 · Updated 12 Oct 2026" | article header (byline line) |
| Corrections | "Correction (12 Oct 2026): …" block | article foot, above "Next" |
| Sign-off states | Submitted by X / Approved by Y with times | desk + editor |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Database | update article | inline error |

## Business Rules
- "Updated" appears only when a later publish changed the published body fingerprint and falls on
  a different calendar day (site timezone) than first publication; metadata-only or same-day
  republishes do not show it.
- The corrections note is public as soon as it is saved on a published article (it is a
  transparency record, not a draft) and shows its last-changed date; clearing it removes it.
- Sign-off is optional in v0.1: any admin may submit, approve (including their own), or publish
  directly; the desk shows the state.

## Success Criteria
- [ ] Publish on day 1, change body and republish on day 2 (injected clock) → public header shows both dates; republish with only a topic change on day 3 keeps "Updated" at day 2.
- [ ] Saving a corrections note on a published article shows it on the public page with its date without republishing.
- [ ] Submit then Approve sets status chips and records who/when; Publish still works from any state.
