# Capability: Listen — paragraph timing (estimated by default) + reader follow

Phase 3 (paragraph level). Timing is **estimated** from the recording's length and each
paragraph's word count (user decision: no manual syncing). Exact timing is the Phase 6 local
aligner (no paid speech-to-text), which writes marks into the sync storage kept here.
Audio upload/streaming: `listen-audio`. Screens: `spec/ui.md` §3 *Listen* and §4 *Listen tab*.
Status rules: `spec/architecture.md` §5. Pure helpers: `src/lib/listen/estimate.ts` and
`src/lib/listen/marks.ts` (`spec/architecture.md` §9.4).

## What It Does
Gives every published recording paragraph timings without any writer effort — estimated at read
time from the published text and the recording's duration, or taken from stored marks when they
cover the text — and lets readers follow along: the text scrolls with the audio and softly
highlights the current paragraph, pauses following when the reader scrolls, and resumes on
**Follow audio**; clicking a paragraph seeks there.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Published paragraphs | `RenderedArticle.paragraphs` of the **published** revision (pid + plain text) | database (render cache) | yes |
| Recording duration | `audio.durationMs` of the published Listen payload | database | yes |
| Stored marks | `marks: [{ pid, tMs }]` in the Listen payload — written only by `PUT …/listen` (Phase 6 aligner; legacy data) | database | no |
| Playback position | `audio.currentTime`, `timeupdate`, `seeked` | reader's player | yes |
| Manual scroll | `wheel`, `touchmove`, scroll keys | reader | no |
| **Follow audio** click | button | reader | no |
| Paragraph click | click / Enter / Space on a `.para[data-pid]` in the Listen view | reader | no |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Resolved marks | `{ marks: [{ pid, tMs }], timing: 'synced' \| 'estimated' }` over the published paragraphs | `ArticleViewModel.listen`, `PublicListenDto` |
| Reader highlight | the current paragraph carries `.para.is-live` (soft — subtler than the share highlight) | reader Listen view |
| Auto-follow | the live paragraph is scrolled to centre while following; a **Follow audio** button while paused | reader Listen view |
| Stored marks (aligner-facing) | `marks` + `syncFingerprint` + `syncedAt/By` in the Listen draft | database (via `PUT …/listen`) |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Database | read the published payload + revision (reader); write marks (`PUT …/listen`, aligner only) | reader: the Listen view degrades to the player with no highlight (logged at `warn`); PUT: standard error envelope |

## Business Rules
- **Eligible paragraphs** = exactly the paragraphs the reader renders with a pid: the revision's
  `RenderedArticle.paragraphs` in document order (every `p`, `li`, `quote` paragraph with
  non-empty plain text; headings, code, tables, figures, image-only paragraphs and footnotes
  have no pid and are never timed). The list always comes from the server's render of the
  relevant revision, never from the editor textarea.
- **Words** of a paragraph (`countWords`) = the number of whitespace-separated tokens of its
  plain text that contain at least one letter or digit (`/[\p{L}\p{N}]/u`). A paragraph of only
  punctuation/symbols (e.g. `* * *`, `—`) has 0 words.
- **Estimate** (`estimateMarks(paragraphs: {pid, words}[], durationMs) → {pid, tMs}[]`, pure):
  - `D = floor(durationMs)`; if `D ≤ 0`, `durationMs` is not finite, or there are no paragraphs →
    `[]` (no highlight).
  - Each paragraph's weight `w_i = max(0, words_i) + PAUSE_WORDS` (non-finite `words` count as
    0). The pause is a trailing gap after each paragraph (including the last — tail silence).
  - `PAUSE_WORDS = PARAGRAPH_PAUSE_MS × ASSUMED_WPM / 60 000 = 600 × 150 / 60 000 = 1.5`.
    > **Assumed:** a ~0.6 s pause between paragraphs at an assumed 150 words/minute reading
    > pace (1.5 word-equivalents). Both are named constants; tuning them changes no contract.
  - `tMs_i = floor(D × C_i / W)` with `C_i = w_0 + … + w_{i−1}` and `W = Σ w`. So `tMs_0 = 0`; the output has
    one mark per input paragraph, in input order, integer, **non-decreasing**, every
    `tMs < D`. **One paragraph → `[{ pid, tMs: 0 }]`.** A **zero-word paragraph** gets only the
    pause weight (a short slot, never zero width). **Very short audio** (`D` smaller than the
    paragraph count can resolve) may give equal times; the live paragraph is then the last of
    the tied ones (`activeMarkIndex` returns the greatest index with `tMs ≤ t`), so earlier tied
    paragraphs are simply never highlighted — no error.
    > **Assumed:** the first paragraph starts at 0 (no lead-in weight for a read-aloud title/dek).
