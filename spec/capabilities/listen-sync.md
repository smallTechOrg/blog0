# Capability: Listen — tap-along paragraph sync + reader highlight

Phase 3 (paragraph level). Phase 6 upgrades to automatic sentence-level alignment on top of the
same payload. Audio upload/streaming: `listen-audio`. Screens: `spec/ui.md` §4 *Listen tab* and
§3 *Listen*. Status rules: `spec/architecture.md` §5. Pure helpers shared by server, admin and
reader: `src/lib/listen/marks.ts` (`spec/architecture.md` §9.4).

## What It Does
Lets the writer sync the reading to the text by tapping (Space or a big button) at the start of
each paragraph while the audio plays, then lets readers see the current paragraph highlighted and
auto-scrolled as the audio plays, with seeking and paragraph clicks keeping text and audio
together.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Taps | one timestamp (`tMs`, integer ms of `audio.currentTime`) per paragraph, in document order | writer: Space key or the big **Tap** button during playback | yes |
| Nudges | ±250 ms on one mark | writer | no |
| Redo from a paragraph | choose paragraph k: discard marks k…end, seek, re-tap | writer | no |
| Save sync | `PUT …/listen { revisionId, marks }` | writer | yes |
| Playback position | `audio.currentTime`, `seeked` | reader's player | yes |
| Paragraph click | click on a `.para` in the Listen view | reader | no |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Marks | `marks: [{ pid, tMs }]` for every paragraph of the revision + `syncFingerprint` | Listen draft → published on publish |
| Status | `missing` / `needs_sync` / `ready` / `stale` | desk chip, editor tab chip, Listen tab header |
| Stale report | `missingPids` (paragraphs without a mark) and `orphanPids` (marks whose paragraph is gone) | Listen tab |
| Reader highlight | the current paragraph carries `.para.is-live` and is scrolled to centre | reader Listen view |
| Publish guard | `PUBLISH_BLOCKED` reason `LISTEN_STALE` | editor publish popover |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Database | read current revision paragraphs + draft; write marks | inline error in the Listen tab; the marks stay in the page so **Save sync** can be retried |

## Business Rules
- **Paragraph list** = the current revision's `RenderedArticle.paragraphs` in document order
  (every `p`, `li`, `quote` paragraph that has a `pid`; headings, code blocks, tables, figures and
  footnotes are not paragraphs and are never marked). The list comes from the server
  (`ListenStateDto.paragraphs`), never from the editor textarea.
- **Sync walks the list in order.** Start syncing plays the recording from 0 with paragraph 1 as
  "next"; each tap stamps the next paragraph with the player's current time and advances; the
  last tap pauses the audio and enables **Save sync**. Taps less than 300 ms apart are ignored.
  **Undo** (Backspace) removes the last mark and seeks to 1 s before it. **Restart** clears all
  marks (confirm) and plays from 0. **Redo from here** on paragraph k discards marks k…end,
  seeks to the mark of paragraph k−1 (or 0), plays, and sets k as next.
- A mark must be an integer `tMs ≥ 0`; the set must contain **exactly one mark per current
  paragraph, in document order, strictly increasing, every `tMs < durationMs`**; the first mark
  may be > 0 (an intro). Violations → 422 `MARKS_INVALID` with every reason listed.
- **Nudge** moves one mark by ±250 ms; a nudge that would break strict ordering or the duration
  bound is refused (button disabled at the bound). Nudges and marks are unsaved until **Save
  sync**; leaving the tab/page with unsaved marks asks for confirmation.
- Syncing requires the editor's text to be saved (sync runs against the saved revision): with
  unsaved text changes the panel disables Start syncing with "Save your text changes first —
  sync works against the saved article."
- If the recording ends before every paragraph is marked, syncing stops with "The recording
  ended before paragraph N — redo from an earlier paragraph, or upload a longer recording."
- **Stale.** `syncFingerprint` is the revision's paragraphs fingerprint at save time. Any later
  save whose paragraph set changes (one paragraph's text edited, a paragraph added, removed or
  reordered — paragraph ids are content-derived, so this is exactly "the pid list changed")
  makes the draft **stale**. Marks for paragraphs that still exist are kept; `missingPids` lists
  the new/edited ones; `orphanPids` lists marks whose paragraph vanished (dropped on the next
  save). Heading-only, code-only or table-only edits do not change the paragraph set and leave
  Listen `ready`. Nothing is ever re-synced or regenerated automatically.
- **Re-sync vs re-record.** The Listen tab's stale banner says the text changed since the sync,
  lists the affected paragraphs, offers **Redo from here** at the first missing paragraph (keeps
  the recording), and warns that if the *words* changed the recording no longer matches and a
  new reading must be uploaded (which clears all marks).
