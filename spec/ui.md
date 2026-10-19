# blog0 — UI

Binding visual reference: `spec/design/design-app.js` + `spec/design/design-app.css` (rendered
in `spec/blog0-design-v0.1_files/saved_resource.html`). **Port, don't redesign.** Deviations are
only those in `spec/architecture.md` → `## Design divergences (ask user)`. Quality bar:
`ui-ux.md` of the harness (four states per view, keyboard reachable, reduced motion honoured).
Behaviour rules live in the capability files; this file owns screens, markup and CSS.

## 1. Porting rules

1. `src/styles/design.css` is **ported from** `spec/design/design-app.css` with the rules for
   features the user dropped removed: search, reactions, margin notes/threads/notetip/notesheet,
   the preview-only op-ed/toc/tiers/cloud/pullquote blocks, the sentence builder (`sb*`),
   preview pages (`pv*`, xcard, bignum, circ, callout), the old `tldr__*` panel, `tdpoll*`, and
   the rotator. Every rule that styles a class blog0 renders stays **verbatim** (same selector,
   same declarations, same order). The original stays in `spec/design/` for reference. Never
   restyle inside `design.css`; put every new or overriding rule in `src/styles/additions.css`
   (loaded after it) or `src/styles/admin.css`.
2. Components keep the design's **class names, DOM structure, text, constants and timings**
   (e.g. `TDECK_STEP_MS = 720`, `TDECK_WHEEL = 90`, `TDECK_SWIPE = 56`, `TYPE_RUN_MS = 820`,
   `SPLIT_STAGGER = 55`, `BOOT_LINE_MS = 70`, dwell/type formulas). Translate `h(...)` calls into
   TSX one-for-one; replace `var` hooks with typed hooks; keep comments that explain WHY.
3. The design's `#root` becomes `<div id="blog0-root">` (used by `PrintIn`'s selector root).
4. The root layout injects, before paint, the design's theme script extended with persistence:
   read `localStorage['blog0.theme']` (`'light'|'dark'`); else `prefers-color-scheme`; set
   `data-theme` on `<html>` (`suppressHydrationWarning`). **Stage A — intro only once:** the same
   script decides the intro: `intro = location.pathname === '/' && !sessionStorage['blog0.intro']
   && !reducedMotion`; it then sets `sessionStorage['blog0.intro'] = '1'` on **every** first load
   (whatever the path; storage errors → treat as already seen, no intro) and only when `intro` sets
   `data-printing` on `<html>` (`additions.css` hides `#blog0-root` while it is set) so server HTML
   never flashes before the print-in; `PrintIn` removes it in its layout effect once the lines are
   staged, and a 2.5 s timeout in the script removes it if hydration never arrives. Every other
   load and every client navigation (article, archive, about, privacy, newsletter pages, admin, and
   `/` after the first load) renders text at first paint: no `data-printing`, no `.ln` stagger,
   no typing (§3 Chrome). The decision is exposed as `document.documentElement.dataset.intro =
   '1'` for the client components. > **Assumed:** the intro is tied to the visit's first document
   load (a visit that starts on an article never sees it); the owner reviews it in the UI round.
5. Fonts via `next/font/google`: Space Grotesk (400/500/600/700), Source Serif 4 (400/600, italic
   400), JetBrains Mono (400/500), exposed as CSS variables and wired in `additions.css`:
   `:root { --font-head: var(--nf-head), 'Helvetica Neue', Arial, sans-serif; --font-body:
   var(--nf-body), Georgia, 'Times New Roman', serif; --font-mono: var(--nf-mono), ui-monospace,
   Menlo, Consolas, monospace; }`.
6. `prefersReducedMotion()` and all motion hooks live in `src/components/design/motion.ts`;
   everything still renders fully with reduced motion.
7. Brand values (`BRAND`/wordmark, tagline, `BRAND_MAIL`, About texts, publisher) come from the
   `site` record via props, never constants.

## 2. Design → real component map

| Design (design-app.js) | Real file | Notes |
|---|---|---|
| `Icon` | `components/design/Icon.tsx` | same paths; `name` typed union (+ share icons) |
| `useEnter`, `prefersReducedMotion`, `typeClock/typeNow/typeStep` | `components/design/motion.ts` | module-level clock as design |
| `SplitHeadline`, `Dek`, `dekDelay` | `components/design/SplitHeadline.tsx`, `Dek.tsx` | |
| `Typewriter` | `components/design/Typewriter.tsx` | |
| `Wordmark` | `components/design/Wordmark.tsx` | nought spin; `plain` variant |
| `Masthead` | `components/site/Masthead.tsx` | nav Archive + Subscribe; theme toggle; **no search** (div. 4); compact-on-scroll |
| `Footer`, `NewsletterForm`, `useAsciiHand`, `useEof` | `components/site/Footer.tsx`, `NewsletterForm.tsx`, `AsciiHand.ts` | |
| `Boot`, `bootCommand` | `components/site/Boot.tsx` | rendered (div. 6); `--booth: 28px` |
| `usePrintIn` | `components/site/PrintIn.tsx` (client hook component keyed by pathname) | selector list verbatim, root `#blog0-root` |
| `PostCard` (+ quick TLDR/Listen) | `components/site/PostCard.tsx` | variants `post`, `card`, `card-lead`; quick buttons open overlays via `SummaryHost` |
| `Home` (About, Featured stack, Latest, See More) | `app/(site)/page.tsx` + `components/site/home/*` | `FEATURED_MAX=4`, `FEED_BATCH=5`, stack observer |
| `AboutBody`, `About` | `components/site/about/*`, `app/(site)/about/page.tsx` | |
| `Archive` (+ topic pills) | `app/(site)/archive/page.tsx`, `components/site/archive/*` | topic in `?topic=` |
| `HLProvider` (sentence), `AnnotationLayer` | `components/reader/ParagraphShare.tsx` + `ShareMenu.tsx` | paragraph unit (div. 2, 3); a selection inside a `.para` opens the same menu |
| `mdToHtml`, `articleBlocks`, `ArticleProse` | server content pipeline → `components/reader/ArticleBody.tsx` | blocks → `.prose` html + figures |
| `FigSlide47`, `FigAB`, `FIGURES` | `components/figures/FigSlide47.tsx`, `FigAB.tsx`, `registry.ts` | data constants verbatim |
| `TldrDeck`, `tldrDwell`, `tldrType`, `tldrMinutes`, `tdeckSlide` | `components/reader/TldrDeck.tsx`, `lib/deck/timing.ts` | slides from the published deck; layout `column` |
| `ShareLinkButton` | `components/reader/ShareLinkButton.tsx` | copies, then opens `ShareMenu` (div. 3) |
| `ArticlePage` (modebar strip, readhead, readbody, capsule, artfoot) | `components/reader/ArticleView.tsx`, `ModeBar.tsx`, `ModeCapsule.tsx`, `ReadHead.tsx`, `ArticleFoot.tsx` | modes read/tldr/listen |
| `AudioPanel` | `components/reader/AudioPlayer.tsx` | same `.audio` markup bound to a real `<audio>` (div. 28) |
| `ArticlePage` listen branch (`section.listenview`) | `components/reader/ListenView.tsx` (+ pure `listen-sync.ts`) | player + following text (div. 28, 29) |
| `SummaryOverlay` (`.sheetfull`) | `components/site/SummaryHost.tsx` + `components/site/ListenOverlay.tsx` | deck or compact Listen over the list |
| `audioMinutes` | `lib/listen/marks.ts` `listenMinutes(durationMs)` | `max(1, round(ms / 60000))` |
| `parseHash`, `App` hash routing | Next routes + `components/site/LegacyHashRedirect.tsx` | div. 1 |
| `fmtDate` | `lib/format-date.ts` | site timezone |
| `nextArticle` | `server/public/articles.ts` | div. 24 |
| `titleFor` | `generateMetadata` via `articleRoute()` / page metadata (`<Title> — blog0`, home `blog0`, `About — blog0`, `Archive — blog0`) | OG tags |
| Retired: margin notes, `AnnotationLayerLegacy`, `Reactions`, `TldrPanel`, `FeaturedRotator`, `SentenceBuilder`, `GoDeeper`, `PullQuote`, `WordCloud`, `Tiers`, `ExpandCard`, `Thumb`, `DeckPoll`, search | not ported | div. 5, 21, 22 |

