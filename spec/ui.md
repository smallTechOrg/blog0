# blog0 — UI

Binding visual reference: `spec/design/design-app.js` + `spec/design/design-app.css` (rendered
in `spec/blog0-design-v0.1_files/saved_resource.html`). **Port, don't redesign.** Deviations are
only those in `spec/architecture.md` → `## Design divergences (ask user)`. Quality bar:
`ui-ux.md` of the harness (four states per view, keyboard reachable, reduced motion honoured).

## 1. Porting rules

1. `src/styles/design.css` is **ported from** `spec/design/design-app.css` with the rules for
   features the user dropped removed: search, reactions, margin notes/threads/notetip/notesheet,
   the preview-only op-ed/toc/tiers/cloud/pullquote blocks, the sentence builder (`sb*`),
   preview pages (`pv*`, xcard, bignum, circ, callout), the old `tldr__*` panel, `tdpoll*`, and
   the rotator. Every rule that styles a class blog0 renders stays **verbatim** (same selector,
   same declarations, same order). The original stays in `spec/design/` for reference. Never
   restyle inside `design.css`; put every new or overriding rule in `src/styles/additions.css`
   (loaded after it) or `src/styles/admin.css`.
   > **Assumed:** (refactor, Oct 2026) dead design rules are pruned instead of shipped unused;
   > rendered output is unchanged because no rendered class loses a rule.
2. Components keep the design's **class names, DOM structure, text, constants and timings**
   (e.g. `TDECK_STEP_MS = 720`, `TDECK_WHEEL = 90`, `TDECK_SWIPE = 56`, `TYPE_RUN_MS = 820`,
   `SPLIT_STAGGER = 55`, `BOOT_LINE_MS = 70`, dwell/type formulas). Translate `h(...)` calls into
   TSX one-for-one; replace `var` hooks with typed hooks; keep comments that explain WHY.
3. The design's `#root` becomes `<div id="blog0-root">` (used by `PrintIn`'s selector root).
4. The root layout injects, before paint, the design's theme script extended with persistence:
   read `localStorage['blog0.theme']` (`'light'|'dark'`); else `prefers-color-scheme`; set
   `data-theme` on `<html>` (`suppressHydrationWarning`). Unless reduced motion is preferred, the
   same script also sets `data-printing` on `<html>` (`additions.css` hides `#blog0-root` while it
   is set) so server HTML never flashes before the print-in; `PrintIn` removes it in its layout
   effect once the lines are staged, and a 2.5 s timeout in the script removes it if hydration
   never arrives.
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

