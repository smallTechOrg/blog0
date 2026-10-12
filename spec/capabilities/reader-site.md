# Capability: Reader site (home, archive, about, theme, metadata, seed)

Phase 2. Turns Phase 1's labelled stubs into the full design.

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

## Outputs
| Output | Type | Destination |
|---|---|---|
| Home | About section, Featured stack (≤ 4), Latest feed (batches of 5) | browser |
| Archive | month-grouped list, topic pills, counts | browser |
| About page | site About texts | browser |
| Link previews | title, description, canonical URL, `og:*`, `twitter:card=summary` | crawlers |
| Sitemap/robots | published article URLs | crawlers |
| Seeded articles | 5 published posts | database |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Database | read published content and site | error page in site chrome |

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
  Listen only when published audio exists (Phase 3).
- Old design links (`/#<id>`, `/#<id>/tldr`, `/#hl=…`, `/#archive`, `/#about`) land on the
  matching real page.
- Seeding creates the five articles exactly once (by slug) with the design's dates, topics,
  excerpts, author "Sai Krishna V", featured ranks and the in-progress badge on "AI is
  Expensive"; no decks or audio are seeded.
- No reader page triggers an AI call.

## Success Criteria
- [ ] After `pnpm db:seed:posts`, `/` shows "Featured Editorial" with the three seeded featured titles in rank order and "Latest" with the remaining two newest first; a second run reports 0 created.
- [ ] `/archive` shows "5 articles, newest first." and month heading "September 2026"; `/archive?topic=Op-Ed` shows exactly the two Op-Ed posts and the Op-Ed pill pressed.
- [ ] Changing About strap in Admin → Site changes the text on `/` and `/about` on next load.
- [ ] Toggling dark mode then reloading keeps `data-theme="dark"`.
- [ ] `/p/humans-are-software` HTML contains `og:title`, `og:description` (= dek), `og:url` (absolute), `og:type=article`, `twitter:card`.
- [ ] `/sitemap.xml` lists exactly the published article URLs plus `/`, `/archive`, `/about`.
- [ ] Visiting `/#tech-company-first/tldr` ends on `/p/tech-company-first/tldr` with the deck open (when a deck is published).
- [ ] With 7 published non-featured articles, Latest shows 5, See More shows 7 and "That’s everything in the feed."
- [ ] Clicking a card's TLDR opens the deck over the home page without leaving it; Escape returns to the same scroll position.