## 3. Public screens

### Chrome (`app/(site)/layout.tsx`)
`<div id="blog0-root">` → `Boot` strip (sticky one-line terminal above the header, `aria-hidden`;
lines per div. 6 / `spec/capabilities/reader-site.md`) → `Masthead` (wordmark **blog0** types in
on the page clock, last char spins forever unless reduced motion; tagline types after 480 ms;
compacts after 56 px scroll with hysteresis) → page → `Footer` (ASCII canvas, newsletter, topics,
contact mail, X/LinkedIn icons only when the site has URLs, no RSS, "> end of blog0" typed on
view, `© <year> blog0 | smallTech`). `PrintIn` runs on every pathname change. The theme toggle
flips `data-theme` and persists it.

**Stage A — intro scope.** When `html[data-intro="1"]` (§1 rule 4): the boot strip types `> start
of blog0`, the wordmark and tagline type in, and `PrintIn` staggers the page. Otherwise: the boot
strip shows the current page's command (`> cd ~`, `> ls archive`, `> cat about`, `> open <slug>`)
fully written, the wordmark and tagline render complete, Home's `Typewriter` texts render
complete, and `PrintIn` is a no-op. Unchanged everywhere: the nought spin, the footer `> end of
blog0` typed on view, deck typing (interactive surfaces).

**Stage A — accessible animated text.** Every typed or spun text (`Wordmark`, tagline, `Boot` line,
`Typewriter`) renders `<span class="sr">{full text}</span><span aria-hidden="true">{animated
copy}</span>`; the boot strip drops its outer `aria-hidden` so its sr text is read once; the
`.sr` rule is the design's visually-hidden rule.

**Stage A — head and share metadata** (root layout + `generateMetadata`, `metadataBase =
BLOG0_PUBLIC_BASE_URL`): icons `/favicon.svg` (`image/svg+xml`), `/favicon-32.png` (32×32),
`/favicon.ico` (16+32); on every public page `openGraph.images = [{ url: '/og-default.png', width:
1200, height: 630, alt: '<brand>' }]` and `twitter = { card: 'summary_large_image', title,
description, images: ['/og-default.png'] }` (articles use the default image — no per-article
images). Assets in `public/`: `favicon.svg`, `favicon-32.png`, `favicon.ico`, `og-default.png`
(1200×630 PNG < 60 KB: a plain wordmark card — `--bg` field, **blog0** in Space Grotesk 700 `--ink`,
tagline in `--muted`, a 6 px `--accent` rule; made once with any tool, the binary is committed) and
`logo.png` (512×512 wordmark mark, the JSON-LD publisher logo). **Designer-replaceable:** a
designer may overwrite any of these files keeping the name, format and pixel size; nothing else
changes. **JSON-LD** (`JsonLd.tsx`, escaping and CSP: `spec/architecture.md` §6): home → one
`@graph` with `Organization` (`name` = brand, `url`, `logo` = absolute `/logo.png`, `sameAs` = the
site's X/LinkedIn URLs when set) and `WebSite` (`name`, `url`); article → `Article` (`headline`
title, `description` dek, `datePublished` `first_published_at`, `dateModified`
`content_updated_at ?? first_published_at`, `author` `{ '@type': 'Person', name }`, `publisher`
the same Organization with `logo`, `url` and `mainEntityOfPage` the absolute canonical
`/p/<slug>`, `image` absolute `/og-default.png`). Builders: `src/server/public/seo.ts` (pure).

**Newsletter form (Phase 7, `NewsletterForm.tsx` takes over).** Same markup as the design; the
`.ft-micro` line renders `site.newsletterConsentText` (the consent line the signup records); the
request body adds `sourceUrl: location.pathname + location.search`; success (`.ft-done`,
`role=status`) reads "Almost there — check your inbox and confirm." (div. 15 amended); the invalid
and try-again messages are unchanged. **Stage A:** the success copy follows the response's
`delivery` — `sent` → "Almost there — check your inbox and confirm."; `recorded` → "Signup
recorded — this environment doesn't send email."; `failed` → "We couldn't send your confirmation
email — please try again shortly." (`role=alert`, the form stays usable for a retry). The form adds
a honeypot `<input name="website" tabindex="-1" autocomplete="off">` inside a wrapper with
`aria-hidden="true"` and an off-screen class (never `display:none`), and sends `website` (its
value) and `fillMs = Math.round(performance.now() − mountedAt)` with the body (`spec/api.md`).

### Newsletter link pages `/newsletter/confirm`, `/newsletter/confirmed`, `/newsletter/unsubscribe` (Phase 7)
> **Owner decision (2026-10-19) — confirm on open:** `GET /newsletter/confirm?t=…` is a **route
> handler** (`src/app/(site)/newsletter/confirm/route.ts`, same path so sent links keep working) that
> confirms on open, like Mailchimp/Substack, and 303s to the result page
> `/newsletter/confirmed?status=ok|already|expired|invalid|limited[&m=<minutes>]`
> (`src/app/(site)/newsletter/confirmed/page.tsx`, site chrome, noindex, pure display). Copy: `ok` →
> "You’re confirmed — welcome to <brand>." + the confirmed body below; `already` (a spent token whose
> subscriber is still confirmed — a second click, or the reader after a scanner) → "You’re already
> confirmed." (a success, never an error); `expired` → the 410 copy below (resend path: sign up again
> from the footer; the admin can resend); `invalid` (or a missing/unknown status) → a true 404 via
> this segment's `not-found.tsx` with the 404 copy below; `limited` → the 429 copy. One-line
> trade-off: a link scanner that prefetches the link can confirm; the audit records the IP/UA of the confirming fetch. The **unsubscribe** page is unchanged (button below).