- **Computed at read time, never stored.** The reader's marks are resolved on every request from
  the **currently published** revision's paragraphs + the published recording's duration, so a
  text edit can never make the live timing "stale" — the next publish simply re-estimates.
- **Stored marks take precedence only when they cover the text** (`resolveMarks(stored,
  paragraphs, durationMs)`): keep the stored marks whose pid is an eligible paragraph, in
  document order; use them (`timing: 'synced'`) **iff** every eligible pid has exactly one such
  mark and the kept set passes `validateMarks(kept, pids, durationMs)` (strictly increasing,
  integer, `< durationMs`). Otherwise — no stored marks, any pid uncovered, or invalid — use
  `estimateMarks` (`timing: 'estimated'`). Stored marks for vanished paragraphs are ignored, never
  an error.
- **Sync storage stays, aligner-facing.** `PUT /api/admin/articles/:id/listen` keeps its
  contract (`spec/api.md` → Listen + media) for the Phase 6 aligner and tests: exactly one mark per
  current paragraph, in document order, strictly increasing integers `< durationMs`, else 422
  `MARKS_INVALID` with every reason. No admin UI calls it in v0.1. Uploading a new recording
  clears stored marks (they belong to the old recording).
- **Reader highlight.** The live paragraph is the one with the greatest `tMs ≤ currentTimeMs`
  (with estimated marks, paragraph 1 is live from 0, also while paused at 0). It updates on
  `timeupdate` and immediately on `seeked`; one `.para.is-live` at a time.
- **Auto-follow.** Following is **on** whenever the Listen view opens. Opening the view
  highlights the live paragraph **without scrolling**. While following, each subsequent
  change of the live paragraph scrolls it to the centre of the viewport (`behavior: 'smooth'`,
  `'auto'` under reduced motion). A **manual scroll** — `wheel`, `touchmove`, or a scroll key
  (PageUp, PageDown, Home, End, ↑, ↓; ignored only when the focus is in a text-entry control —
  `input`, `textarea`, `select`, `contentEditable` — a focused button does **not** suppress it)
  — turns following **off** (programmatic scrolls never count) and shows **Follow audio**.
  **Space never pauses following**: on the window it is play/pause, and on a focused button or
  paragraph it is that element's own activation. Following
  stays off (the highlight keeps moving) until the reader clicks **Follow audio** — which turns
  it on and **immediately** scrolls the current live paragraph to centre — or clicks a
  paragraph. Scrollbar drags are not detected. > **Assumed:** acceptable; wheel/touch/keys cover
  normal reading.
- **Paragraph click** (not on `a`/`button`/figure) or Enter/Space on a focused paragraph →
  `audio.currentTime = tMs / 1000` (play state unchanged) and following turns on. Keyboard on
  the window (ignored when the focus is in a text-entry control or on a button, whose own
  Space/Enter activation wins): Space play/pause, ←/→ ±5 s; Escape closes Listen (or the card overlay).
- The **card overlay** stays player-only: no text, no highlight, no follow.
- Phase 6's aligner writes paragraph marks (and later sentence marks) through the same storage;
  once they cover the text, `resolveMarks` serves them as `synced` with no reader change.

