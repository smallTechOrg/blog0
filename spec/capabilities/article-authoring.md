# Capability: Article authoring

Phase 1.

## What It Does
Lets a writer create an article by pasting/editing Markdown, see an immediate preview identical
to the public Read view, save versions, and publish or unpublish it.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Title | text 1–200 chars (all field limits: `spec/api.md` → article field limits) | editor | yes (to create) |
| Dek (standfirst/excerpt) | text ≤ 400 chars | editor | no (recommended) |
| Topic | text ≤ 40 chars (existing topics suggested) | editor | yes to publish |
| Body | Markdown ≤ 200 000 chars | editor (paste/type) | yes to publish |
| Slug | lowercase words joined by hyphens, ≤ 80 | auto from title; editable before first publish | yes (auto) |
| Byline | text ≤ 80 | defaults to the writer's name | yes (auto) |
| Featured + rank, "in progress" badge | flags | editor settings | no |
| Base revision | id of the revision the writer started from | editor | yes on save |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Live preview | rendered Read view + warnings + word count/read time + eligible sentence count | editor |
| Revision | immutable copy of title/dek/body, author, time, fingerprints | database |
| Article state | draft / published (+ submitted/approved modelled) | database, desk |
| Format chips | Read / TLDR / Listen status per article | desk, editor |
| Public article | the published revision | reader site |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Database | read/write articles, revisions, formats | error shown inline with Retry; editor content is never discarded |

## Business Rules
- The preview renders through the same renderer and components as the public page; it refreshes
  ~300 ms after typing stops; a slower older response never overwrites a newer one.
- Supported Markdown: headings (the shallowest level used becomes the section level), bold,
  italic, strikethrough, links (external open in a new tab), ordered/unordered/nested lists,
  task lists, blockquotes, horizontal rules, fenced code with syntax highlighting, tables,
  footnotes (rendered as a "Notes" section), images (alone on a line → captioned figure using the
  image title as caption), and figure markers `@@fig:slide47@@` / `@@fig:ab-companies@@` on their
  own line. Raw HTML is not rendered (warning shown). Unknown figure ids render nothing publicly
  and show a warning in preview.
- Every paragraph gets a stable bookmark id derived from its own text; editing one paragraph never
  changes another's id.
- Saving creates a new revision only when title, dek or body changed; metadata changes (topic,
  slug, byline, featured, badge) apply without a revision.
- A save based on a revision that is no longer the latest is refused with a message naming who
  saved the newer one; nothing is overwritten.
- The slug is unique per site and cannot change after the first publish.
- Publishing requires title, topic and non-empty body; it publishes the latest saved revision and
  the TLDR draft deck if one exists and every line still occurs in that revision; a deck with
  vanished lines blocks publishing with the list of those lines. No deck → the article publishes
  and TLDR is not offered to readers (its capsule mode is disabled).
- After publishing, further saves do not change what readers see until **Publish changes**.
- Unpublish hides the article from readers (404) and keeps everything for republishing.
- Only never-published articles can be deleted (with confirmation).
- Publishing never calls the AI.

## Hard-case fixture (`tests/fixtures/articles/hard-cases.md`)
Must contain, each at least once: `#`, `##`, `###` headings; a bold run ending in a full stop
followed by another sentence (`**Humans are creatures of convenience.** Even …`); a link whose
URL contains full stops; abbreviations "e.g.", "U.S.", "Dr."; a decimal "3.5%"; a sentence ending
in `?` and one in `!`; a closing curly quote after a full stop; non-ASCII text
"Madhupiṇḍikasutta" and an emoji; a tight list and a loose list, one nested; a 3-line
blockquote; a fenced `ts` code block containing a full stop and a fenced block with an unknown
language `foo`; inline code `a.b()`; a 3×3 GFM table; two footnotes `[^1]` `[^note]`; an image
alone on a line with a title and an inline image; `---`; a raw `<div>` line; `@@fig:slide47@@`
and `@@fig:does-not-exist@@`; two paragraphs with identical text; a paragraph of only 3 words.

## Success Criteria
- [ ] Preview of `hard-cases.md` returns blocks containing: `<h2`, `<h3`, `<table`, a syntax-highlighted `<pre>` code block (per-token coloured spans for both themes), a footnotes section with a visible "Notes" heading, `figure.mdfig` with `figcaption`, `img.mdimg`, `<hr`, `<del`; a `figure` block `slide47` (known) and one `does-not-exist` (known=false); warnings `UNKNOWN_FIGURE`, `RAW_HTML_DROPPED`, `UNKNOWN_CODE_LANG`; no `<div>` from the raw HTML line.
- [ ] Sentence split of `hard-cases.md`: "e.g.", "U.S.", "Dr." and "3.5%" do not end sentences; the bold-run paragraph yields two sentences whose text has no asterisks; the 3-word paragraph yields no eligible sentence; code, table cells, headings and footnote definitions contribute no sentences.
- [ ] The two identical paragraphs get ids `p-xxxxxxxx` and `p-xxxxxxxx-2`; changing an unrelated paragraph leaves every other id unchanged (asserted by rendering before/after).
- [ ] Rendering the same input twice yields identical blocks, ids and fingerprints.
- [ ] Create → save (body changed) → save (only topic changed) produces revisions 1 and 2 only; the second save returns `revisionCreated: false`.
- [ ] A save with a stale `baseRevisionId` returns 409 `CONFLICT` and the stored body is unchanged.
- [ ] Publish without topic returns 422 `PUBLISH_BLOCKED` with reason `TOPIC_REQUIRED`.
- [ ] After publish, saving new text leaves the public view model on the published revision; `hasUnpublishedChanges` is true on the desk; **Publish changes** moves the public view to the new revision.
- [ ] Unpublish → public slug 404; republish → 200 with the same content.
- [ ] Delete of a published-once article → 409 `NOT_DELETABLE`; delete of a never-published draft removes it and its revisions.
- [ ] The editor never loses typed text on a failed save (E2E: server error simulated by stale base revision shows the conflict message and the textarea still holds the text).
