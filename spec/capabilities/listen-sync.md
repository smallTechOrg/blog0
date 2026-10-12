# Capability: Listen — tap-along paragraph sync + reader highlight

Phase 3 (paragraph level). Phase 6 upgrades to automatic sentence-level alignment.

## What It Does
Lets the writer sync the reading to the text by tapping at the start of each paragraph while the
audio plays, so readers see the current paragraph highlighted and scrolled into view.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Taps | one timestamp per paragraph, in order | writer (Space key / big button) during playback | yes |
| Nudges | ±0.25 s per cue | writer | no |
| Playback position | current time | reader's player | yes |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Cues | `{ paragraph id, start seconds }` for every paragraph | Listen draft → published on publish |
| Reader highlight | current paragraph tinted + auto-scrolled | reader Listen view |
| Status | missing / needs_sync / ready / stale | desk chips, editor |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Database | save cues | error inline, taps kept in the page for retry |

## Business Rules
- Syncing walks paragraphs in document order (all text paragraphs, including list items and
  quotes); each tap stamps the next paragraph; Undo removes the last stamp; Restart clears all.
- Cues must cover every paragraph of the current revision, strictly increasing, each before the
  audio's end; the first may be > 0.
- The reader highlight is the last paragraph whose cue ≤ current time; seeking moves it
  immediately; clicking a paragraph seeks to its cue; auto-scroll pauses 4 s after the reader
  scrolls manually.
- If the text's paragraphs change after syncing, Listen becomes **stale**: cues for unchanged
  paragraphs are kept, changed/new ones are listed as missing, publishing a stale Listen is
  blocked (the previously published Listen keeps serving). Never auto-resynced.

## Success Criteria
- [ ] In Chromium, starting sync on the fixture and pressing Space at N moments produces N cues; Save → status `ready`.
- [ ] PUT cues with a non-increasing pair → 422 `CUES_INVALID`; with an unknown pid → 422.
- [ ] Reader Listen view: setting `audio.currentTime` to just after cue k makes paragraph k `.is-live` and in the viewport.
- [ ] Editing one paragraph's text → status `stale`, `missingPids` contains exactly its new id; publish → 422 `LISTEN_STALE`; the public Listen still uses the previous cues.