## Success Criteria
- [ ] Unit (`tests/unit/listen/estimate.test.ts`): `countWords('Hello, world — 42 times.')` is 4 and `countWords('* * *')` is 0; `estimateMarks([], 10_000)` is `[]`; `estimateMarks([{pid:'a',words:12}], 10_000)` is `[{pid:'a',tMs:0}]`; `estimateMarks([{a,10},{b,0},{c,20}], 10_000)` is exactly `[0, 3333, 3768]` (weights 11.5, 1.5, 21.5); for durations 0, −5, `NaN`, `Infinity` → `[]`; for 50 paragraphs and `durationMs = 20` every `tMs` is an integer in `[0, 20)`, the sequence is non-decreasing and has length 50; for 1–200 seeded-random paragraphs of 0–300 words with `durationMs = round(W × 400)` (150 wpm) the marks are strictly increasing, `tMs_0 = 0` and the last `tMs < durationMs`. (Computation order is `floor(D × C_i / W)` — multiply first — so the expected values are exact.)
- [ ] Unit: `resolveMarks` returns the stored marks with `timing 'synced'` when they cover every pid (extra marks for unknown pids dropped); returns `estimateMarks(...)` with `timing 'estimated'` when one pid is uncovered, when stored is `[]`, and when the covering set is not strictly increasing; `activeMarkIndex([{tMs:0},{tMs:5},{tMs:5}], 5)` is 2.
- [ ] Integration (`tests/integration/public-listen.test.ts`): publish an article whose Listen has no stored marks → `GET /api/public/articles/:slug/listen` returns `timing 'estimated'` and `marks` equal to `estimateMarks(published paragraphs with countWords, durationMs)` — the computed values, not just the length; edit and publish one paragraph's text → the public marks list the **new** pid and contain no old pid, no publish block; after `PUT …/listen` with a complete valid set and a publish → `timing 'synced'` and `marks` equal to the PUT set; after a further text edit + publish that drops one marked paragraph and adds one → `timing 'estimated'`.
- [ ] Integration (`tests/integration/listen-sync.test.ts`): `PUT` keeps its validation contract — a non-increasing pair → 422 `MARKS_INVALID` with `NOT_INCREASING`; unknown pid → `UNKNOWN_PID`; one paragraph omitted → `MISSING_PID`; `tMs === durationMs` → `OUT_OF_RANGE`; stale `revisionId` → 409 `CONFLICT`; no audio → 409 `LISTEN_NO_AUDIO`; none change the stored draft; a valid PUT returns 200 and does **not** change `status` or `uploadFingerprint`.
- [ ] Unit (`tests/unit/reader/listen-view.test.ts`, fake `<audio>`, fake scroll target): the live pid follows `timeupdate`/`seeked`; while following each change requests a scroll; after a `wheel` (or `touchmove`, or PageDown — also with a `button` focused, but not with an `input`/`textarea`/`select`/`contentEditable` focused) no further change requests a scroll (a window Space keypress never does this) and the follow button is shown; **Follow audio** hides it and requests exactly one scroll to the current live pid at once; a paragraph click seeks to its `tMs` and turns following back on; a programmatic scroll never turns following off.
- [ ] E2E (Chromium, `tests/e2e/listen.spec.ts`): upload `sample.mp3` → the tab chip reads `ready` with no tap controls on the page; publish (no block) → the public Listen view: with the view model's marks, setting `audio.currentTime` to `(marks[k].tMs + 50) / 1000` for k = 0, 2, last makes paragraph k the only `.para.is-live` and its box intersects the viewport; a `mouse.wheel` scroll of 1 200 px makes **Follow audio** visible and a further seek to the last paragraph leaves the scroll position unchanged (±2 px); clicking **Follow audio** hides it and brings the live paragraph's box into the viewport within 2 s; clicking paragraph 1 sets `audio.currentTime` within 0.05 s of `marks[1].tMs / 1000`.
- [ ] The reader E2E creates zero `ai_generation` rows (Listen never calls the LLM).
