# Capability: Revision history

**Status: Frozen — not scheduled** (user decisions, 2026-10-13 — removed from Phase 4, then the
project froze). Revisions are still recorded on every content save from Phase 1, so nothing is
lost; this file is kept as the spec of the unbuilt feature. The editor History tab stays a
labelled stub.

## What It Does
Lets writers browse every saved version of an article, view it rendered, and restore it.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Article | id | editor History tab | yes |
| Revision to view/restore | revision number | History tab | yes |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Revision list | number, author, time, title, word count, published/current markers | History tab |
| Rendered revision | Read view of that version | History tab |
| Restored revision | new latest revision copying the old content, linked to its source | database, editor |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Database | read revisions, insert restored revision | inline error + retry |

## Business Rules
- Revisions are immutable and never deleted while the article exists.
- Restore never rewrites history: it creates a new revision (author = the restorer) and requires
  the editor to be on the latest revision (same conflict rule as saving).
- Restoring does not publish; derived formats follow normal stale rules.

## Success Criteria
- [ ] Three saves produce revisions 1–3 listed newest first with author names and the published one marked.
- [ ] Viewing revision 1 shows its rendered body.
- [ ] Restoring revision 1 creates revision 4 whose body equals revision 1's and whose `restoredFromRevisionId` is revision 1; revisions 1–3 are unchanged.
- [ ] Restore with a stale base → 409 `CONFLICT`.
