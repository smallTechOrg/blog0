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
(`DeskHeader`): small wordmark "blog0 · desk", links **Desk**, **Site**, **Subscribers** (Phase 4
would add AI usage, Team), the user's name, **Sign out**.

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
"Email or password is incorrect." / "Too many attempts — try again in N minutes." Success →
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
- **TLDR tab (`TldrTab`)**:
  - Header: status chip, bounds hint "Jev will pick 5–7 lines for this length", primary
    **Generate with Jev** (or **Regenerate**; confirm "Replace your current deck with Jev's new
    picks?" when a draft exists). Unsaved changes → "Save & generate". Disabled with reason when
    0 eligible sentences. When `TldrStateDto.jevAvailable` is false the button is disabled and a
    `.stub`-styled notice reads "No OpenRouter key configured — add `BLOG0_OPENROUTER_API_KEY` to
    `.env` to generate with Jev. You can still pick lines yourself from the article on the right."
  - Saving first: button disabled, "Saving…"; then Running: spinner "Jev is reading… Ns", prior
    deck visible but dimmed.
  - Success notice: "Jev picked N lines — saved as your draft deck. Edit them or publish."
    ("1 line" when N = 1).
  - Generation meta line (latest): "Jev · <model> · <promptVersion> · <tokens> tokens · $<cost
    to 4 dp> (or ‘cost n/a’) · <name> · <relative time>".
  - Failure card: "Jev couldn’t make a deck: <message>." **Try again** · "or pick lines yourself
    from the article on the right."
  - Two columns: **Deck** (`DeckList`: ordinal `01`, line text, reason in italic "Jev: …" or
    "Added by you", ↑ ↓ ✕ buttons with aria-labels, `missing` lines flagged "No longer in the
    article") and **Article lines** (`SentencePicker`: eligible sentences grouped under their
    heading path; checking inserts at the document-order position among deck lines that are
    still in document order, otherwise appends; unchecking removes).
  - Footer: **Save deck** (dirty indicator), **Preview deck** (`DeckPreview`: the real
    `TldrDeck` over the editor), **Reset to Jev’s picks** (when a generation exists), **Clear
    deck** (confirm).
  - Empty: "No deck yet. Jev reads the saved article and picks 4–8 lines, word for word. One
    call, usually under a cent."

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

### Site `/admin/site`, Subscribers `/admin/subscribers`
Site: form for tagline, contact email, About strap/stand/body, social URLs with a live preview of
the About block. Subscribers: count, table, **Export CSV**.

### Phase 4 screens (on hold)
TLDR stale banner with **Regenerate**, AI usage (month picker, total, table), Team. History tab
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

`src/styles/admin.css` (tokens only): desk, editor, TLDR panel and sign-in styles;
`.tabchip--text_changed` / `.fchip--text_changed` (transparent fill, **dashed** `--accent` border,
`--accent-ink` text — a caution, not the solid failed/stale look); `.dropzone` (+ `.is-dropping`,
`[aria-disabled=true]` dimmed); `.listentab__timing` (muted 13.5 px head font);
`.admin-alert.is-warn`; `.admin-dialog`; `.mdedit__tools`; `.mdedit__area.is-dropping`.

## 6. Accessibility & states checklist (every screen)

Empty, loading, error and populated states as written above; all controls are real
`<button>`/`<a>`/`<label>`; focus-visible ring from the design; deck is `role=dialog`
`aria-modal`, slide changes announced (`.sr` live region "Slide n of m"); capsule is a
`role=tablist`; reduced motion disables typing, spins, print-in, deck transitions (design rules).