- **Publishing** a revision whose paragraph set differs from the draft's `syncFingerprint`
  (status `stale`) is blocked with reason `LISTEN_STALE` (`details.missingPids`,
  `details.orphanPids`). Publishing with audio but no marks (`needs_sync`) is allowed when the
  published Listen (if any) still matches the revision being published — Listen is then simply
  not updated (no published Listen → not offered); when the published Listen no longer matches
  the text and the draft cannot replace it, publishing is blocked with `LISTEN_STALE`
  ("the live reading no longer matches the text — sync the recording or remove the audio").
  Publishing with no Listen draft at all clears the published Listen. The previously published
  Listen keeps serving throughout.
- **Reader highlight.** The live paragraph is the one with the greatest `tMs ≤ currentTimeMs`;
  before the first mark nothing is live. The highlight updates on `timeupdate` and immediately
  on `seeked`; it is applied to the paragraph element with that `data-pid` as class `is-live`
  (one at a time). When the live paragraph changes, it is scrolled to the centre of the scroll
  container (`behavior: 'smooth'`, or `'auto'` under reduced motion) unless the reader scrolled
  manually (wheel, touch, scroll keys) in the last 4 s. Clicking a paragraph seeks to its mark
  without changing the play state; keyboard Space toggles play, ←/→ seek ±5 s (ignored when the
  focus is in a form control).
- Readers get the **published** marks over the **published** revision only (both copied on
  publish, fingerprints equal by the guard), so a later edit never desynchronises the live page.
- Phase 6's sentence-level alignment adds finer marks on the same payload without changing this
  contract; Phase 3 never attempts alignment.

## Success Criteria
- [ ] Unit (`tests/unit/listen/marks.test.ts`): `validateMarks(marks, paragraphs, durationMs)` returns `ok` for a complete increasing set and lists, with codes, each of: unknown pid (`UNKNOWN_PID`), missing paragraph (`MISSING_PID`), duplicate pid (`DUPLICATE_PID`), out of order vs document order (`OUT_OF_ORDER`), equal or decreasing times (`NOT_INCREASING`), `tMs ≥ durationMs` or negative or non-integer (`OUT_OF_RANGE`); `activeMarkIndex(marks, tMs)` returns −1 before the first mark, k when `marks[k].tMs ≤ tMs < marks[k+1].tMs`, and the last index at/after the last mark; `nudgeMark(marks, k, ±250)` refuses when ordering or the duration bound would break; `fmtClock(61_000)` is `1:01`; `listenMinutes(durationMs)` matches the design's `audioMinutes` for 0, 29 999, 30 000, 150 000, 1 799 999 ms.
- [ ] Integration (`tests/integration/listen-sync.test.ts`): `GET …/listen` for an article with uploaded audio lists exactly the current revision's paragraphs in order with their `pid` and plain text and `status 'needs_sync'`, `missingPids` = all pids; `PUT` with a complete increasing set → 200, `status 'ready'`, `syncFingerprint` = the revision's paragraphs fingerprint, the desk chip for `listen` reads `ready`; a second `GET` returns the same marks.
- [ ] `PUT` with a non-increasing pair → 422 `MARKS_INVALID` with a `NOT_INCREASING` reason naming the index; with an unknown pid → `UNKNOWN_PID`; with one paragraph omitted → `MISSING_PID`; with `tMs === durationMs` → `OUT_OF_RANGE`; with a stale `revisionId` → 409 `CONFLICT`; with no audio uploaded → 409 `LISTEN_NO_AUDIO`; none of these change the stored draft.
- [ ] Editing one paragraph's text and saving → `status 'stale'`, `missingPids` = exactly the new pid, `orphanPids` = exactly the old pid, every other mark unchanged; publish → 422 `PUBLISH_BLOCKED` with reason `LISTEN_STALE` carrying those arrays; the public article still serves the previously published marks and audio key; editing only a heading → `status` stays `ready`.
- [ ] After a stale draft is re-synced with a complete set → `ready`; publish → 200; the public article's `listen.marks` equal the new set and its `listen.audioUrl` the current key.
- [ ] Publish with audio uploaded but never synced on a never-published Listen → 200 with `times.listen === null` publicly; the same after a published Listen exists and the text did not change → 200 and the public Listen is unchanged; the same after the text changed → `PUBLISH_BLOCKED` `LISTEN_STALE`.
- [ ] E2E (Chromium, `tests/e2e/phase3-listen.spec.ts`): in the Listen tab, upload `sample.mp3`, press **Start syncing**, press Space once per paragraph at ≥ 400 ms intervals → the mark list shows one `m:ss.mmm` time per paragraph, strictly increasing; **Save sync** → tab chip `ready`; publish → the public Listen view: setting `audio.currentTime` to `(marks[k].tMs + 50) / 1000` for k = 0, 2, last makes paragraph k the only `.para.is-live` and places its bounding box inside the viewport; clicking paragraph 1 sets `audio.currentTime` to within 0.05 s of `marks[1].tMs / 1000`.
- [ ] The reader E2E creates zero `ai_generation` rows (Listen never calls the LLM).
