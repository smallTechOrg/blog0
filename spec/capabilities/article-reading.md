# Capability: Article reading (Read + TLDR deck)

Phase 1 (Read view, TLDR deck, deep link, mode capsule, chrome, Latest list, labelled stubs).
Listen arrives in `listen-audio` / `listen-sync` (Phase 3); paragraph sharing in
`paragraph-share` (Phase 2).

## What It Does
Serves each published article to readers as a fast server-rendered Read view and a full-viewport
TLDR deck, switchable through the design's mode capsule, with a shareable deck link.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Article address | `/p/<slug>` or `/p/<slug>/tldr` | reader | yes |
| Published revision + published deck | content | database | yes (deck optional) |
| Site record | wordmark, tagline, contact mail, publisher, timezone | database | yes |
| Reader gestures | click/tap, keys, wheel/trackpad, touch swipe | browser | — |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Read view | header (topic, byline, date, title, dek), body, foot with "Next" link | browser |
| TLDR deck | intro slide (title, dek, eyebrow, AI disclosure) + one slide per published line + end actions | browser |
| Page metadata | `<title>` "<Title> — blog0", meta description = dek | browser / crawlers |
| Home Latest list | published articles newest first | browser |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Database | read published article, deck, site | 500 page in site chrome with "Something went wrong — reload" (no stack trace) |

## Business Rules
- Only published articles are visible; drafts, submitted/approved-but-unpublished and unknown
  slugs answer 404 with the site's not-found page.
- Readers always see the **published** revision and deck, never in-progress edits.
- The capsule shows Read, TLDR and Listen with durations: read = words ÷ 230 rounded up (min 1);
  TLDR = the design's deck-minutes formula; Listen = "—" and a labelled "coming in a later phase"
  panel until Phase 3. TLDR is disabled ("No summary yet") when no deck is published.
- Opening the deck changes the address to `/p/<slug>/tldr` without reloading; closing returns to
  `/p/<slug>`; loading the `/tldr` address opens the deck directly.
- Deck behaviour, timings and gestures match the design exactly (`spec/ui.md` §3).
- The intro slide carries the AI disclosure. The end slide offers "Read the full article" and a
  Share button that copies the deck link.
- Reading never calls the AI.
- Dates use the site timezone and the design's format ("8 Sep 2026").
- "Next: <title> →" links to the next newer published article, wrapping to the oldest.
- An article flagged "in progress" shows the "Draft — in progress" badge and the design's foot
  note.

## Success Criteria
- [ ] `/p/<slug>` for a published article returns 200 server-rendered HTML containing the title in an `h1`, the dek, the byline name, the formatted date, and the body text (asserted from the HTTP response before any JS).
- [ ] `/p/<draft-slug>` and `/p/does-not-exist` return 404 with "That article isn’t here."
- [ ] In Chromium: clicking TLDR opens `.tdeck`, the URL becomes `/p/<slug>/tldr`, the first slide shows the title and the disclosure text "Lines selected by Jev (AI)"; ArrowRight shows the first published line verbatim; the progress bar has (lines + 1) segments; End shows "Read the full article" and the Share button; Escape closes the deck and the URL returns to `/p/<slug>`.
- [ ] Direct load of `/p/<slug>/tldr` renders the page with the deck open.
- [ ] Without user input the deck advances from the intro after 3.8 s (design dwell) — asserted with a controlled browser clock in the E2E test.
- [ ] Clicking a progress segment jumps to that slide; Pause stops auto-advance.
- [ ] Listen in the capsule opens a panel whose text includes "Coming in a later phase".
- [ ] The home page lists the published article in "Latest" with its TLDR quick button (when a deck exists) linking to `/p/<slug>/tldr`; Featured/About show labelled stubs.
- [ ] The page's linked stylesheets return 200, are non-empty and contain `.tdeck__track` and `.modedock`.
- [ ] Light/dark toggle switches `data-theme` and the deck/background colours change accordingly.
- [ ] With `prefers-reduced-motion: reduce` the wordmark shows fully without spinning and the deck changes slides without transition.