| Design (design-app.js) | Real file | Phase | Notes |
|---|---|---|---|
| `Icon` | `components/design/Icon.tsx` | 1 | same paths; `name` typed union |
| `useEnter`, `prefersReducedMotion`, `typeClock/typeNow/typeStep` | `components/design/motion.ts` | 1 | module-level clock as design |
| `SplitHeadline`, `Dek`, `dekDelay` | `components/design/SplitHeadline.tsx`, `Dek.tsx` | 1 | |
| `Typewriter` | `components/design/Typewriter.tsx` | 1 | |
| `Wordmark` | `components/design/Wordmark.tsx` | 1 | nought spin; `plain` variant |
| `Masthead` | `components/site/Masthead.tsx` | 1 (2 final) | nav Archive + Subscribe; theme toggle; **no search** (div. 4); compact-on-scroll |
| `Footer`, `NewsletterForm`, `useAsciiHand`, `useEof` | `components/site/Footer.tsx`, `NewsletterForm.tsx`, `AsciiHand.ts` | 1 (form stub) / 2 real | |
| `Boot`, `bootCommand` | `components/site/Boot.tsx` | 2 | **rendered** (`SHOW_BOOT_STRIP = true`, div. 6): `> start of blog0` on first paint, then `> cd ~` / `> ls archive` / `> cat about` / `> open <slug>` per client navigation; `--booth: 28px` in `additions.css` |
| `usePrintIn` | `components/site/PrintIn.tsx` (client hook component keyed by pathname) | 1 | selector list verbatim, root `#blog0-root` |
| `PostCard` (+ quick TLDR/Listen) | `components/site/PostCard.tsx` | 1 (nav to `/p/<slug>/tldr`) / 2 (overlay) | variants `post`, `card`, `card-lead` |
| `Home` (About, Featured stack, Latest, See More) | `app/(site)/page.tsx` + `components/site/home/*` | 1 (Latest only + stubs) / 2 | `FEATURED_MAX=4`, `FEED_BATCH=5`, stack observer |
| `AboutBody`, `About` | `components/site/about/*`, `app/(site)/about/page.tsx` | 2 | |
| `Archive` (+ topic pills) | `app/(site)/archive/page.tsx`, `components/site/archive/*` | 2 | topic in `?topic=` |
| `HLProvider` (sentence) | `components/reader/ParagraphShare.tsx` + `ShareMenu.tsx` | 2 | paragraph unit (div. 2, 3) |
| `AnnotationLayer` (drag-to-share) | inside `ParagraphShare.tsx` | 2 | selection inside a `.para` opens the same menu |
| `mdToHtml`, `articleBlocks` | server content pipeline → `components/reader/ArticleBody.tsx` | 1 | blocks → `.prose` html + figures |
| `ArticleProse` | `ArticleBody.tsx` (memoised html block) | 1 | |
| `FigSlide47`, `FigAB`, `FIGURES` | `components/figures/FigSlide47.tsx`, `FigAB.tsx`, `registry.ts` | 1 | data constants verbatim |
| `TldrDeck`, `tldrDwell`, `tldrType`, `tldrMinutes`, `tdeckSlide` | `components/reader/TldrDeck.tsx`, `lib/deck/timing.ts` | 1 | slides from the published deck; layout `column` |
| `ShareLinkButton` | `components/reader/ShareLinkButton.tsx` | 1 (copy) / 2 (opens the full `ShareMenu`, div. 3) | |
| `ArticlePage` (modebar strip, readhead, readbody, capsule, artfoot) | `components/reader/ArticleView.tsx`, `ModeBar.tsx`, `ModeCapsule.tsx`, `ReadHead.tsx`, `ArticleFoot.tsx` | 1 | modes read/tldr/listen |
| `AudioPanel` | `components/reader/ListenStub.tsx` (1–2) → `components/reader/AudioPlayer.tsx` (3) | 1 / 3 | same `.audio` markup bound to a real `<audio>`; `fmtClock` ported to `lib/listen/marks.ts`; divergence 28 |
| `ArticlePage` listen branch (`section.listenview`) | `components/reader/ListenView.tsx` (+ pure `listen-sync.ts`) | 3 (+ fix) | player + text that follows the audio with a soft highlight, **Follow audio** (divergences 28, 29) |
| `SummaryOverlay` (`.sheetfull`, listen mode) | `components/site/SummaryHost.tsx` + `components/site/ListenOverlay.tsx` | 2 (TLDR deck) / 3 (Listen) | compact: tag, title, player, capsule — no text (as the design) |
| `audioMinutes` | `lib/listen/marks.ts` `listenMinutes(durationMs)` | 3 | `max(1, round(ms / 60000))` |
| `parseHash`, `App` hash routing | Next routes + `components/site/LegacyHashRedirect.tsx` | 1 / 2 | div. 1 |
| `fmtDate` | `lib/format-date.ts` | 1 | site timezone |
| `nextArticle` | `server/public/articles.ts` | 1 | div. 24 |
| `titleFor` | `generateMetadata` (`<Title> — blog0`, home = `blog0`, `About — blog0`, `Archive — blog0`) | 1 / 2 (OG) | |
| Retired: margin notes, `AnnotationLayerLegacy`, `Reactions`, `TldrPanel`, `FeaturedRotator`, `SentenceBuilder`, `GoDeeper`, `PullQuote`, `WordCloud`, `Tiers`, `ExpandCard`, `Thumb`, `DeckPoll`, search | not ported | — | div. 5, 21, 22 |

## 3. Public screens

### Chrome (`app/(site)/layout.tsx`) — Phase 1
`<div id="blog0-root">` → `Boot` strip (Phase 2, div. 6: sticky one-line terminal above the
header, `aria-hidden`, types `> start of blog0` on first paint and the route command on every
client navigation) → `Masthead` (wordmark **blog0** types in on the page clock, last char spins
forever unless reduced motion; tagline types after 480 ms; compacts after 56 px scroll with
hysteresis) → page → `Footer` (ASCII canvas, newsletter, topics, contact mail, X/LinkedIn icons
only when the site has URLs, no RSS, "> end of blog0" typed on view, `© <year> blog0 | smallTech`).
`PrintIn` runs on every pathname change. Theme toggle flips `data-theme` and (Phase 2) persists.