Server components in the site chrome (`src/app/(site)/newsletter/{confirmed,unsubscribe}/page.tsx`,
`dynamic = 'force-dynamic'`, `Cache-Control: no-store`, `robots: noindex` metadata, `<title>` "Subscription — blog0").
The "410" (expired / used) and "429" (rate-limited) outcomes below name the outcome, not the HTTP
status: a page can only answer 200 or a true 404, so both render at 200 (the JSON routes carry
410 / 429 — `spec/api.md`).
> **Assumed (fix pass, scanner-safe — unsubscribe only since 2026-10-19):** a plain GET of the
> unsubscribe page never changes state. For a well-formed, correctly signed token it first renders
> the **prompt** state — h1 "Unsubscribe from <brand>?" with one `.btn` **Yes, unsubscribe me**
> (client component `LinkActionButton.tsx`) that POSTs the token to `/api/newsletter/unsubscribe` and
> then swaps the card to the outcome copy below (success, 404 invalid, 429 rate-limited with the retry
> minutes); while posting the button reads "Working…" and is disabled; a network error shows
> "Something went wrong — try again." with the button re-enabled. The prompt adds "You can sign up
> again any time." The 404 for a malformed/bad-signature token stays a true 404.
One `.surface` card centred in `main`: an eyebrow `.tag` ("Newsletter"), a plain `h1` and one
paragraph, then a `.btn-outline` link **Back to blog0** (`/`). Copy per outcome
(`spec/api.md` → newsletter): confirm `ok` "You’re confirmed — welcome to <brand>." / "Thanks — <brand> issues will
land in this inbox. Unsubscribe any time from the link at the bottom of each one."; 410 "This
link has expired or was already used." / "Sign up again from the footer of any page and we’ll
send a fresh link."; 404 "That link isn’t valid." / "Check the address you were sent, or sign up
again from the footer."; unsubscribe 200 "You’re unsubscribed. Sorry to see you go." / "You
won’t get another issue. Changed your mind? Sign up again from the footer any time."; 429 "Too
many requests." / "Try the link again in N minutes." No typing animation on these pages
(`PrintIn` still runs; reduced motion honoured).

### Home `/`
Exactly the design `Home`: About section (`Typewriter` heading "About Us", strap/stand/body typed
on the shared clock), **Featured Editorial** pinned head + scroll stack of up to 4 `card-lead`
cards, **Latest** (non-featured) with **See More** (batches of 5, 280 ms) and **View all
articles**; "That’s everything in the feed." when exhausted. Empty: `HomeEmpty` ("Nothing
published yet." plus, when signed in, a link to the desk). Card **TLDR** (only with a published
deck) opens the deck overlay (data from `GET /api/public/articles/:slug/tldr`); card **Listen**
(only when `times.listen != null`) opens the Listen overlay. Loading = the button shows `…` and is
disabled; error = the button shows "Couldn’t load" for 2 s.

### Article `/p/<slug>` (+ `/tldr`, `/listen`)
`main.modeframe` → `.artwrap` → `.modebar` (mode label · title · X: Read → back to `/`;
TLDR/Listen → back to Read) → Read: `.readhead` (tag, in-progress badge "Draft — in progress",
byline `<b>author</b> | date`, `SplitHeadline` h1, `Dek`, rule) → `.readbody` → `ArticleBody`
(html blocks in `.prose` + figure components) → `.artfoot` (**Share article** button; in-progress
note copy from the design when flagged; "Next: <title> →"). `.modedock` capsule at viewport
bottom: Read (`readMinutes`), TLDR (`tldrMinutes` of the published deck; **disabled** with title
"No summary yet" without one), Listen (`Listen · N min`; **disabled** with
`title="No recording yet"` / `aria-label="Listen — no recording yet"` without a published
recording — div. 9).
- **TLDR deck**: opening sets URL `/p/<slug>/tldr` via `history.replaceState`; closing (X, Esc,
  Read) returns to `/p/<slug>`; loading `/p/<slug>/tldr` directly opens it. Slides =
  `[{kind:'intro', text: title, sub: dek}]` + one per published line. Intro slide adds
  `<p class="tdeck__note">` with the disclosure (div. 8). Eyebrow = `topic · date · N min read`.
  End slide: **Read the full article** + `ShareLinkButton` (copies, then opens `ShareMenu`
  anchored to the button — native sheet on touch/narrow — with the deck share text). The deck's
  mode switcher offers Listen with the capsule's exact enabled/disabled copy. All gestures/timings
  exactly as the design (auto-advance with dwell, pause/play, segment click, wheel accumulation +
  rubber band, touch drag + snap, keys ←/→/↑/↓/PgUp/PgDn/Home/End/Esc, body scroll lock + scroll
  restore, deck starts under the measured header).
- Unknown/unpublished slug → `not-found.tsx` in the site chrome: "That article isn’t here." +
  link home.

### Privacy `/privacy` (fix pass)
> **Assumed (fix pass):** a static server page in the site chrome (`src/app/(site)/privacy/page.tsx`),
> laid out like About: h1 "Privacy", body = `site.privacyText` paragraphs (blank-line separated,
> rendered as text — no raw HTML), plus a line "Questions or an erasure request: <contact_email>".
> Linked from the newsletter form's consent line ("Privacy" link appended to
> `.ft-micro`, the stored consent text itself is unchanged) and the footer. The seeded text is a
> **draft: the site owner must review the wording — it is not legal advice.**

### Archive `/archive`, About `/about`
Design `Archive` (month groups, topic pills, empty "Nothing filed under that topic yet.") and
`About` (`About <wordmark>` h1, stand, strap, body).

### Share — paragraph, article, deck (div. 3)
One component, `components/reader/ShareMenu.tsx`, serves three entry points with one
`ShareSubject = { kind: 'paragraph' | 'selection' | 'article' | 'deck'; text: string; link: string }`
(texts, links and gesture rules: `spec/capabilities/paragraph-share.md`):

- **Paragraph** (`ParagraphShare.tsx`): hover on `.para` (pointer devices) shows a 2 px
  `--accent` rule in the left gutter; click/tap or a ≥ 3-char selection → `.para.is-hl`, clipboard
  written at once, then the menu opens placed like the design's `placeFor`; URL updated with
  `replaceState`. Loading `#p-…` scrolls the paragraph to centre and highlights it (menu closed).
- **Article**: the **Share article** `.btn-outline` at the top of `.artfoot` (div. 5) → menu
  anchored below the button.
- **Deck**: the end slide's `ShareLinkButton` → menu inside the `.tdeck` end slide (`z-index`
  above the deck; closing the menu does not close the deck).

Surface: native sheet when `navigator.share` exists AND (`(pointer: coarse)` OR `innerWidth <
720`) (`lib/share-surface.ts`); otherwise the `.hlmenu` popover:
`role=dialog aria-label="Share this passage|article|summary"`, status line (`aria-live=polite`)
"Copying…" → "Copied, with a link to this passage" (paragraph/selection) / "Copied — title and
link" (article/deck) / "Clipboard unavailable here — share below instead"; `.hlmenu__grid` of
`.hlmenu__opt` in this order: **LinkedIn** (`icon: linkedin`), **X** (`x`), **WhatsApp**
(`chat`), **Notes** (`note`, `mailto:`), **Notion** (`notion`, new tab), **Copy link** (`copy`; a
`<button>`, label "Link copied" for 1.8 s). External targets open in a new tab
(`rel="noopener noreferrer"`). Foot "No sign-in needed." Keyboard: Tab cycles the options;
Enter/Space on a `.para` opens it.

