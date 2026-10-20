# Capability: Reader site (home, archive, about, theme, metadata, seed)

Phase 2. Boot-strip lines, brand and seeding rules here are the reference the other files cite.

## What It Does
Gives readers the complete public site from the design — home with About, Featured and Latest,
an Archive filterable by topic, an admin-editable About page, persistent light/dark theme, good
link previews — pre-filled with the five smallTech articles.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Published articles | title, dek, topic, dates, featured flag/rank, badge, published deck/audio presence | database | yes |
| Site record | wordmark, tagline, About strap/stand/body, contact mail, social URLs | database (Admin → Site) | yes |
| Topic filter | topic name | `/archive?topic=` | no |
| Theme choice | light/dark | reader toggle | no |
| Seed posts | 5 design articles | `pnpm db:seed:posts` | yes (once) |
| Seed decks | one published TLDR deck per seeded post | `pnpm seed:tldr` (Jev with a real key; committed fixture without) | yes (once) |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Home | About section, Featured stack (≤ 4), Latest feed (batches of 5) | browser |
| Archive | month-grouped list, topic pills, counts | browser |
| About page | site About texts | browser |
| Link previews | title, description, canonical URL, `og:*` with the default image, `twitter:card=summary_large_image` (Stage A) | crawlers |
| Structured data, icons (Stage A) | JSON-LD (`Organization`+`WebSite` on home, `Article` on articles); favicon SVG/PNG/ICO | crawlers, browsers |
| Sitemap/robots | published article URLs | crawlers |
| Seeded articles | 5 published posts | database |
| Seeded decks | 5 published TLDR decks (4–8 verbatim lines each) | database |
| Boot strip | **dropped** (owner, UI review 2026-10-20) — no strip, no footer `> end of blog0` | — |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Database | read published content and site | error page in site chrome |
| OpenRouter (only inside `pnpm seed:tldr`, with a real key, ≈5 calls once) | Jev generation per seeded post | that post is skipped with a warning; the run continues; re-run later |

## Business Rules
- Featured = published articles flagged featured, ordered by rank (then newest), max 4; Latest =
  all other published articles newest first; See More reveals 5 more; "View all articles" goes
  to the Archive.
- Topics shown anywhere are only topics that published articles actually carry, newest first
  (design rule) — never an empty section.
- Archive groups by month of first publication, newest first; header reads "N articles[ in
  Topic], newest first."; pills filter; footer topics open the archive pre-filtered.
- About texts are edited by any admin in Admin → Site and appear on home and `/about`
  immediately.
- Theme follows the OS until the reader toggles; the choice persists across visits.
- Card quick buttons: TLDR only when a published deck exists (opens the deck over the list);
  Listen only when published audio exists (opens the compact player over the list).
- Old design links (`/#<id>`, `/#<id>/tldr`, `/#hl=…`, `/#archive`, `/#about`) land on the
  matching real page.
- The brand everywhere is **blog0** (wordmark with the spinning nought, footer lines,
  titles, copyright); contact mail stays `hello@logzero.blog`; the full design About text is
  seeded; no RSS link or feed.
- **No boot strip and no footer `> end of blog0` line** (owner decision, UI review 2026-10-20).
  **Stage A:** the intro — the wordmark/tagline/About typing, then the page printing in — plays
  only when a visit's first page load is the home page. **Typing on Archive and About (owner,
  2026-10-20):** every arrival at `/`, `/archive` or `/about` (load or client navigation) types the
  wordmark and tagline again on a fresh clock, with no hold (text in the HTML at first paint);
  every other load and navigation shows all text complete at first paint. The typewriter runs at
  about half the design's speed (HOW: `spec/ui.md` §1 rules 2 and 4, §3 Chrome).
- **Stage A:** link previews use the default share card (designer-replaceable file) as a large
  image; animated text is announced once in full to screen readers; small "faint" text meets
  4.5:1 contrast in both themes.
- Seeding creates the five articles exactly once (by slug) with the design's dates, topics,
  excerpts, author "Sai Krishna V", featured ranks and the in-progress badge on "AI is
  Expensive"; no audio is seeded.
- Deck seeding is a separate explicit command (`pnpm seed:tldr`): with a real key it asks Jev
  once per seeded post that has no published deck (≈5 calls, each recorded in the cost ledger)
  and publishes the result; without a real key it publishes the committed fixture decks
  (every line matched by exact text to a sentence of the article; a line that no longer matches is
  dropped with a warning). Re-running makes 0 calls and changes nothing. `--write-fixture`
  refreshes the committed fixture from real Jev output so the repo's decks reflect real output.