### Home `/`
- Phase 1: `.col` with `StubNotice` ("Featured and About arrive in Phase 2") then the **Latest**
  `.home-sec` listing all published articles newest first as `PostCard` (variant `post`), quick
  **TLDR** button only when a published deck exists (navigates to `/p/<slug>/tldr`), **Listen**
  hidden. Empty state: "Nothing published yet." plus, when signed in, a link to the desk.
- Phase 2: exactly the design `Home`: About section (`Typewriter` heading "About Us",
  strap/stand/body typed on the shared clock), **Featured Editorial** pinned head + scroll stack of
  up to 4 `card-lead` cards, **Latest** (non-featured) with **See More** (batches of 5, 280 ms) and
  **View all articles**; "That’s everything in the feed." when exhausted. Card TLDR opens the deck
  overlay (data from `GET /api/public/articles/:slug/tldr`; loading = button disabled with `…`;
  error = the button shows "Couldn’t load" for 2 s).

### Article `/p/<slug>` (+ `/tldr`, Phase 3 `/listen`) — Phase 1
`main.modeframe` → `.artwrap` → `.modebar` (mode label · title · X: Read → back to `/`;
Listen → back to Read) → Read: `.readhead` (tag, in-progress badge "Draft — in progress",
byline `<b>author</b> | date`, `SplitHeadline` h1, `Dek`, rule) → `.readbody` → `ArticleBody`
(html blocks in `.prose` + figure components) → `.artfoot` (in-progress note copy from design when
flagged; Phase 2 Share article button; "Next: <title> →"). `.modedock` capsule at viewport bottom:
Read (`readMinutes`), TLDR (`tldrMinutes` of published deck; **disabled** with title "No summary
yet" when no published deck), Listen ("—", opens `ListenStub` in Phase 1–2).
- **TLDR deck**: opening sets URL `/p/<slug>/tldr` via `history.replaceState`; closing (X, Esc,
  Read) returns to `/p/<slug>`; loading `/p/<slug>/tldr` directly opens it. Slides =
  `[{kind:'intro', text: title, sub: dek}]` + one per published line. Intro slide adds
  `<p class="tdeck__note">` with the disclosure (div. 8). Eyebrow = `topic · date · N min read`.
  End slide: **Read the full article** + `ShareLinkButton` (Phase 1: copies the absolute
  `/p/<slug>/tldr` URL; Phase 2: copies then opens the full `ShareMenu` anchored to the button —
  native sheet on touch/narrow — with the deck share text, §3 *Share*). All gestures/timings
  exactly as design (auto-advance with dwell, pause/play, segment
  click, wheel accumulation + rubber band, touch drag + snap, keys ←/→/↑/↓/PgUp/PgDn/Home/End/Esc,
  body scroll lock + scroll restore, deck starts under the measured header).
- Unknown/unpublished slug → `not-found.tsx` in the site chrome: "That article isn’t here." +
  link home.

### Archive `/archive`, About `/about`
Phase 1: page header + `StubNotice`. Phase 2: design `Archive` (month groups, topic pills, empty
"Nothing filed under that topic yet.") and `About` (`About <wordmark>` h1, stand, strap, body).

### Share — paragraph, article, deck (Phase 2; div. 3)
One component, `components/reader/ShareMenu.tsx`, serves three entry points with one
`ShareSubject = { kind: 'paragraph' | 'selection' | 'article' | 'deck'; text: string; link: string }`
(texts and links per target: `spec/capabilities/paragraph-share.md`):

- **Paragraph** (`ParagraphShare.tsx`): hover on `.para` (pointer devices) → `additions.css`
  shows a 2 px `--accent` rule in the left gutter. Click/tap on a paragraph (ignoring clicks on
  `a`, `button`, figures) or a selection of ≥ 3 chars inside one paragraph → `.para.is-hl`; the
  clipboard text is written immediately; then the menu opens placed like the design's `placeFor`.
  Link = `<publicBase>/p/<slug>#<pid>`; URL updated with `replaceState`. Loading a URL with
  `#p-…` scrolls the paragraph to centre and highlights it (menu closed). Clicking the
  highlighted paragraph again clears it.
- **Article**: the **Share article** `.btn-outline` at the top of `.artfoot` (div. 5) → copies
  the article text + link, opens the menu anchored below the button.
- **Deck**: the end slide's `ShareLinkButton` → copies the deck text + link, opens the menu
  inside the `.tdeck` end slide (menu `z-index` above the deck; closing the menu does not close
  the deck).

Surface selection (same for all three): if `navigator.share` exists AND
(`matchMedia('(pointer: coarse)').matches` OR `innerWidth < 720`) → `navigator.share({ title:
'blog0', text, url })`; on `AbortError` nothing else happens; on any other rejection or when the
API is absent → the `.hlmenu` popover. Desktop always gets the popover:
`role=dialog aria-label="Share this passage|article|summary"`, status line (`aria-live=polite`)
"Copying…" → "Copied, with a link to this passage" (paragraph/selection) / "Copied — title and
link" (article/deck) / "Clipboard unavailable here — share below instead"; `.hlmenu__grid` of
`.hlmenu__opt` anchors in this order: **LinkedIn** (`icon: linkedin`), **X** (`x`), **WhatsApp**
(`chat`), **Notes** (`note`, `mailto:`), **Notion** (`notion`, new tab; the text is already on the
clipboard), **Copy link** (`copy`; a `<button>` — copies the bare link, label flips to "Link
copied" for 1.8 s). External targets open in a new tab (`rel="noopener noreferrer"`). Foot "No
sign-in needed." Close on outside click, Esc, scroll (the paragraph highlight stays). Keyboard:
Tab cycles the options; Enter/Space on a `.para` opens it (design behaviour).

### Listen (Phase 3) — `/p/<slug>/listen`, capsule **Listen**, deck **Listen**

Port of the design's listen branch of `ArticlePage` (design-app.js 3158–3164) plus the text
following the audio (divergence 28) on **estimated** paragraph timing (divergence 29; rules in
`spec/capabilities/listen-sync.md`). The player is the primary control; the text is secondary. Data: `ArticleViewModel.listen` (published only). Entry points: capsule
Listen (enabled only when `times.listen != null`; otherwise `disabled` with
`title="No recording yet"` and `aria-label="Listen — no recording yet"`, mirroring TLDR),
the TLDR deck's mode switcher / end slide Listen (wired via `onListen`; when disabled it uses
the **same copy as `ModeCapsule`**: `title="No recording yet"`, `aria-label="Listen — no
recording yet"`), and loading `/p/<slug>/listen`
directly (`initialMode: 'listen'`; without a published Listen the page renders Read at
`/p/<slug>`). Opening/closing uses `history.replaceState` between `/p/<slug>` and
`/p/<slug>/listen` exactly like the deck; the modebar reads **Listen** and its X returns to Read.

**`ListenView.tsx`** (`section.listenview.listenview--synced`, `aria-label="Listen to this article"`):

- Left column `.listenview__lead` (sticky under the modebar at ≥ 960 px: `top: calc(var(--booth)
  + var(--headh) + 56px)`): `.tag` topic, `h1` title (plain, no `SplitHeadline` — the design's
  listen branch uses a plain `h1`), then **`AudioPlayer`**, then the **Follow audio** button
  `button.btn-outline.listenview__follow` (text label "Follow audio", no icon,
  `aria-controls` = the text column's id) — rendered with the `hidden` attribute while
  following, visible while following is paused. Being in the sticky lead it is always on screen.
- Right column `.listenview__text`: the same `ArticleBody blocks` inside `.readbody` as Read (so
  figures, code and tables render identically); no `ParagraphShare` in this mode — clicks seek.
- < 960 px: one column; `.listenview__lead` is sticky at the top (`top: calc(var(--booth) +
  var(--headh) + 56px)`, `--surface` background, bottom hairline) with the `h1` capped at 2 lines
  (`-webkit-line-clamp: 2`), text below.
- Highlight: the live paragraph gets `.para.is-live` — a **soft** highlight, deliberately
  subtler than the share highlight `.para.is-hl` (CSS tokens `--listen-live-bg` /
  `--listen-live-rule`, §5); one at a time; computed with `activeMarkIndex` over
  `ArticleViewModel.listen.marks` (already resolved server-side: estimated or stored) on
  `timeupdate` and `seeked`.
- **Auto-follow** (state `following`, `true` each time the view opens): while following, a
  change of live paragraph scrolls it to the viewport centre (`scrollIntoView({ block:
  'center', behavior: 'smooth' })`, `'auto'` under reduced motion). **Opening the view**
  highlights the live paragraph **without scrolling** (the first follow scroll happens on the
  next change of live paragraph). A manual scroll — `wheel`, `touchmove`, or a scroll-key
  `keydown` on the window (PageUp/PageDown/Home/End/↑/↓, and Space when the focus is not on a
  button and Space is not consumed as play/pause below) — sets `following = false` and reveals
  **Follow audio**, **unless** focus is in a text-entry control (`input`, `textarea`, `select`,
  or a `contentEditable` element); a focused `BUTTON` does **not** suppress it (e.g. PageDown
  with ▶ focused pauses following). Programmatic scrolls never count.
  > **Assumed:** (refactor, Oct 2026) the follow-pause check uses a text-entry predicate
  > (`input`/`textarea`/`select`/`contentEditable`), not the player-key form-control predicate;
  > window Space keeps its play/pause role, so in practice Space only counts as a scroll where
  > that role does not apply.
  Clicking **Follow audio** sets `following = true`, hides the button, immediately scrolls the
  current live paragraph to centre, and moves focus to `button.audio__play` (so focus is not
  lost on the hidden button). The highlight keeps moving while following is paused.
- Paragraph click (not on `a`/`button`/figure) → `audio.currentTime = tMs / 1000` (play state
  unchanged) and `following = true`; Enter/Space on a focused paragraph does the same.
- Keyboard (window, ignored when the focus is in a form control — `input`/`textarea`/`select`/
  `contentEditable` or a `button`, whose own Space/Enter activation wins): Space play/pause, ← / →
  ±5 s. Reduced motion: no smooth scroll, no transition on the highlight.
- Foot: the Read view's `.artfoot` is not shown in Listen (design: "nothing else on screen"); the
  capsule still floats at the base.

**`AudioPlayer.tsx`** (`div.audio` exactly as the design's `AudioPanel`): `button.audio__play`
(`aria-label` Play/Pause, glyphs `▶` / `⏸`), `div.audio__main` with `input.audio__range`
(`type=range`, `min 0`, `max = durationMs / 1000` (seconds, as the design), `step 0.25`, `aria-label="Seek"`; dragging seeks on
`input`, the thumb follows `timeupdate` otherwise), `div.audio__times` (`fmtClock(pos)` /
`fmtClock(dur)`), and `p.audio__note` reading `Read by <bylineName> · <listen> min`
(replaces the design's placeholder sentence). A hidden `<audio preload="metadata">` with
`src=audio.url` and `type=audio.mimeType`; `onerror` → the note reads "Couldn't load the
recording." and the play button is disabled. Exposes `currentTime`/`seek`/`toggle` through a
ref for `ListenView` and the overlay.

**Card overlay** (`ListenOverlay.tsx`, hosted by `SummaryHost` with `mode: 'listen'`): the
design's `SummaryOverlay` in listen mode — `.sheetfull` (`role=dialog aria-modal`, top measured
from `.sitehead`), `.sheetfull__scrim`, `.sheetfull__panel` with a `.modebar` (**Listen** · title
· X), `section.listenview` with `.tag`, `h1`, `AudioPlayer`, and a `.modedock` capsule: Read →
`router.push('/p/<slug>')`, TLDR → switches the host to the deck (same post), Listen `is-on`.
Data from `GET /api/public/articles/:slug/listen` (loading: the card button shows `…`; error:
"Couldn't load" for 2 s, like TLDR). Esc / X close; body scroll locked while open. No text
column, no highlight, no follow here (compact, as the design). The `PostCard` Listen button appears only when
`times.listen != null` and opens this overlay instead of navigating.

## 4. Admin screens

All admin pages import `src/styles/admin.css` and reuse design tokens/components. Header bar
(`DeskHeader`): small wordmark "blog0 · desk", links Desk (Phase 2 + Site, Subscribers; Phase 4 +
AI usage, Team), user name, **Sign out**.

### Sign in `/admin/login` (S1.1)
Centered `.surface` card: wordmark, "Sign in to the desk", Email, Password (labels, autocomplete),
primary button **Sign in** (disabled + "Signing in…" while pending). Errors inline under the form:
"Email or password is incorrect." / "Too many attempts — try again in N minutes." Success →
`next` param or `/admin`. Already signed in → redirect to `/admin`.

### Desk `/admin` (S1.5)
Title "Desk", primary **New article**. Table (`ArticleTable`): Title (link to editor) · Topic ·
Status pill (Draft / Submitted / Approved / Published, plus "· unpublished changes") · Format
chips (`FormatChips`: Read ✓, TLDR `missing|generating|ready|stale|failed`, Listen
`missing|ready|text changed` (no "later phase" / "arrives in Phase N" state — every format kind
is implemented, so there is no `unavailable` status) with the
same live dot when published — `text changed` uses the warning chip style `.fchip--text_changed`,
never a blocking look; no component change beyond the label map)
· Updated (relative time, by name). Empty: "No articles yet.
Paste your Markdown and see it exactly as readers will." + **New article**. Load error: inline
message + **Retry**.

### New article `/admin/articles/new`
Form: Title (required), Topic (datalist), Dek, Markdown (optional) → **Create** → POST → redirect
to the editor.

### Editor `/admin/articles/[id]` (S1.5)
- **Top bar (`PublishBar`)**: ← Desk · title · save state ("Saved · rev 3" / "Unsaved changes" /
  "Saving…" / "Couldn’t save — Retry") · **Save** (Cmd/Ctrl+S) · **Publish** / **Publish
  changes** (disabled while unsaved; shows blocking reasons in a popover from `PUBLISH_BLOCKED`) ·
  **View live ↗** when published · menu: Unpublish (confirm), Delete draft (confirm, only never
  published). `beforeunload` guard when dirty. A 409 `CONFLICT` shows "Someone saved a newer
  version (rev N by X). Reload to continue." with **Reload**.
- **Tabs**: Write · TLDR · Listen · History. Phases 1–2: Listen = `StubNotice` "Upload a
  word-for-word reading and tap along to sync — Phase 3"; Phase 3: the Listen tab below, with a
  `tabchip` showing the Listen status next to the tab label exactly like TLDR's. History =
  `StubNotice` "Every save is already kept (N revisions). Browsing and restoring arrives in a
  later version." (Phase 3 fix: revision history is deferred, no phase number.)
- **Write tab**: fields Title, Dek, Topic; **Settings** disclosure: Slug (locked note after
  publish), Byline, Featured (toggle + rank), "Show ‘Draft — in progress’ badge". Split view ≥
  1100 px: `MarkdownEditor` (monospace textarea, Tab inserts 2 spaces, word count) left; **Live
  preview** right rendered with the real `ReadHead` + `ArticleBody` inside `.readbody` (same CSS
  as public). < 1100 px: Write/Preview toggle.
  - **Image** (Phase 3, `ImageUploadButton.tsx` in the `MarkdownEditor` toolbar slot
    `.mdedit__tools`, right of the "Markdown" label): a `.admin-btn` **Image** with a hidden
    `<input type=file accept="image/png,image/jpeg,image/webp,image/gif" multiple>`; the
    textarea also accepts dropped files (`.mdedit__area.is-dropping` dashed `--accent` outline
    while a file is over it; non-image drops are ignored with a 2 s notice "Images only — PNG,
    JPEG, WebP or GIF"). Choosing/dropping opens a small `.admin-dialog` (`role=dialog`,
    "Add image"): preview thumbnail, **Alt text** (required field, may be submitted empty →
    shows "Empty alt marks the image decorative" and still proceeds), **Caption** (optional),
    **Insert** / **Cancel**. While uploading: button disabled, label "Uploading… 42%"
    (XHR `upload.onprogress`). Success: the snippet is inserted at the caret (replacing a
    selection), the preview re-renders, focus returns to the textarea with the caret after the
    snippet. Error: inline `.admin-error` under the toolbar with the server message and
    **Try again** (re-sends the same file). Several files queue in order, one dialog each. Preview states: "Updating…" indicator (no flicker:
  keep the last render until the new one arrives), warnings list above it (unknown figure, raw
  HTML dropped, unknown code language), empty body → "Start typing Markdown — the preview appears
  here."
- **TLDR tab (`TldrTab`)**:
  - Header: status chip, bounds hint "Jev will pick 5–7 lines for this length", primary
    **Generate with Jev** (or **Regenerate**; confirm "Replace your current deck with Jev's new
    picks?" when a draft exists). Unsaved changes → button label "Save & generate" (saves then
    generates). Disabled with reason when 0 eligible sentences. Phase 2 (designer mode): when
    `TldrStateDto.jevAvailable` is false the button is disabled and a `.stub`-styled notice reads
    "No OpenRouter key configured — add `BLOG0_OPENROUTER_API_KEY` to `.env` to generate with Jev.
    You can still pick lines yourself from the article on the right."
  - Saving first (unsaved changes): button disabled, label "Saving…" while the editor saves;
    then the Running state.
  - Running: button disabled, spinner "Jev is reading… Ns" (N = elapsed seconds); panel keeps
    prior deck visible but dimmed.
  - Success notice: "Jev picked N lines — saved as your draft deck. Edit them or publish."
    ("1 line" when N = 1).
  - Generation meta line (latest): "Jev · <model> · <promptVersion> · <tokens> tokens · $<cost
    to 4 dp> (or ‘cost n/a’) · <name> · <relative time>".
  - Failure card: "Jev couldn’t make a deck: <message>." **Try again** · "or pick lines yourself
    from the article on the right."
  - Two columns: **Deck** (ordered cards: ordinal `01`, line text, reason in italic "Jev: …" or
    "Added by you", ↑ ↓ ✕ buttons with aria-labels, `missing` lines flagged in accent with
    "No longer in the article") and **Article lines** (eligible sentences grouped under their
    heading path; checkbox per line; checking inserts it at its document-order position among
    deck lines that are still in document order, otherwise appends; unchecking removes).
  - Footer: **Save deck** (dirty indicator), **Preview deck** (opens the real `TldrDeck` over
    the editor with the current draft), **Reset to Jev’s picks** (when a generation exists),
    **Clear deck** (confirm).
  - Empty: "No deck yet. Jev reads the saved article and picks 4–8 lines, word for word. One
    call, usually under a cent."

### Listen tab (Phase 3, `components/admin/editor/ListenTab.tsx` + `components/admin/listen/*`)

**Revised by the Phase 3 fix: no tap-along.** The tab is upload / replace / remove + a preview
player + an estimated-timing note. No design exists (divergence 17); built from the tokens and
the design's `.audio` player. Loads `GET /api/admin/articles/:id/listen` when first shown
(states: "Loading the recording…", inline error + **Retry**, then the panel). Layout: one
column, max-width 720 px.

- **Header**: status chip (`missing` "No recording", `ready` "Ready", `text_changed` "Text
  changed" — warning style, `.tabchip--text_changed`) + one help line per status: missing →
  "Upload a word-for-word reading (mp3 or m4a, up to 50 MB / 30 min). Readers get it on the
  next publish." (limits from `limits`); ready → "Recording ready · uploaded <relative time> by
  <name>. Readers get it on the next publish."; text_changed → the warning below. When
  `published` exists: "Live: <N> min recording, published <date>" plus "· differs from the
  draft" when `published.sameAudioAsDraft` is false.
- **Text-changed warning** (`.admin-alert.is-warn`, status `text_changed`, **non-blocking**):
  "The recording may no longer match the text — paragraphs changed after it was uploaded. If
  the wording changed, upload a new reading. Publishing is not blocked." with one button
  **Upload a new recording** (focuses the uploader).
- **Recording** (`AudioUploader.tsx`): dropzone `.dropzone` (dashed `--border-strong`, "Drop an
  mp3 or m4a here, or **choose a file**", hidden `<input type=file accept="audio/mpeg,audio/mp4,.mp3,.m4a">`),
  limits line. Disabled while the editor has unsaved text, with "Save your text changes first —
  the recording is matched against the saved article." While uploading: progress bar
  (`<progress>` + "Uploading… 37% · 12 MB of 31 MB"), **Cancel** (aborts the XHR). Errors
  inline (`.admin-error`): the server message (415/413/422 texts) + **Try again**. With audio:
  the design `.audio` player (`AudioPlayer`, draft `url`) as the preview, the file line
  "`<originalFilename>` · <bytes as MB> · <fmtClock> · uploaded <relative time> by <name>",
  buttons **Replace…** (no confirm) and **Remove audio** (confirm "Remove the recording? The
  published Listen keeps serving until you publish again.").
- **Timing note** (`p.listentab__timing`, muted, under the player; only with audio):
  `timing 'estimated'` → "Readers see the text follow along with estimated timing — from the
  recording's length and each paragraph's word count. Exact timing comes with automatic
  alignment later."; `timing 'synced'` → "Readers see the text follow along with the paragraph
  timings saved for this recording."
- No paragraph list, no mark controls, no Save sync, no unsaved-marks guard. The `PublishBar`
  has no Listen reason and no **Go to Listen** link (Listen never blocks publishing).
- Keyboard: every control is a `<button>`; no page-level shortcuts in this tab.

### Later admin screens
Site settings (P2: form for tagline, contact email, About strap/stand/body, social URLs with live
preview of the About block), Subscribers (P2: count, table, **Export CSV**), History tab
(**deferred** — stays the labelled stub; `spec/capabilities/revision-history.md`), Stale banner
for TLDR (P4, on hold), AI usage (P4, on hold: month picker, total, table), Team (P4, on hold).

## 5. CSS additions (`src/styles/additions.css`) — only new rules, tokens only

- Font variable wiring (porting rule 5).
- `:root { --booth: 28px }` (boot strip on, div. 6); `.hlmenu` inside `.tdeck` gets `z-index: 47`.
- `.para` hover gutter rule; `.para.is-hl` (same as `.sent.is-hl`: `--accent-soft` fill — the
  share highlight); `.para.is-live` (Listen, **soft**, Phase 3 fix): tokens scoped to the Listen
  view so they resolve per theme — `.listenview { --listen-live-bg: var(--accent-softer);
  --listen-live-rule: var(--accent-soft); }` — and `.para.is-live { background:
  var(--listen-live-bg); box-shadow: -2px 0 0 0 var(--listen-live-rule); border-radius: 2px;
  transition: background .3s ease, box-shadow .3s ease }` (half the share fill's alpha and a
  faint rule instead of the solid `--accent` one; no transition under reduced motion).
  `.listenview__follow { margin-top: 12px }` (`.btn-outline` look; `[hidden]` hides it).
- Phase 3 (S3.5 takes over this file): `.listenview--synced` two-column grid at ≥ 960 px
  (`grid-template-columns: minmax(280px, 360px) minmax(0, 700px); gap: 40px; max-width: 1140px;
  align-items: start; justify-content: center; min-height: auto; display: grid`), `.listenview__lead`
  sticky (`position: sticky; top: calc(var(--booth) + var(--headh) + 56px)`), `.listenview__text .readbody
  { margin: 0 }`; < 960 px: single column, `.listenview__lead` sticky at the same top with
  `background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 0;` and
  `h1 { font-size: clamp(22px, 5vw, 30px); display: -webkit-box; -webkit-line-clamp: 2;
  -webkit-box-orient: vertical; overflow: hidden }`. `.para[data-pid]` in `.listenview--synced`
  gets `cursor: pointer`. `.audio__play:disabled { opacity: .45; cursor: not-allowed }`.
  Everything else of the player/overlay comes from `design.css` unchanged.
- Phase 3 admin (`admin.css`; Phase 3 fix F2 takes over): `.tabchip--text_changed` and
  `.fchip--text_changed` (warning: transparent fill, **dashed** `--accent` border, `--accent-ink`
  text — visibly a caution, not the solid failed/stale look), `.dropzone` (+ `.is-dropping`,
  `[aria-disabled=true]` dimmed), `.listentab__timing` (muted 13.5 px head font),
  `.admin-alert.is-warn`, `.admin-dialog` (image prompt), `.mdedit__tools`,
  `.mdedit__area.is-dropping` — tokens only. Removed with the tap-along: `.tapbtn`, `.marklist*`,
  `.tabchip--needs_sync`, `.fchip--needs_sync` (dropped from their shared selectors; `.tabchip--stale`
  / `.fchip--stale` stay for TLDR), `.listentab__stalewarn`.
- `.prose table` (wrap in `.tablewrap`-like overflow container via `.prose .table-scroll`;
  cells styled like `table.data`), `.prose code` inline (mono 0.9em, `--surface-2` bg, 2 px
  radius), `.prose pre.shiki` (mono 14.5px, 16 px padding, `--border` 1 px, 4 px radius, overflow
  auto) with dual-theme switch: `[data-theme="dark"] .shiki, [data-theme="dark"] .shiki span {
  color: var(--shiki-dark) !important; background-color: var(--shiki-dark-bg) !important; }` and
  light equivalent with `--shiki-light`.
- `.prose .footnotes` (top rule, smaller type 15.5px, label `h2.footnotes-label` styled as
  `.prose h2` and visible — the design's "Notes"), `sup a` accent ink, back-references.
- `.prose del`, task-list checkbox alignment, `.mdfig`/`.mdimg` already exist.
- `.stub` (`StubNotice`): dashed `--border-strong` 1 px, `--surface` bg, 14 px 18 px padding,
  `--font-head` 14.5px `--muted`, leading label "Coming in a later phase" in `--accent-ink` 600.
- `.mode:disabled` (opacity .45, cursor not-allowed) — the design references disabled modes.

## 6. Accessibility & states checklist (every screen)

Empty, loading, error and populated states as written above; all controls are real
`<button>`/`<a>`/`<label>`; focus-visible ring from the design; deck is `role=dialog`
`aria-modal`, slide changes announced (`.sr` live region "Slide n of m"); capsule is a
`role=tablist`; reduced motion disables typing, spins, print-in, deck transitions (design rules).