### Listen — `/p/<slug>/listen`, capsule **Listen**, deck **Listen**

Port of the design's listen branch of `ArticlePage` (design-app.js 3158–3164) plus the following
text (div. 28) on estimated timing (div. 29). **Behaviour (highlight, auto-follow, manual-scroll
pause, Follow audio, click-to-seek, keys): `spec/capabilities/listen-sync.md`.** Data:
`ArticleViewModel.listen` (published only). Entry points: the capsule, the deck's mode switcher /
end slide (`onListen`; same disabled copy as `ModeCapsule`), and loading `/p/<slug>/listen`
(`initialMode: 'listen'`; without a published Listen the page renders Read at `/p/<slug>`).
Opening/closing uses `history.replaceState` between `/p/<slug>` and `/p/<slug>/listen`; the
modebar reads **Listen** and its X returns to Read.

**`ListenView.tsx`** (`section.listenview.listenview--synced`, `aria-label="Listen to this article"`):
- Left column `.listenview__lead`: `.tag` topic, plain `h1` title (no `SplitHeadline`, as the
  design), **`AudioPlayer`**, then `button.btn-outline.listenview__follow` ("Follow audio", no
  icon, `aria-controls` = the text column's id) with the `hidden` attribute while following.
  Sticky under the modebar (`top: calc(var(--booth) + var(--headh) + 56px)`).
- Right column `.listenview__text`: the same `ArticleBody blocks` inside `.readbody` as Read; no
  `ParagraphShare` in this mode (clicks seek).
- < 960 px: one column; the lead stays sticky with `--surface` background and a bottom hairline,
  `h1` capped at 2 lines; text below.
- The live paragraph carries `.para.is-live` (soft, §5). **Follow audio** moves focus to
  `button.audio__play` after it hides itself.
- The Read view's `.artfoot` is not shown in Listen; the capsule still floats at the base.

**`AudioPlayer.tsx`** (`div.audio` exactly as the design's `AudioPanel`): `button.audio__play`
(`aria-label` Play/Pause, glyphs `▶` / `⏸`), `div.audio__main` with `input.audio__range`
(`type=range`, `min 0`, `max = durationMs / 1000`, `step 0.25`, `aria-label="Seek"`; dragging
seeks on `input`, the thumb follows `timeupdate` otherwise), `div.audio__times` (`fmtClock(pos)` /
`fmtClock(dur)`), and `p.audio__note` reading `Read by <bylineName> · <listen> min`. A hidden
`<audio preload="metadata">` with `src=audio.url` and `type=audio.mimeType`; `onerror` → the note
reads "Couldn't load the recording." and the play button is disabled. Exposes
`currentTime`/`seek`/`toggle` through a ref.

**Card overlay** (`ListenOverlay.tsx`, hosted by `SummaryHost` with `mode: 'listen'`): the
design's `SummaryOverlay` in listen mode — `.sheetfull` (`role=dialog aria-modal`, top measured
from `.sitehead`), `.sheetfull__scrim`, `.sheetfull__panel` with a `.modebar` (**Listen** · title
· X), `section.listenview` with `.tag`, `h1`, `AudioPlayer`, and a `.modedock` capsule: Read →
`router.push('/p/<slug>')`, TLDR → switches the host to the deck (same post), Listen `is-on`.
Data from `GET /api/public/articles/:slug/listen`. Esc / X close; body scroll locked while open.
Player only — no text, no highlight, no follow.

## 4. Admin screens

All admin pages import `src/styles/admin.css` and reuse design tokens/components. Header bar
(`DeskHeader`): small wordmark "blog0 · desk", links **Desk**, **Site**, **Subscribers**,
**Newsletter** (Phase 7; Phase 4 would add AI usage, Team), the user's name, **Sign out**.

**Load pattern (every admin screen).** Data is fetched client-side through
`src/components/admin/api.ts` and `useAdminLoad(fetcher, key?, onData?)`
(`src/components/admin/AdminLoad.tsx`): state `loading` → `ready` | `error`, re-fetched when `key`
changes or on `reload()`; a response that lands after unmount or after a newer request is
dropped. Errors render `AdminLoadError` (`role=alert`): "Couldn’t load <what>: <message>" +
**Retry**, or **Sign in again** (to `/admin/login?next=<path>`) when the session ended
(`UNAUTHENTICATED`). Used by the desk, editor, TLDR tab, Listen tab, Site and Subscribers.

### Sign in `/admin/login`
Centered `.surface` card: wordmark, "Sign in to the desk", Email, Password (labels, autocomplete),
primary button **Sign in** (disabled + "Signing in…" while pending). Errors inline under the form:
"Email or password is incorrect." / "Too many attempts — try again in N minutes." (Stage A: from
`Retry-After`; under 60 s it reads "Too many attempts — try again in N seconds." — "1 second" when
N = 1) Success →
`next` param or `/admin`. Already signed in → redirect to `/admin`.

### Desk `/admin`
Title "Desk", primary **New article**. Table (`ArticleTable`): Title (link to editor) · Topic ·
Status pill (Draft / Submitted / Approved / Published, plus "· unpublished changes") · Format
chips (`FormatChips`, labels from `labels.ts`: Read ✓, TLDR `missing|generating|ready|stale|failed`,
Listen `missing|ready|text changed`; a live dot when published; `text changed` uses the warning
chip `.fchip--text_changed`, never a blocking look) · Updated (relative time, by name). Empty: "No
articles yet. Paste your Markdown and see it exactly as readers will." + **New article**. Load
error: `AdminLoadError` + **Retry**.

### New article `/admin/articles/new`
Form: Title (required), Topic (datalist), Dek, Markdown (optional) → **Create** → POST → redirect
to the editor.

### Editor `/admin/articles/[id]`
- **Top bar (`PublishBar`)**: ← Desk · title · save state ("Saved · rev 3" / "Unsaved changes" /
  "Saving…" / "Couldn’t save — Retry") · **Save** (Cmd/Ctrl+S) · **Publish** / **Publish
  changes** (disabled while unsaved; shows blocking reasons in a popover from `PUBLISH_BLOCKED`) ·
  **View live ↗** when published · menu: Unpublish (confirm), Delete draft (confirm, only never
  published). `beforeunload` guard when dirty. A 409 `CONFLICT` shows "Someone saved a newer
  version (rev N by X). Reload to continue." with **Reload**.
- **Tabs**: Write · TLDR · Listen · History, with a `tabchip` showing the TLDR and Listen statuses.
  History = `StubNotice` labelled "Not built yet": "Every save is already kept (N revisions).
  Browsing and restoring arrives in a later version." (revision history deferred, no phase).
- **Write tab**: fields Title, Dek, Topic; **Settings** disclosure: Slug (locked note after
  publish), Byline, Featured (toggle + rank), "Show ‘Draft — in progress’ badge". Split view ≥
  1100 px: `MarkdownEditor` (monospace textarea, Tab inserts 2 spaces, word count) left; **Live
  preview** (`LivePreview`) right rendered with the real `ReadHead` + `ArticleBody` inside
  `.readbody`. < 1100 px: Write/Preview toggle. Preview states: "Updating…" (keep the last render
  until the new one arrives), warnings list above it, empty body → "Start typing Markdown — the
  preview appears here."
  - **Image** (`ImageUploadButton.tsx` in the `.mdedit__tools` slot; behaviour in
    `spec/capabilities/media-images.md`): `.admin-btn` **Image** with a hidden
    `<input type=file accept="image/png,image/jpeg,image/webp,image/gif" multiple>`; the textarea
    accepts dropped files (`.mdedit__area.is-dropping` dashed `--accent` outline; non-image drops
    → 2 s notice "Images only — PNG, JPEG, WebP or GIF"). An `.admin-dialog` (`role=dialog`, "Add
    image"): preview thumbnail, **Alt text** (empty → "Empty alt marks the image decorative" and
    still proceeds), **Caption**, **Insert** / **Cancel**. Uploading: "Uploading… 42%" (XHR
    progress). Error: `.admin-error` under the toolbar with **Try again**.
- **TLDR tab (`TldrTab`)** (Phase 8: relevance ranking replaces reasons):
  - Header: status chip, bounds hint "Jev will pick the top <k> lines for this length"
    (`bounds.target`; "all <k> lines" when k = sentence count), primary **Generate with Jev** (or
    **Regenerate**; confirm "Replace your current deck with Jev's new top lines?" when a draft
    exists). Unsaved changes → "Save & generate". Disabled with reason when 0 eligible sentences.
    When `TldrStateDto.jevAvailable` is false the button is disabled and a `.stub`-styled notice
    reads "No OpenRouter key configured — add `BLOG0_OPENROUTER_API_KEY` to `.env` to generate
    with Jev. You can still pick lines yourself from the article on the right."
  - Saving first: button disabled, "Saving…"; then Running: spinner "Jev is ranking… Ns", prior
    deck visible but dimmed.
  - Stale notice (built): when the TLDR status is `stale`, a text-only `p.tldrtab__stale` (no
    button of its own — the header **Regenerate** is the action) reads "The text changed since
    this deck was saved. Fix flagged lines or regenerate (one AI call) — the live page keeps its
    published deck until you publish."
  - Success notice: "Jev ranked <N> sentences and picked the top <k> — saved as your draft deck.
    Edit them or publish." ("1 sentence" / "top line" for 1).
  - Generation meta line (latest): "Jev · <model> · <promptVersion> · ranked <sentenceCount>
    sentences · <totalTokens> tokens · $<cost to 4 dp> (or ‘cost n/a’) · <name> · <relative
    time>"; when `attempts > 1` "ranked … sentences in <attempts> requests".
  - Failure card: "Jev couldn’t make a deck: <message>." **Try again** · "or pick lines yourself
    from the article on the right."
  - **Relevance label** (one formatter, `relevanceLabel(x)` in `components/admin/labels.ts`):
    `relevance 0.82` — two decimals (`0.00`–`1.00`), monospace `.tldr-rel` span, muted colour;
    nothing is rendered when relevance is null. There are **no reasons anywhere**.
  - Two columns: **Deck** (`DeckList`: ordinal `01`, line text, meta line "Jev · relevance 0.82"
    for Jev lines ("Jev" alone when unscored, e.g. a pre-Phase-8 deck) or "Added by you ·
    relevance 0.41" / "Added by you" for writer lines; ↑ ↓ ✕ buttons with aria-labels; `missing`
    lines flagged "No longer in the article") and **Article lines** (`SentencePicker`).
  - `SentencePicker`: a two-option segmented switch **By relevance** | **In article order**
    (`role=radiogroup`, aria-label "Sort article lines"). Default **By relevance** whenever any
    sentence has a score, else **In article order** (the switch is then disabled with title "No
    scores yet — generate with Jev"). *By relevance*: one flat list sorted by relevance
    descending, ties and unscored sentences in document order (unscored after all scored); each
    row shows its checkbox, the relevance label, the sentence, and its section (last heading or
    "Intro") as a small muted caption. *In article order*: today's grouped list under heading
    paths, each row also showing its relevance label. The choice is local UI state (not
    persisted). Checking inserts at the document-order position among deck lines that are still
    in document order, otherwise appends; unchecking removes (unchanged in both orders).
  - Footer: **Save deck** (dirty indicator), **Preview deck** (`DeckPreview`: the real
    `TldrDeck` over the editor), **Reset to Jev’s picks** (when a succeeded generation exists —
    rebuilds the deck from `latestGeneration.picks`), **Clear deck** (confirm).
  - Empty: "No deck yet. Jev scores every sentence of the saved article for relevance and puts the
    top 4–8 in the deck, word for word. One call, usually well under a cent."
  > **Assumed (S8.2):** the picker's sort choice starts unset and follows the default (By relevance
  > once any score exists, so a first Generate flips the list to relevance order) until the writer
  > picks an option; the article-order group legend for sentences before the first heading reads
  > "Intro" (was "Opening"), matching the By-relevance section caption; the bounds hint uses the
  > singular for k = 1 ("the top line" / "the only line"); the meta line omits "ranked N sentences"
  > when `sentenceCount` is 0 (pre-Phase-8 rows). Reset to Jev's picks takes each pick's own
  > relevance, falling back to the sentence's current score when the pick has none.

### Listen tab (`components/admin/editor/ListenTab.tsx` + `components/admin/listen/*`)

Upload / replace / remove + a preview player + a timing note (behaviour:
`spec/capabilities/listen-audio.md`). No design exists (div. 17); built from the tokens and the
design's `.audio` player. Loads `GET /api/admin/articles/:id/listen` via `useAdminLoad`
("Loading the recording…", `AdminLoadError` + **Retry**). One column, max-width 720 px.

- **Header**: status chip (`missing` "No recording", `ready` "Ready", `text_changed` "Text
  changed" — `.tabchip--text_changed`) + one help line: missing → "Upload a word-for-word reading
  (mp3 or m4a, up to 50 MB / 30 min). Readers get it on the next publish." (limits from
  `limits`); ready → "Recording ready · uploaded <relative time> by <name>. Readers get it on the
  next publish."; text_changed → the warning below. With `published`: "Live: <N> min recording,
  published <date>" plus "· differs from the draft" when `published.sameAudioAsDraft` is false.
- **Text-changed warning** (`.admin-alert.is-warn`, non-blocking): "The recording may no longer
  match the text — paragraphs changed after it was uploaded. If the wording changed, upload a new
  reading. Publishing is not blocked." + **Upload a new recording** (focuses the uploader).
- **Recording** (`AudioUploader.tsx`): `.dropzone` ("Drop an mp3 or m4a here, or **choose a
  file**", hidden `<input type=file accept="audio/mpeg,audio/mp4,.mp3,.m4a">`), limits line.
  Disabled while the editor has unsaved text ("Save your text changes first — the recording is
  matched against the saved article."). Uploading: `<progress>` + "Uploading… 37% · 12 MB of
  31 MB", **Cancel**. Errors inline (`.admin-error`) + **Try again**. With audio: `AudioPlayer`
  (draft `url`), the file line "`<originalFilename>` · <MB> · <fmtClock> · uploaded <relative
  time> by <name>", **Replace…** (no confirm) and **Remove audio** (confirm "Remove the recording?
  The published Listen keeps serving until you publish again.").
- **Timing note** (`p.listentab__timing`, only with audio): `timing 'estimated'` → "Readers see
  the text follow along with estimated timing — from the recording's length and each paragraph's
  word count. Exact timing comes with automatic alignment later."; `'synced'` → "Readers see the
  text follow along with the paragraph timings saved for this recording."
- Every control is a `<button>`; no page-level shortcuts in this tab.

### Site `/admin/site`
Form for tagline, contact email, About strap/stand/body, social URLs with a live preview of the
About block (unchanged). **Phase 7 adds a second card, "Newsletter"** (`NewsletterSettings.tsx`,
own `useAdminLoad` of `GET /api/admin/newsletter/settings`, own **Save** → `PATCH …/settings`;
behaviour: `spec/capabilities/newsletter-issues.md`):
- **Status strip** (read-only, top of the card): "Sender: **Listmonk** · list <name> · healthy" /
  "Sender: **Stub** — issues are recorded, not delivered" (with a `.stub`-styled hint in designer
  mode: "Set `BLOG0_NEWSLETTER_SENDER=listmonk` and the `BLOG0_LISTMONK_*` values to send for
  real"); "Confirmation mail: **SMTP** from <address>" / "**Stub** — confirmation links are written
  to the server log and the subscriber's audit view"; counts "<n> confirmed · <n> pending · <n>
  legacy"; **Sync to Listmonk** button (confirm "Push every confirmed subscriber to Listmonk and
  blocklist the unsubscribed ones?") → "Synced N, blocklisted N, N changed" / inline error.
- **Mode** radio group: **Manual** ("Issues are created only by hand."), **Per post** ("Every first
  publish creates an issue."), **Digest** ("One issue every <days> days or <posts> posts, whichever
  first." with two number inputs 1–60 / 1–20 shown only when selected; a live hint "Next digest:
  due <date> · <n> new posts since <date>" from `status.digest`).
- **Auto-send** checkbox, default off, with the warning label "Send automatic issues without
  review. Off: every issue waits as a draft until you click Send." — turning it on asks "Issues
  will go out to <n> confirmed subscribers with no review. Turn auto-send on?".
- **Consent text** (textarea ≤ 300, shown under the footer form and stored on every signup) and
  **Consent version** (≤ 20; helper "Bumped automatically when the text changes — leave as is").
- **Legacy subscribers** row, only when `counts.legacy_unconfirmed > 0`: "<n> subscribers from
  before double opt-in have not confirmed. They never receive issues until they do." + button
  **Send confirmation to all legacy** (confirm "Send one confirmation email to <n> addresses? Each
  address gets it once.") → "Sent N, skipped N".
- Save state as the site form ("Saved" / "Couldn’t save — Retry"); errors inline.
- > **Assumed (fix pass):** the Site form (first card, `PATCH /api/admin/site`) gains **Privacy
  text** (textarea ≤ 8 000, helper "Shown at /privacy. Review the wording — the default is a draft,
  not legal advice.") and **Newsletter postal address** (textarea ≤ 300, helper "Printed in every
  issue footer and confirmation email. Often required by anti-spam law; leave empty only if you are
  sure.").

### Subscribers `/admin/subscribers` (Phase 7 rewrite of `SubscribersView.tsx`)
Behaviour: `spec/capabilities/newsletter-list.md`. Loads `GET /api/admin/subscribers?status=&q=`
via `useAdminLoad` keyed on the filter + query.
- **Head**: title "Subscribers · <counts.all>", buttons **Export CSV** (`?format=csv` + the active
  filter) and **Export audit (JSON)** (`?format=audit`, always everything; title "Every
  subscriber, event and suppression — the proof of consent").
- **Status filter** (`StatusFilter.tsx`, `role=tablist` of `.pill` buttons): **All** <n> ·
  **Confirmed** <n> · **Pending** <n> · **Legacy** <n> · **Unsubscribed** <n> · **Bounced** <n>;
  the active one `is-on`; filter in `?status=` of the admin URL. A search `<input type=search>`
  "Find by email" (debounced 300 ms → `q`).
- **Table** (`table.data.admin-table`): Email (link to the detail page, mono) · Name · Status
  pill (`.tag` + modifier: `confirmed` solid, `pending` dashed + "expired" suffix when
  `pendingExpired`, `legacy_unconfirmed` → "Legacy", `unsubscribed`, `bounced`) · Signed up
  (relative, title = ISO) · Confirmed (relative or —) · Source (`footer` + the `sourceUrl` path in
  `.admin-faint`, or `legacy`) · Synced (✓ with relative time, or — ; always — under the stub
  sender, which never syncs).
- **Empty**: "No subscribers yet. Signups from the footer form on every public page land here."
  (filtered: "Nothing with that status." / "No address matches.").
- **Legacy banner** above the table when `counts.legacy_unconfirmed > 0`: the same sentence as the
  Site card + a link **Manage in Site → Newsletter**.

### Subscriber `/admin/subscribers/[id]` (Phase 7, `SubscriberDetail.tsx`)
`GET /api/admin/subscribers/:id` → one column, max-width 820 px:
- **Head**: email (mono h1), status pill, name, "Signed up <date> from <sourceUrl>" and, when
  confirmed, "Confirmed <date>".
- **Actions** (`.admin-btn`): **Send confirmation** — shown for `legacy_unconfirmed` (label
  "Send the one-time confirmation", disabled with title "Already sent <date>" once
  `legacyConfirmationSentAt` is set) and for `pending` ("Resend confirmation", disabled with
  "Limit reached — try after <retryAt>" when `canSendConfirmation` is false) → success notice
  "Confirmation sent to <email> (<smtp|stub>)" and the timeline refreshes; **Unsubscribe** (not
  for `unsubscribed`/`bounced`) → `.admin-dialog` "Unsubscribe <email>? This writes a permanent
  suppression entry." with an optional note → `POST …/unsubscribe`.
- > **Owner decision 2026-10-19:** **Delete subscriber and personal data** (`.admin-btn` danger, any
  status) → `.admin-dialog` "Delete <email> and all personal data? This permanently deletes the
  subscriber, its history, suppression entries and stored messages, and the Listmonk copy. Only an
  anonymous marker stays so the address is never emailed again without a fresh sign-up and
  confirmation. This cannot be undone." with an input "Type the address to confirm" and **Delete**
  (disabled until the input equals the address, case-insensitive) → `POST …/erase` → back to
  **Subscribers** with a one-time confirmation "Subscriber and personal data deleted." + the Listmonk
  outcome ("The Listmonk copy was deleted too." / "Listmonk held no copy." / "No Listmonk is
  configured…" / a warning naming why the Listmonk delete failed and whether the tick retries it);
  the person no longer appears in the list, the CSV or the audit export (which lists the erasure,
  PII-free). An error keeps the dialog open and names it (e.g. "The database refused the deletion
  (…). Nothing was deleted…"; "This subscriber was already deleted").
- **Proof of consent** card (definition list): consent text (verbatim, quoted), consent version,
  consented at, signup IP (or "pruned <date>" / "not recorded — no trusted proxy"), signup user
  agent, source page, confirmation IP + user agent + time, token expiry (pending only, with
  "expired" when past), confirmation emails sent (count), provider id + last sync.
- **Timeline** (`SubscriberTimeline.tsx`, `<ol>`): every event oldest first — icon by kind,
  label ("Signed up from /p/…", "Confirmation email sent (smtp)", "Confirmed", "Unsubscribed via
  email link", "Re-subscribed", "Bounced (provider)", "Unsubscribed (provider)", "Synced to
  Listmonk", "Removed from Listmonk", "IP pruned"), source, actor, time; `details` as a `<details>`
  JSON block. The two provider entries appear only with the Listmonk sender — the stub sender skips
  sync, so designer mode and the E2E walk show no sync entry (`spec/architecture.md` §13.3).
- **Suppression entries** card: a small table (reason, source, when, details) with the caption
  "Append-only — these entries are never removed."; "None" when empty.
- **Messages** card: confirmation/issue messages sent to this address (kind, subject, transport,
  status, when); with the stub transport each confirmation row has **Open confirm link** (the
  stub's `confirmUrl` from the message, designer mode's way to confirm by hand).

### Newsletter `/admin/newsletter` (Phase 7, `IssueList.tsx`)
`GET /api/admin/newsletter/issues`. Head: "Newsletter · <total> issues", `.admin-faint`
"<confirmedCount> confirmed subscribers", primary **New issue** (→ `/admin/newsletter/new`), link
**Settings** (→ `/admin/site#newsletter`). Table: # · Title (link) · Status pill (`draft`,
`sending` with a spinner, `sent`, `failed` with the error in a title) · Origin (Per post / Digest
/ Manual) · Posts · Recipients · Created · Sent. Empty: "No issues yet. In **Per post** or
**Digest** mode they appear here when you publish; or write one with **New issue**." Rows of
status `sending` poll every 3 s until they settle.

### New issue `/admin/newsletter/new` (`IssueCompose.tsx`)
Title (required, ≤ 150), Intro (Markdown textarea ≤ 5 000, hint "Paragraphs, emphasis and links
only"), **Posts**: a checklist of published articles (newest first: title · topic · date) with
↑ ↓ to order the checked ones (1–10) → **Create draft** → `POST …/issues` → redirect to the
issue. Validation inline (`ISSUE_POSTS_INVALID` names the offending titles).

### Issue `/admin/newsletter/[id]` (`IssueDetail.tsx`)
`GET …/issues/:id`; one column, max-width 900 px.
- **Head**: "#<number> · <title>", status pill, origin, "Created <relative> by <name>" / "Sent
  <date> by <name> · <recipientCount> recipients". While `draft`: title and intro are editable
  inline (**Save** → PATCH), posts list with ↑ ↓ ✕ and **Add post** (the compose checklist in an
  `.admin-dialog`); otherwise read-only.
- **Actions bar**: **Send test to me** (any status; → "Test sent to <email> (<smtp|stub>)";
  error inline) · **Send** (`draft`/`failed`, or `sending` with `stuckSending`; primary; opens `SendDialog.tsx`: "Send to
  <n> confirmed subscribers?" with the sender line "via Listmonk · list <name>" or "via the stub
  sender — recorded, not delivered", buttons **Send now** / Cancel; > **Assumed (fix pass):** when `newsletterPostalAddress` is empty the dialog (and the issue page, above the actions bar) shows a visible `.admin-warn` line "No postal address is set — issues will go out without one. Add it in Site → Newsletter postal address." with a link to `/admin/site`; **Send now** stays enabled (warn, never block); while sending the button reads
  "Sending…" and the page polls; result "Sent to <n> subscribers" or the failure card "Couldn’t
  send: <lastError>" + **Try again**. When `stuckSending` is true (no progress in `sending` for
  10 min) the page stops polling and shows the failure card "Couldn’t send: the send has been
  stuck in Sending for over 10 minutes (the request was interrupted)" + **Try again**) · **Refresh stats** (sent only) · **Delete draft** (draft
  only, confirm). There is no separate HTML preview page or "open in new tab" route — the preview
  lives only in the panel below.
- **Preview** (`IssuePreview.tsx`): loads the JSON `GET /api/admin/newsletter/issues/:id/preview`
  (`IssuePreviewDto`) and renders it client-side — tabs **HTML** / **Text**. HTML = `<iframe sandbox srcdoc={html} title="Issue preview">`
  (empty `sandbox`: no scripts, no same-origin, so the email HTML can never reach the admin session)
  sized to its content (600 px column, light and dark toggles that set `color-scheme` on the
  iframe); Text = `<pre>` of `text`. Above it: "Preview uses sample values for the unsubscribe
  link and consent line." Loads `GET …/preview` (re-snapshots a draft — the note "Posts refreshed
  from their published versions" appears when something changed).
- **Send log** (`SendLog.tsx`, `<ol>`): events oldest first with time, actor, label (Created ·
  Updated · Test sent to <email> · Send requested (<n> recipients) · Campaign created <id> ·
  Campaign started · Sent · Failed: <error> · Stats fetched).
- **Stats** (`IssueStats.tsx`, sent only): six `.statbox` tiles (Recipients, Sent, Opens, Clicks,
  Bounces, Unsubscribes — "n/a" for null) + "as of <relative time>". **Stage A:** for a `sent`
  issue the page POSTs `…/stats` once on open and then every 60 s while
  `document.visibilityState === 'visible'` (hidden → paused; visible again → refresh at once if
  ≥ 60 s since the last; stopped on unmount; one request in flight at a time); a failed refresh
  keeps the last tiles and shows "Couldn’t refresh stats" muted beside "as of …"; **Refresh stats**
  stays. When `issue.trackingPublic === false` a small muted note under the tiles reads "Opens
  can't be counted: Listmonk's public URL isn't reachable from the internet."
- States: loading "Loading the issue…", `AdminLoadError` + Retry, 404 → "That issue isn’t here."

> **Assumed (S7.4):** the Subscriber **Messages** card has no **Open confirm link** — `SubscriberMessageDto`
> carries no `confirmUrl` (and adding one would put a live token in an admin JSON response);
> designer mode confirms by hand from the `confirm_url` in the server's `newsletter.mail` log line.
> **Assumed (S7.4):** a capped pending row's disabled **Resend confirmation** reads "Limit reached — try
> again later (3 confirmation emails per 24 hours)." (the list/detail DTO has no `retryAt`); the exact
> "Limit reached — try after <date, time>." appears when the server answers `CONFIRMATION_ALREADY_SENT`.
> **Assumed (S7.4):** the search `q` joins `status` in the admin URL; CSV export takes the status filter only.
> **Assumed (S7.4):** no admin-gated HTML preview page route (`/admin/newsletter/[id]/preview`) is
> built — the JSON preview endpoint rendered into the sandboxed `srcdoc` iframe plus the **Text** tab
> covers "preview HTML + text"; an admin wanting the raw email uses **Send test to me**.
> **Assumed (S7.4):** the HTML preview iframe is a fixed 760 px (min 480 px) scrolling frame — an empty
> `sandbox` (no `allow-same-origin`) cannot be measured to fit its content.
> **Assumed (S7.4):** "Posts refreshed from their published versions" shows when a draft's `posts`
> differ before/after `GET …/preview` (the preview DTO has no flag; the issue is re-read once).
> **Assumed (S7.4):** **Send** first reads `GET /api/admin/newsletter/settings` for the dialog's recipient
> count (`status.counts.confirmed`) and sender line; the server re-counts at send time.

### Frozen — not scheduled
TLDR frozen banner with its own **Regenerate** action (the stale chip, the text-only stale notice
and the header Generate/Regenerate button are live), AI usage (month picker, total, table), Team. History tab
browsing/restore is deferred (`spec/capabilities/revision-history.md`).

## 5. CSS additions (`src/styles/additions.css`) — only new rules, tokens only

- Font variable wiring (porting rule 5).
- `:root { --booth: 28px }` (boot strip on, div. 6); `.hlmenu` inside `.tdeck` gets `z-index: 47`;
  `.tdeck { z-index: 46 }` (div. 26).
- `.para` hover gutter rule; `.para.is-hl` (same as `.sent.is-hl`: `--accent-soft` fill — the
  share highlight); `.para.is-live` (Listen, **soft**): tokens scoped to the Listen view —
  `.listenview { --listen-live-bg: var(--accent-softer); --listen-live-rule: var(--accent-soft); }`
  — and `.para.is-live { background: var(--listen-live-bg); box-shadow: -2px 0 0 0
  var(--listen-live-rule); border-radius: 2px; transition: background .3s ease, box-shadow .3s
  ease }` (no transition under reduced motion). `.listenview__follow { margin-top: 12px }`.
- `.listenview--synced` two-column grid at ≥ 960 px (`grid-template-columns: minmax(280px, 360px)
  minmax(0, 700px); gap: 40px; max-width: 1140px; align-items: start; justify-content: center;
  min-height: auto; display: grid`), `.listenview__lead` sticky (`position: sticky; top:
  calc(var(--booth) + var(--headh) + 56px)`), `.listenview__text .readbody { margin: 0 }`;
  < 960 px: single column, `.listenview__lead` sticky at the same top with `background:
  var(--surface); border-bottom: 1px solid var(--border); padding: 12px 0;` and `h1 { font-size:
  clamp(22px, 5vw, 30px); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient:
  vertical; overflow: hidden }`. `.para[data-pid]` in `.listenview--synced` gets `cursor:
  pointer`. `.audio__play:disabled { opacity: .45; cursor: not-allowed }`. Everything else of the
  player/overlay comes from `design.css` unchanged.
- `.prose table` (overflow container `.prose .table-scroll`; cells styled like `table.data`),
  `.prose code` inline (mono 0.9em, `--surface-2` bg, 2 px radius), `.prose pre.shiki` (mono
  14.5px, 16 px padding, `--border` 1 px, 4 px radius, overflow auto) with dual-theme switch:
  `[data-theme="dark"] .shiki, [data-theme="dark"] .shiki span { color: var(--shiki-dark)
  !important; background-color: var(--shiki-dark-bg) !important; }` and the light equivalent.
- `.prose .footnotes` (top rule, 15.5px, label `h2.footnotes-label` styled as `.prose h2` and
  visible — the design's "Notes"), `sup a` accent ink, back-references.
- `.prose del`, task-list checkbox alignment; `.mdfig`/`.mdimg` already exist.
- `.stub` (`StubNotice`): dashed `--border-strong` 1 px, `--surface` bg, 14 px 18 px padding,
  `--font-head` 14.5px `--muted`, leading label "Not built yet" in `--accent-ink` 600 (its only
  user, the History tab, belongs to deferred revision history with no phase, so "later phase"
  would promise a schedule that does not exist).
- `.mode:disabled` (opacity .45, cursor not-allowed) — the design references disabled modes.
- **Stage A:** `--faint` override (design.css stays verbatim) in all three theme blocks —
  `:root`, `:root[data-theme="dark"]`, and `@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) }` — each the same-hue value nearest the design's (`#8C8F95`
  light, `#857F75` dark) whose WCAG contrast is **≥ 4.5:1 against both `--bg` and `--surface`** of
  that theme. `.prose img[width][height] { height: auto; }` (`spec/architecture.md` §4). The
  honeypot wrapper `.ft-hp { position: absolute; left: -10000px; width: 1px; height: 1px;
  overflow: hidden; }`.

`src/styles/admin.css` (tokens only): desk, editor, TLDR panel and sign-in styles;
`.tabchip--text_changed` / `.fchip--text_changed` (transparent fill, **dashed** `--accent` border,
`--accent-ink` text — a caution, not the solid failed/stale look); `.dropzone` (+ `.is-dropping`,
`[aria-disabled=true]` dimmed); `.listentab__timing` (muted 13.5 px head font);
`.admin-alert.is-warn`; `.admin-dialog`; `.mdedit__tools`; `.mdedit__area.is-dropping`.
Phase 7 (tokens only, `admin.css`): `.pill` filter row (+ `.is-on`), status `.tag` modifiers
`.tag--pending` (dashed `--border-strong`), `.tag--confirmed` (`--accent-soft` fill),
`.tag--unsubscribed` / `.tag--bounced` (`--muted` ink), `.tag--legacy` (dotted); `.timeline`
(`<ol>` with a 1 px `--border` rail, 18 px dots); `.statbox` grid (6 → 3 → 2 columns);
`.issue-preview` (`iframe` 100 % width, 1 px `--border`, 4 px radius, `min-height: 480px`);
`.consent-quote` (serif italic, `--surface-2` background, 12 px 16 px padding). The link pages
reuse `.surface`, `.tag`, `.btn-outline` from `design.css` with one rule
`.nl-page { max-width: 560px; margin: 64px auto; }` in `additions.css`.

## 6. Accessibility & states checklist (every screen)

Empty, loading, error and populated states as written above; all controls are real
`<button>`/`<a>`/`<label>`; focus-visible ring from the design; deck is `role=dialog`
`aria-modal`, slide changes announced (`.sr` live region "Slide n of m"); capsule is a
`role=tablist`; reduced motion disables typing, spins, print-in, deck transitions (design rules).
Stage A: animated text is read once from its `.sr` copy (§3 Chrome); `--faint` text meets 4.5:1
in both themes (§5) — proven by a unit test (`tests/unit/site/contrast.test.ts`: parses the three
theme blocks of `design.css` + `additions.css`, computes WCAG contrast of the effective `--faint`
against `--bg` and `--surface`, asserts ≥ 4.5) and an E2E check (computed `color` of a `--faint`
element vs the page background, light and dark).