- No reader page triggers an AI call; seeding is never triggered by a request.
- Designer mode (`spec/capabilities/designer-mode.md`) serves this same site from the embedded
  database with the same seeds.

## Success Criteria
- [ ] After `pnpm db:seed:posts`, `/` shows "Featured Editorial" with the three seeded featured titles in rank order and "Latest" with the remaining two newest first; a second run reports 0 created.
- [ ] After `pnpm seed:tldr` with a real key: exactly 5 `ai_generation` rows exist (one per slug, status `succeeded`), every seeded article has a published deck of 4–8 lines each byte-identical to a sentence of its article, and a second run prints `decks: 0 seeded (0 calls)` with no new rows.
- [ ] `pnpm seed:tldr` with no real key (integration test runs it with the key blanked in-process): 0 `ai_generation` rows, 5 published decks built from `src/server/seed/decks/*.json`, every line verbatim in its article; a fixture line deliberately mangled in the test is dropped with a logged warning and the deck still publishes.
- [ ] The committed fixture files are valid: a unit test loads each `src/server/seed/decks/<slug>.json`, renders the matching seed post, and asserts every fixture line matches an eligible sentence exactly (a fixture drifting from the article fails the unit gate).
- [ ] `/` HTML contains the wordmark text `blog0` and the whole word `log0` (regex `\blog0\b`) nowhere in the rendered page; the footer renders `© 2026 blog0` and no `> end of blog0`; no `.boot` element anywhere.
- [ ] In Chromium (Stage A): a fresh context opening `/` has `html[data-printing]` at first paint and `data-intro` + `data-typing`, and the wordmark's 5 characters land within 3 s; reloading `/` in the same tab sets `data-typing` (the wordmark and tagline type again) but never `data-printing`; a fresh context opening `/p/humans-are-software`, `/privacy` or `/admin/login` has no `data-printing`/`data-typing` attribute at any point and the headline / wordmark text is visible in the first screenshot; navigating to Home or Archive (or loading `/`, `/archive` or `/about`) sets `data-typing`, never `data-printing` after the first load, and the wordmark and tagline type in again; with scripts off `/archive` shows the complete wordmark.
- [ ] Stage A: the home and article HTML contain the wordmark text once inside `.sr` and the animated copy under `aria-hidden="true"`.
- [ ] Stage A: `/` and `/p/humans-are-software` HTML contain `og:image` = `<base>/og-default.png` with `og:image:width` 1200 / `og:image:height` 630, `twitter:card` = `summary_large_image`, and `<link rel="icon">` for `/favicon.svg` and `/favicon-32.png`; `public/og-default.png` is a 1200×630 PNG under 60 KB (unit test reads the IHDR); `/favicon.ico` → 200.
- [ ] Stage A: `/p/humans-are-software` has one `script[type="application/ld+json"]` carrying the request's CSP nonce whose JSON parses to `@type: Article` with `headline`, `description`, `datePublished`, `dateModified`, `author.@type = Person`, `publisher.logo.url` ending `/logo.png`, absolute `url` and `image`; `/` has `Organization` + `WebSite`. Unit: `serializeJsonLd({ headline: '</script><script>alert(1)</script>' })` contains no `<` and round-trips through `JSON.parse`.
- [ ] `<title>` on `/` is `blog0`, on `/archive` is `Archive — blog0`, on `/about` is `About — blog0`.
- [ ] `/archive` shows "5 articles, newest first." and month heading "September 2026"; `/archive?topic=Op-Ed` shows exactly the two Op-Ed posts and the Op-Ed pill pressed.
- [ ] Changing About strap in Admin → Site changes the text on `/` and `/about` on next load.
- [ ] Toggling dark mode then reloading keeps `data-theme="dark"`.
- [ ] `/p/humans-are-software` HTML contains `og:title`, `og:description` (= dek), `og:url` (absolute), `og:type=article`, `twitter:card` (Stage A value above).
- [ ] `/sitemap.xml` lists exactly the published article URLs plus `/`, `/archive`, `/about`, `/privacy`.
- [ ] Visiting `/#tech-company-first/tldr` ends on `/p/tech-company-first/tldr` with the deck open (when a deck is published).
- [ ] With 7 published non-featured articles, Latest shows 5, See More shows 7 and "That’s everything in the feed."
- [ ] Clicking a card's TLDR opens the deck over the home page without leaving it; Escape returns to the same scroll position.
